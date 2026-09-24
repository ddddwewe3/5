'use strict';
const fs = require('fs');
const path = require('path');
const ffmpeg = require('./ffmpeg');
const { buildCues, toAss, toSrt } = require('./subtitles');
const tts = require('../tts');
const { AppError } = require('../errors');
const { clamp } = require('../util');

const TRANSITIONS = ['none', 'fade', 'fadeblack', 'fadewhite', 'dissolve', 'wipeleft', 'slideleft', 'smoothleft', 'circleopen', 'radial', 'pixelize'];
const FIT_MODES = ['crop', 'pad', 'blur'];
const ASPECTS = ['16:9', '9:16', '1:1', 'original'];
const VOICE_LEAD_IN = 0.3;

function sizeFor(aspectRatio, resolution, first) {
  const short = resolution === 1080 ? 1080 : resolution === 480 ? 480 : 720;
  switch (aspectRatio) {
    case '16:9': return { width: ffmpeg.even(short * 16 / 9), height: short };
    case '9:16': return { width: short, height: ffmpeg.even(short * 16 / 9) };
    case '1:1': return { width: short, height: short };
    default: return { width: ffmpeg.even(first.width), height: ffmpeg.even(first.height) };
  }
}

/** Validates and normalises a render spec coming from the browser. */
function normalizeSpec(spec) {
  const s = spec || {};
  const out = {
    aspectRatio: ASPECTS.includes(s.aspectRatio) ? s.aspectRatio : '16:9',
    fit: FIT_MODES.includes(s.fit) ? s.fit : 'crop',
    resolution: [480, 720, 1080].includes(Number(s.resolution)) ? Number(s.resolution) : 720,
    fps: [16, 24, 25, 30].includes(Number(s.fps)) ? Number(s.fps) : 24,
    speed: clamp(Number(s.speed) || 1, 0.25, 4),
    fadeInOut: s.fadeInOut !== false,
    transition: {
      type: TRANSITIONS.includes(s.transition && s.transition.type) ? s.transition.type : 'fade',
      duration: clamp(Number(s.transition && s.transition.duration) || 0.5, 0.1, 2),
    },
    clips: [],
    music: null,
    voice: null,
    subtitles: { enabled: Boolean(s.subtitles && s.subtitles.enabled), text: '', position: 'bottom' },
  };
  for (const c of Array.isArray(s.clips) ? s.clips : []) {
    if (!c || typeof c.takeId !== 'string') continue;
    out.clips.push({
      takeId: c.takeId,
      trimStart: Math.max(0, Number(c.trimStart) || 0),
      trimEnd: c.trimEnd == null || c.trimEnd === '' ? null : Math.max(0, Number(c.trimEnd)),
      speed: clamp(Number(c.speed) || 1, 0.25, 4),
    });
  }
  if (s.music && s.music.uploadId) {
    out.music = { uploadId: String(s.music.uploadId), volume: clamp(Number(s.music.volume ?? 0.35), 0, 2) };
  }
  if (s.voice && (s.voice.text || s.voice.uploadId)) {
    out.voice = {
      text: String(s.voice.text || '').slice(0, 5000),
      uploadId: s.voice.uploadId ? String(s.voice.uploadId) : null,
      engine: s.voice.engine ? String(s.voice.engine) : undefined,
      voice: s.voice.voice ? String(s.voice.voice) : undefined,
      rate: clamp(Number(s.voice.rate) || 1, 0.5, 2),
      volume: clamp(Number(s.voice.volume ?? 1), 0, 2),
      fitVideo: s.voice.fitVideo !== false,
    };
  }
  if (out.subtitles.enabled) {
    out.subtitles.text = String((s.subtitles && s.subtitles.text) || (out.voice && out.voice.text) || '').slice(0, 5000);
    out.subtitles.position = ['bottom', 'middle', 'top'].includes(s.subtitles.position) ? s.subtitles.position : 'bottom';
    if (!out.subtitles.text.trim()) out.subtitles.enabled = false;
  }
  return out;
}

/**
 * Renders the final video. `resolveMedia(kind, id)` maps take/upload ids to absolute file paths.
 * `update({stage, progress, message})` reports real progress (FFmpeg -progress output).
 */
