'use strict';
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../config');
const settings = require('../store/settings');
const { AppError } = require('../errors');
const log = require('../logger').createLogger('ffmpeg');

const EXE = process.platform === 'win32' ? '.exe' : '';

function bin(name) {
  const s = settings.get();
  const configured = name === 'ffmpeg' ? s.ffmpegPath : s.ffprobePath;
  if (configured) return configured;
  if (name === 'ffprobe' && s.ffmpegPath) {
    const sibling = path.join(path.dirname(s.ffmpegPath), `ffprobe${EXE}`);
    if (fs.existsSync(sibling)) return sibling;
  }
  // setup.ps1 may drop a portable FFmpeg build into tools/ffmpeg/bin
  const local = path.join(ROOT, 'tools', 'ffmpeg', 'bin', `${name}${EXE}`);
  if (fs.existsSync(local)) return local;
  return name;
}

function execText(file, args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

let detected = null;
let detectedAt = 0;

/** Detects FFmpeg, its filters and which H.264 hardware encoder actually works on this machine. */
async function detect(force = false) {
  if (!force && detected && Date.now() - detectedAt < 10 * 60 * 1000) return detected;
  const ffmpeg = bin('ffmpeg');
  const info = { available: false, path: ffmpeg, version: null, hwEncoder: null, encoders: {}, filters: {}, error: null };
  try {
    const { stdout } = await execText(ffmpeg, ['-hide_banner', '-version']);
    info.version = (stdout.split('\n')[0] || '').replace(/^ffmpeg version\s*/, '').split(' ')[0];
    info.available = true;
    const enc = await execText(ffmpeg, ['-hide_banner', '-encoders']);
    for (const name of ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox', 'aac']) {
      info.encoders[name] = new RegExp(`\\s${name}\\s`).test(enc.stdout);
    }
    const flt = await execText(ffmpeg, ['-hide_banner', '-filters']);
    for (const name of ['subtitles', 'xfade', 'drawtext', 'tpad', 'boxblur', 'amix']) {
      info.filters[name] = new RegExp(`\\s${name}\\s`).test(flt.stdout);
    }
    // A listed hardware encoder is not necessarily usable (no GPU / driver) — try a tiny encode.
    for (const name of ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox']) {
      if (!info.encoders[name]) continue;
      try {
        await execText(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2',
          '-c:v', name, '-pix_fmt', 'yuv420p', '-f', 'null', '-'], 15000);
        info.hwEncoder = name;
        break;
      } catch {
        /* not usable on this machine */
      }
    }
    try {
      await execText(bin('ffprobe'), ['-hide_banner', '-version']);
      info.ffprobe = true;
    } catch {
      info.ffprobe = false;
      info.error = 'ffprobe not found next to ffmpeg';
    }
  } catch (err) {
    info.error = err.code === 'ENOENT' ? 'FFmpeg not found on PATH' : (err.stderr || err.message);
  }
  detected = info;
  detectedAt = Date.now();
  log.info(`FFmpeg ${info.available ? info.version : 'MISSING'}; hardware encoder: ${info.hwEncoder || 'none (libx264)'}`);
  return info;
}

async function requireFfmpeg() {
  const info = await detect();
  if (!info.available) throw new AppError('FFMPEG_MISSING', null, { details: info.error });
  return info;
}

