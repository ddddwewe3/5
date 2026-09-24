#!/usr/bin/env node
'use strict';
/**
 * Environment check: Node.js, Python + AI packages, GPU/CUDA, FFmpeg, ComfyUI, TTS.
 * Prints what is missing and exactly how to fix it. Used by setup.ps1 / setup.sh and `npm run doctor`.
 * Exit code 0 = ready to generate, 1 = something required is missing.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
const color = (c, s) => (process.stdout.isTTY ? `\x1b[${c}m${s}\x1b[0m` : s);
const OK = color(32, '✔');
const BAD = color(31, '✖');
const WARN = color(33, '!');
let required = 0;

function run(cmd, args, timeout = 30000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: err && err.code });
    });
  });
}

function line(mark, title, detail = '', fix = '') {
  console.log(`  ${mark} ${title}${detail ? color(90, `  ${detail}`) : ''}`);
  if (fix) console.log(color(36, `      → ${fix}`));
}

async function main() {
  console.log(color(1, '\nOpenReel Studio — environment check\n'));

  // Node.js
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) line(OK, 'Node.js', `v${process.versions.node}`);
  else { required++; line(BAD, 'Node.js', `v${process.versions.node} (too old)`, 'Install Node.js 20 or newer from https://nodejs.org'); }
  if (fs.existsSync(path.join(ROOT, 'node_modules', 'express'))) line(OK, 'Node packages', 'installed');
  else { required++; line(BAD, 'Node packages', 'missing', 'Run: npm install'); }

  // FFmpeg
  const ffPath = process.env.FFMPEG_PATH || (fs.existsSync(path.join(ROOT, 'tools', 'ffmpeg', 'bin', `ffmpeg${WIN ? '.exe' : ''}`))
    ? path.join(ROOT, 'tools', 'ffmpeg', 'bin', `ffmpeg${WIN ? '.exe' : ''}`) : 'ffmpeg');
  const ff = await run(ffPath, ['-hide_banner', '-version']);
  if (ff.ok) {
    const enc = await run(ffPath, ['-hide_banner', '-encoders']);
    const hw = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'].filter(e => enc.stdout.includes(e));
    line(OK, 'FFmpeg', `${ff.stdout.split('\n')[0].split(' ')[2]}${hw.length ? ` · hardware encoders listed: ${hw.join(', ')}` : ''}`);
    const flt = await run(ffPath, ['-hide_banner', '-filters']);
    if (!/\ssubtitles\s/.test(flt.stdout)) line(WARN, 'FFmpeg subtitles filter', 'missing (libass)', 'Install a full FFmpeg build to burn in subtitles');
  } else {
    required++;
    line(BAD, 'FFmpeg', 'not found', WIN ? 'Run setup.bat, or: winget install Gyan.FFmpeg' : 'Install ffmpeg (e.g. sudo apt install ffmpeg / brew install ffmpeg)');
  }

  // GPU
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version,compute_cap', '--format=csv,noheader']);
  let hasNvidia = false;
  if (smi.ok && smi.stdout.trim()) {
    hasNvidia = true;
    for (const g of smi.stdout.trim().split('\n')) line(OK, 'NVIDIA GPU', g.trim());
  } else if (process.platform === 'darwin') {
    line(OK, 'GPU', 'Apple Silicon / Metal (MPS) if available');
  } else {
    line(WARN, 'NVIDIA GPU', 'not detected', 'Video generation works on CPU but is very slow. An NVIDIA GPU with 8 GB+ VRAM is recommended.');
  }

  // Python worker
  const venvPy = WIN ? path.join(ROOT, '.venv', 'Scripts', 'python.exe') : path.join(ROOT, '.venv', 'bin', 'python');
  const py = process.env.PYTHON_PATH || (fs.existsSync(venvPy) ? venvPy : (WIN ? 'python' : 'python3'));
  const probe = await run(py, [path.join(ROOT, 'worker', 'video_worker.py'), '--probe', '--model', process.env.LOCAL_MODEL || 'Lightricks/LTX-Video',
    '--models-dir', process.env.MODELS_DIR || path.join(ROOT, 'models')], 120000);
  let info = null;
  try { info = JSON.parse(probe.stdout.trim().split('\n').pop()).info; } catch { /* no json */ }
  let localReady = false;
  if (!info) {
    line(WARN, 'Python worker', `not available (${py})`, WIN ? 'Run setup.bat to create the Python environment' : 'Run ./setup.sh');
  } else if (!info.ok) {
    line(WARN, 'Python worker', `Python ${info.python}: ${info.error}`, WIN ? 'Run setup.bat' : 'Run ./setup.sh');
  } else {
    localReady = true;
    line(OK, 'Python + PyTorch', `Python ${info.python} · torch ${info.torch} · diffusers ${info.diffusers}`);
    if (info.cuda) line(OK, 'CUDA', `${info.cuda_version} · ${info.gpus.map(g => `${g.name} ${g.vram_gb} GB`).join(', ')}`);
    else if (info.mps) line(OK, 'Apple MPS', 'available');
    else if (hasNvidia) line(WARN, 'CUDA', 'PyTorch cannot use your NVIDIA GPU (CPU-only build installed)', 'Re-run setup to install the CUDA build of PyTorch');
    else line(WARN, 'CUDA', 'not available — CPU only');
    line(info.model_cached ? OK : WARN, 'Local model', `${info.model} ${info.model_cached ? 'downloaded' : 'not downloaded yet (downloads automatically on first use)'}`);
  }

  // ComfyUI
  const url = (process.env.COMFYUI_URL || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  let comfyOk = false;
  try {
    const res = await fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(4000) });
    const stats = await res.json();
    comfyOk = true;
    const dev = (stats.devices || [])[0];
    line(OK, 'ComfyUI', `${stats.system.comfyui_version} at ${url}${dev ? ` · ${dev.name}` : ''}`);
    const ck = await (await fetch(`${url}/object_info/CheckpointLoaderSimple`)).json();
    const un = await (await fetch(`${url}/object_info/UNETLoader`)).json();
    const opts = (o, n, k) => { const s = o[n] && o[n].input.required[k]; return s ? (Array.isArray(s[0]) ? s[0] : (s[1] && s[1].options) || []) : []; };
    const models = [...opts(ck, 'CheckpointLoaderSimple', 'ckpt_name'), ...opts(un, 'UNETLoader', 'unet_name')].filter(f => /ltx|wan/i.test(f));
    if (models.length) line(OK, 'ComfyUI video models', models.join(', '));
    else line(WARN, 'ComfyUI video models', 'none found', `Run: ${WIN ? 'download-models.bat' : 'npm run download-models'}`);
  } catch {
    const p = process.env.COMFYUI_PATH;
    line(WARN, 'ComfyUI', `not running at ${url}`, p ? `start.${WIN ? 'bat' : 'sh'} launches it from ${p}` : 'ComfyUI is not running. Start ComfyUI to enable local AI video generation (or set COMFYUI_PATH so start.bat launches it).');
  }

  // TTS
  const tts = [];
  if (WIN) tts.push('Windows voices (SAPI)');
  if (process.platform === 'darwin') tts.push('macOS voices');
  if ((await run(WIN ? 'where' : 'which', ['espeak-ng'])).ok || (await run(WIN ? 'where' : 'which', ['espeak'])).ok) tts.push('eSpeak NG');
  const piper = fs.existsSync(path.join(ROOT, '.venv', WIN ? 'Scripts' : 'bin', `piper${WIN ? '.exe' : ''}`));
  const piperVoices = fs.existsSync(path.join(ROOT, 'models', 'piper')) ? fs.readdirSync(path.join(ROOT, 'models', 'piper')).filter(f => f.endsWith('.onnx')) : [];
  if (piper && piperVoices.length) tts.unshift(`Piper (${piperVoices.join(', ')})`);
  if (tts.length) line(OK, 'Text-to-speech', tts.join(', '));
  else line(WARN, 'Text-to-speech', 'none', 'Install espeak-ng or Piper for voice-overs');

  console.log('');
  if (!comfyOk && !localReady) {
    required++;
    line(BAD, 'Video engine', 'none available', 'Start ComfyUI (with a video model) or run setup to install the local Python worker');
  } else {
    line(OK, 'Video engine', comfyOk ? 'ComfyUI (primary)' : 'Local Python worker (ComfyUI offline)');
  }
  console.log(required ? color(31, `\n${required} required item(s) missing — see the → hints above.\n`) : color(32, '\nReady. Start with start.bat (Windows) or ./start.sh, then open http://localhost:3000\n'));
  process.exit(required ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
