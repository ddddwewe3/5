'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../config');
const ffmpeg = require('./ffmpeg');
const log = require('../logger').createLogger('ffmpeg-install');

/**
 * One-click FFmpeg install: downloads a portable, open-source FFmpeg build into tools/ffmpeg
 * (the app looks there first), so no PATH changes or admin rights are needed.
 */
const SOURCES = {
  win32: [
    { url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip', type: 'zip' },
    { url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', type: 'zip' },
  ],
  linux: [
    { url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz', type: 'tar.xz' },
  ],
};

const TOOLS = path.join(ROOT, 'tools');
const state = { status: 'idle', downloaded: 0, total: 0, source: null, error: null, path: null };

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve(stdout);
    });
  });
}

function findBinDir(dir, depth = 0) {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (fs.existsSync(path.join(dir, 'bin', exe))) return dir;
  if (depth > 3) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const hit = findBinDir(path.join(dir, e.name), depth + 1);
    if (hit) return hit;
  }
  return null;
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  state.total = Number(res.headers.get('content-length') || 0);
  state.downloaded = 0;
  const out = fs.createWriteStream(dest);
  for await (const chunk of res.body) {
    if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    state.downloaded += chunk.length;
  }
  await new Promise((resolve, reject) => { out.on('error', reject); out.end(resolve); });
}

async function extract(archive, type, into) {
  fs.mkdirSync(into, { recursive: true });
  if (type === 'zip' && process.platform === 'win32') {
    try {
      await run('tar', ['-xf', archive, '-C', into]); // bsdtar ships with Windows 10+ and reads zip
    } catch {
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${into.replace(/'/g, "''")}' -Force`]);
    }
  } else if (type === 'zip') {
    await run('unzip', ['-q', '-o', archive, '-d', into]);
  } else {
    await run('tar', ['-xJf', archive, '-C', into]);
  }
}

async function install() {
  const sources = SOURCES[process.platform];
  if (!sources) {
    throw new Error(process.platform === 'darwin'
      ? 'On macOS install FFmpeg with Homebrew: brew install ffmpeg'
      : `Automatic FFmpeg install is not available for ${process.platform}. Install FFmpeg with your package manager.`);
  }
  fs.mkdirSync(TOOLS, { recursive: true });
  let lastError = null;
  for (const src of sources) {
    const archive = path.join(TOOLS, `ffmpeg-download.${src.type}`);
    const staging = path.join(TOOLS, 'ffmpeg-staging');
    try {
      state.source = new URL(src.url).host;
      state.status = 'downloading';
      log.info(`Downloading FFmpeg from ${src.url}`);
      await download(src.url, archive);
      state.status = 'extracting';
      fs.rmSync(staging, { recursive: true, force: true });
      await extract(archive, src.type, staging);
      const dir = findBinDir(staging);
      if (!dir) throw new Error('The downloaded archive does not contain bin/ffmpeg');
      const target = path.join(TOOLS, 'ffmpeg');
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(dir, target);
      if (process.platform !== 'win32') {
        for (const b of ['ffmpeg', 'ffprobe']) fs.chmodSync(path.join(target, 'bin', b), 0o755);
      }
      const info = await ffmpeg.detect(true);
      if (!info.available) throw new Error(info.error || 'FFmpeg still not usable after install');
      state.status = 'done';
      state.path = info.path;
      log.info(`FFmpeg installed: ${info.version} at ${info.path}`);
      return;
    } catch (err) {
      lastError = err;
      log.warn(`FFmpeg install from ${src.url} failed: ${err.message}`);
    } finally {
      fs.rmSync(archive, { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  throw lastError || new Error('FFmpeg download failed');
}

/** Starts the install in the background (idempotent) and returns the live state. */
function start() {
  if (state.status === 'downloading' || state.status === 'extracting') return status();
  Object.assign(state, { status: 'downloading', downloaded: 0, total: 0, error: null, path: null });
  install().catch(err => {
    state.status = 'error';
    state.error = err.message;
  });
  return status();
}

function status() {
  return { ...state, progress: state.total ? state.downloaded / state.total : null };
}

module.exports = { start, status, install, state };