/** H.264 encoder arguments — hardware encoder when available, otherwise libx264. */
function encoderArgs({ fast = false } = {}) {
  const hw = settings.get().hardwareEncoder !== 'off' && detected ? detected.hwEncoder : null;
  let args;
  switch (hw) {
    case 'h264_nvenc':
      args = ['-c:v', 'h264_nvenc', '-preset', fast ? 'p3' : 'p5', '-rc', 'vbr', '-cq', '19', '-b:v', '0'];
      break;
    case 'h264_qsv':
      args = ['-c:v', 'h264_qsv', '-global_quality', '20'];
      break;
    case 'h264_amf':
      args = ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', '19', '-qp_p', '21'];
      break;
    case 'h264_videotoolbox':
      args = ['-c:v', 'h264_videotoolbox', '-q:v', '65'];
      break;
    default:
      args = ['-c:v', 'libx264', '-preset', fast ? 'superfast' : 'veryfast', '-crf', '18'];
  }
  return [...args, '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
}

function parseTime(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n / 1e6 : null; // out_time_us / out_time_ms are both microseconds
}

/**
 * Runs ffmpeg with machine-readable progress. Resolves with the stderr tail; rejects with a
 * classified AppError carrying the command and FFmpeg's own error output.
 */
function run(args, { signal, durationSec, onProgress, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const ffmpeg = bin('ffmpeg');
    const fullArgs = ['-hide_banner', '-y', '-nostdin', '-progress', 'pipe:1', '-nostats', ...args];
    log.debug(`$ ffmpeg ${fullArgs.join(' ')}`);
    let child;
    try {
      child = spawn(ffmpeg, fullArgs, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(new AppError('FFMPEG_MISSING', null, { details: err.message }));
    }
    const stderrLines = [];
    let stdoutBuf = '';
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const [key, value] = line.split('=');
        if ((key === 'out_time_us' || key === 'out_time_ms') && onProgress && durationSec > 0) {
          const t = parseTime(value);
          if (t !== null && t >= 0) onProgress(Math.min(1, t / durationSec), t);
        }
      }
    });
    child.stderr.on('data', chunk => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        stderrLines.push(line);
        if (stderrLines.length > 80) stderrLines.shift();
      }
    });
    child.on('error', err => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err.code === 'ENOENT'
        ? new AppError('FFMPEG_MISSING', null, { details: `${ffmpeg}: ${err.message}` })
        : new AppError('FFMPEG_ERROR', err.message, { details: err.stack }));
    });
    child.on('close', code => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (aborted) {
        const e = new Error('Aborted');
        e.name = 'AbortError';
        return reject(e);
      }
      const tail = stderrLines.join('\n');
      if (code === 0) return resolve({ stderr: tail });
      const lastError = [...stderrLines].reverse().find(l => /error|invalid|no such|not found|unable|failed/i.test(l));
      reject(new AppError('FFMPEG_ERROR', `FFmpeg failed: ${lastError || `exit code ${code}`}`, {
        details: `$ ffmpeg ${fullArgs.join(' ')}\n\n${tail}`,
      }));
    });
  });
}