async function render({ spec, outDir, resolveMedia, signal, update }) {
  const ff = await ffmpeg.requireFfmpeg();
  if (!spec.clips.length) throw new AppError('INVALID_INPUT', 'There are no finished scenes to render yet.');
  fs.mkdirSync(outDir, { recursive: true });

  update({ stage: 'processing', progress: 0.02, message: 'Analysing scenes' });
  const clips = [];
  for (const c of spec.clips) {
    const file = resolveMedia('take', c.takeId);
    if (!file || !fs.existsSync(file)) throw new AppError('INVALID_INPUT', `Scene video ${c.takeId} is missing`);
    const info = await ffmpeg.probe(file);
    const start = clamp(c.trimStart, 0, Math.max(0, info.durationSec - 0.2));
    const end = c.trimEnd == null ? info.durationSec : clamp(c.trimEnd, start + 0.2, info.durationSec);
    const speed = c.speed * spec.speed;
    clips.push({ file, info, start, end, speed, duration: (end - start) / speed });
  }
  const { width: W, height: H } = sizeFor(spec.aspectRatio, spec.resolution, clips[0].info);
  const F = spec.fps;

  // ── Voice-over ──
  let voice = null;
  if (spec.voice) {
    update({ stage: 'processing', progress: 0.08, message: 'Generating voice-over' });
    if (spec.voice.uploadId) {
      const file = resolveMedia('upload', spec.voice.uploadId);
      if (!file) throw new AppError('INVALID_INPUT', 'Uploaded voice file not found');
      voice = { path: file, durationSec: (await ffmpeg.probe(file)).durationSec };
    } else {
      voice = await tts.synthesize({
        text: spec.voice.text, output: path.join(outDir, 'voice.wav'),
        engine: spec.voice.engine, voice: spec.voice.voice, rate: spec.voice.rate,
      });
    }
  }
  let music = null;
  if (spec.music) {
    const file = resolveMedia('upload', spec.music.uploadId);
    if (!file) throw new AppError('INVALID_INPUT', 'Uploaded music file not found');
    music = { path: file };
  }

  // ── Video graph ──
  const t = spec.transition;
  const useXfade = t.type !== 'none' && clips.length > 1 && ff.filters.xfade !== false;
  const xd = useXfade ? Math.min(t.duration, ...clips.map(c => c.duration / 2.2)) : 0;
  const graph = [];
  clips.forEach((c, i) => {
    graph.push(`[${i}:v]trim=start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)},setpts=PTS-STARTPTS` +
      `${c.speed !== 1 ? `,setpts=PTS/${c.speed.toFixed(4)}` : ''},fps=${F}[pre${i}]`);
    graph.push(`${ffmpeg.fitFilter(W, H, spec.fit, `pre${i}`, `fit${i}`)}`);
    graph.push(`[fit${i}]format=yuv420p,settb=AVTB[v${i}]`);
  });
  let last = 'v0';
  let videoDuration = clips[0].duration;
  if (clips.length > 1) {
    if (useXfade) {
      for (let i = 1; i < clips.length; i++) {
        const offset = Math.max(0, videoDuration - xd);
        graph.push(`[${last}][v${i}]xfade=transition=${t.type}:duration=${xd.toFixed(3)}:offset=${offset.toFixed(3)}[x${i}]`);
        last = `x${i}`;
        videoDuration = offset + clips[i].duration;
      }
    } else {
      graph.push(`${clips.map((_, i) => `[v${i}]`).join('')}concat=n=${clips.length}:v=1:a=0[joined]`);
      last = 'joined';
      videoDuration = clips.reduce((a, c) => a + c.duration, 0);
    }
  }
  let total = videoDuration;
  const post = [];
  if (voice && spec.voice.fitVideo && VOICE_LEAD_IN + voice.durationSec + 0.5 > videoDuration) {
    const extra = VOICE_LEAD_IN + voice.durationSec + 0.5 - videoDuration;
    post.push(`tpad=stop_mode=clone:stop_duration=${extra.toFixed(3)}`);
    total = videoDuration + extra;
  }
  if (spec.fadeInOut && total > 1.5) {
    post.push('fade=t=in:st=0:d=0.4', `fade=t=out:st=${(total - 0.5).toFixed(3)}:d=0.5`);
  }
  let subtitleFiles = null;
  if (spec.subtitles.enabled) {
    if (!ff.filters.subtitles) {
      throw new AppError('FFMPEG_ERROR', 'Your FFmpeg build has no "subtitles" filter (libass).', {
        details: 'Install a full FFmpeg build (e.g. gyan.dev full) to burn in subtitles.', retryable: false,
      });
    }
    const [s0, s1] = voice ? [VOICE_LEAD_IN, VOICE_LEAD_IN + voice.durationSec] : [0.3, Math.max(0.8, total - 0.3)];
    const cues = buildCues(spec.subtitles.text, s0, s1);
    fs.writeFileSync(path.join(outDir, 'subtitles.ass'), toAss(cues, { width: W, height: H, position: spec.subtitles.position }));
    fs.writeFileSync(path.join(outDir, 'subtitles.srt'), toSrt(cues));
    subtitleFiles = { ass: 'subtitles.ass', srt: 'subtitles.srt' };
    // Relative path + cwd=outDir avoids Windows drive-letter escaping issues in the filter string.
    post.push('subtitles=subtitles.ass');
  }
  graph.push(`[${last}]${post.length ? post.join(',') + ',' : ''}format=yuv420p[vout]`);

  // ── Audio graph ──
  const inputs = clips.flatMap(c => ['-i', c.file]);
  let nextInput = clips.length;
  let aout = null;
  const audioParts = [];
  if (music) {
    inputs.push('-stream_loop', '-1', '-i', music.path);
    const vol = spec.music.volume * (voice ? 0.6 : 1); // duck music under narration
    graph.push(`[${nextInput}:a]aformat=sample_rates=44100:channel_layouts=stereo,atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `volume=${vol.toFixed(3)},afade=t=in:st=0:d=0.5,afade=t=out:st=${Math.max(0, total - 2).toFixed(3)}:d=2[mus]`);
    audioParts.push('mus');
    nextInput += 1;
  }
  if (voice) {
    inputs.push('-i', voice.path);
    const ms = Math.round(VOICE_LEAD_IN * 1000);
    graph.push(`[${nextInput}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${ms}|${ms},` +
      `volume=${spec.voice.volume.toFixed(3)},apad,atrim=0:${total.toFixed(3)}[voi]`);
    audioParts.push('voi');
    nextInput += 1;
  }
  if (audioParts.length === 2) {
    // amerge + pan sums both tracks without the level halving amix applies.
    graph.push('[mus][voi]amerge=inputs=2,pan=stereo|c0=c0+c2|c1=c1+c3,alimiter=limit=0.95[aout]');
    aout = 'aout';
  } else if (audioParts.length === 1) {
    aout = audioParts[0];
  } else {
    // Silent track so the MP4 behaves well on social platforms/players that expect audio.
    inputs.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=44100:cl=stereo');
    aout = `${nextInput}:a`;
  }

  const output = path.join(outDir, 'final.mp4');
  const args = [
    ...inputs,
    '-filter_complex', graph.join(';'),
    '-map', '[vout]', '-map', aout.includes(':') ? aout : `[${aout}]`,
    ...ffmpeg.encoderArgs(),
    '-r', String(F),
    '-c:a', 'aac', '-b:a', '192k',
    '-t', total.toFixed(3),
    output,
  ];
  update({ stage: 'encoding', progress: 0.12, message: `Encoding ${W}×${H} @ ${F}fps` });
  await ffmpeg.run(args, {
    signal,
    cwd: outDir,
    durationSec: total,
    onProgress: p => update({ stage: 'encoding', progress: 0.12 + p * 0.83, message: `Encoding ${Math.round(p * 100)}%` }),
  });
  update({ stage: 'encoding', progress: 0.97, message: 'Creating thumbnail' });
  const info = await ffmpeg.probe(output);
  const thumb = await ffmpeg.thumbnail(output, path.join(outDir, 'thumb.jpg'), info.durationSec);
  return {
    output, thumbnail: thumb, width: info.width, height: info.height, fps: F, durationSec: info.durationSec,
    sizeBytes: info.sizeBytes, subtitles: subtitleFiles, voice: voice ? { engine: voice.engine, voice: voice.voice, durationSec: voice.durationSec } : null,
  };
}

module.exports = { render, normalizeSpec, TRANSITIONS, FIT_MODES };