async function probe(file) {
  let result;
  try {
    result = await execText(bin('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  } catch (err) {
    if (err.code === 'ENOENT') throw new AppError('FFMPEG_MISSING', 'ffprobe was not found', { details: err.message });
    throw new AppError('FFMPEG_ERROR', `Could not read media file ${path.basename(file)}`, { details: err.stderr || err.message });
  }
  const data = JSON.parse(result.stdout || '{}');
  const v = (data.streams || []).find(s => s.codec_type === 'video');
  const a = (data.streams || []).find(s => s.codec_type === 'audio');
  const [num, den] = String((v && (v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate)) || '0/1').split('/').map(Number);
  const durationSec = Number((data.format && data.format.duration) || (v && v.duration) || (a && a.duration) || 0);
  return {
    durationSec,
    width: v ? v.width : null,
    height: v ? v.height : null,
    fps: den ? Math.round((num / den) * 1000) / 1000 : null,
    frames: v && v.nb_frames ? Number(v.nb_frames) : null,
    videoCodec: v ? v.codec_name : null,
    pixFmt: v ? v.pix_fmt : null,
    hasVideo: Boolean(v),
    hasAudio: Boolean(a),
    sizeBytes: data.format ? Number(data.format.size) : null,
  };
}

/** Video filter that fits any input into exactly width×height. mode: crop | pad | blur */
function fitFilter(width, height, mode = 'crop', inLabel = null, outLabel = null) {
  const W = even(width);
  const H = even(height);
  if (mode === 'blur') {
    const i = inLabel ? `[${inLabel}]` : '';
    const o = outLabel ? `[${outLabel}]` : '';
    const id = Math.random().toString(36).slice(2, 7);
    return `${i}split=2[bg${id}][fg${id}];` +
      `[bg${id}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2[bgb${id}];` +
      `[fg${id}]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos[fgs${id}];` +
      `[bgb${id}][fgs${id}]overlay=(W-w)/2:(H-h)/2,setsar=1${o}`;
  }
  const chain = mode === 'pad'
    ? `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`
    : `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1`;
  return `${inLabel ? `[${inLabel}]` : ''}${chain}${outLabel ? `[${outLabel}]` : ''}`;
}

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Target output size for an aspect ratio: generated size, optionally upscaled to 720p-class. */
function outputSize(aspectRatio, genWidth, genHeight, upscale) {
  const [aw, ah] = String(aspectRatio || '16:9').split(':').map(Number);
  const ratio = aw && ah ? aw / ah : genWidth / genHeight;
  if (upscale) {
    const short = 720;
    return ratio >= 1 ? { width: even(short * ratio), height: short } : { width: short, height: even(short / ratio) };
  }
  // Largest exact-ratio box inside the generated frame (crop only, no upscale).
  let width = genWidth;
  let height = Math.round(width / ratio);
  if (height > genHeight) {
    height = genHeight;
    width = Math.round(height * ratio);
  }
  return { width: even(width), height: even(height) };
}

async function extractFrame(input, output, position = 'last') {
  let args;
  if (position === 'last') args = ['-sseof', '-0.5', '-i', input, '-update', '1', '-q:v', '1', output];
  else if (position === 'first') args = ['-i', input, '-frames:v', '1', '-q:v', '1', output];
  else args = ['-ss', String(position), '-i', input, '-frames:v', '1', '-q:v', '1', output];
  await run(args);
  if (!fs.existsSync(output)) throw new AppError('FFMPEG_ERROR', 'Frame extraction produced no image', { details: input });
  return output;
}

async function thumbnail(input, output, durationSec) {
  const at = durationSec ? Math.min(1, durationSec / 3) : 0;
  await run(['-ss', at.toFixed(2), '-i', input, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', output]);
  return output;
}

/** Re-encodes a generated clip to the exact output size/fps as an H.264 MP4 (faststart). */
async function normalize(input, output, { width, height, fps, signal, onProgress, dropFirstFrame = false, durationSec }) {
  await requireFfmpeg();
  const filters = [];
  if (dropFirstFrame) filters.push('trim=start_frame=1', 'setpts=PTS-STARTPTS');
  if (fps) filters.push(`fps=${fps}`);
  filters.push(fitFilter(width, height, 'crop'), 'format=yuv420p');
  const duration = durationSec || (await probe(input)).durationSec;
  await run(['-i', input, '-vf', filters.join(','), ...encoderArgs(), '-an', output], { signal, durationSec: duration, onProgress });
  return output;
}

/** Encodes a numbered PNG sequence (f_000001.png …) into an MP4. */
async function encodeSequence(dir, pattern, output, { fps, width, height, signal, onProgress, frameCount }) {
  await requireFfmpeg();
  const vf = `${fitFilter(width, height, 'crop')},format=yuv420p`;
  await run(['-framerate', String(fps), '-i', path.join(dir, pattern), '-vf', vf, ...encoderArgs(), '-an', output],
    { signal, durationSec: frameCount / fps, onProgress });
  return output;
}

/**
 * Final encode of generated segments in a single FFmpeg pass: joins segments (later segments drop
 * their first frame, which repeats the previous segment's last frame), crops to the exact aspect
 * ratio, optionally upscales (lanczos) and encodes H.264 with the fastest available encoder.
 */
async function finalizeSegments(inputs, output, { width, height, fps, signal, onProgress, totalDuration }) {
  await requireFfmpeg();
  const parts = inputs.map((_, i) => `[${i}:v]${i > 0 ? 'trim=start_frame=1,' : ''}setpts=PTS-STARTPTS,fps=${fps}[s${i}]`);
  const join = inputs.length > 1
    ? `${inputs.map((_, i) => `[s${i}]`).join('')}concat=n=${inputs.length}:v=1:a=0[j]`
    : '[s0]null[j]';
  const graph = `${parts.join(';')};${join};${fitFilter(width, height, 'crop', 'j', 'f')};[f]format=yuv420p[v]`;
  await run([...inputs.flatMap(f => ['-i', f]), '-filter_complex', graph, '-map', '[v]', ...encoderArgs(), '-an', output],
    { signal, durationSec: totalDuration, onProgress });
  return output;
}

module.exports = {
  bin, detect, requireFfmpeg, encoderArgs, run, probe, fitFilter, outputSize, even,
  extractFrame, thumbnail, normalize, encodeSequence, finalizeSegments,
};
