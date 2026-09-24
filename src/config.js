'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

const DATA_DIR = path.resolve(env('DATA_DIR', path.join(ROOT, 'data')));
const LOG_DIR = path.resolve(env('LOG_DIR', path.join(ROOT, 'logs')));
const MODELS_DIR = path.resolve(env('MODELS_DIR', path.join(ROOT, 'models')));

for (const dir of [DATA_DIR, LOG_DIR, path.join(DATA_DIR, 'projects'), path.join(DATA_DIR, 'tmp')]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Defaults for runtime settings. data/settings.json (edited on the Settings page) overrides these.
const defaults = {
  provider: env('VIDEO_PROVIDER', 'auto'), // auto | comfyui | local | external
  comfyuiUrl: env('COMFYUI_URL', 'http://127.0.0.1:8188').replace(/\/+$/, ''),
  comfyuiPath: env('COMFYUI_PATH', ''),
  comfyuiModel: 'auto', // auto | <checkpoint/unet filename> | custom:<workflow file>
  pythonPath: env('PYTHON_PATH', ''),
  localModel: env('LOCAL_MODEL', 'Lightricks/LTX-Video'),
  localOffload: 'auto', // auto | none | model | sequential
  localDtype: 'auto', // auto | bf16 | fp16 | fp32
  externalApiUrl: env('EXTERNAL_API_URL', 'https://api.replicate.com/v1').replace(/\/+$/, ''),
  externalApiToken: env('EXTERNAL_API_TOKEN', ''),
  externalModel: env('EXTERNAL_MODEL', 'lightricks/ltx-video'),
  externalExtraInput: '',
  ollamaUrl: env('OLLAMA_URL', '').replace(/\/+$/, ''),
  ollamaModel: env('OLLAMA_MODEL', 'llama3.2'),
  enhancePrompts: true,
  defaultQuality: 'fast', // fast | balanced | quality — fast = lowest latency (reduced resolution, upscaled by FFmpeg)
  upscaleOutput: true, // upscale final output to 720p-class resolution with FFmpeg (lanczos)
  hardwareEncoder: 'auto', // auto | off  (NVENC / QuickSync / AMF when usable)
  ttsEngine: env('TTS_ENGINE', 'auto'), // auto | piper | sapi | espeak | say
  ttsVoice: '',
  ttsRate: 1.0,
  piperPath: env('PIPER_PATH', ''),
  piperVoice: env('PIPER_VOICE', ''),
  ffmpegPath: env('FFMPEG_PATH', ''),
  ffprobePath: env('FFPROBE_PATH', ''),
  autoRetry: true,
};

module.exports = {
  ROOT,
  PORT: parseInt(env('PORT', '3000'), 10),
  HOST: env('HOST', '127.0.0.1'),
  DATA_DIR,
  LOG_DIR,
  MODELS_DIR,
  PROJECTS_DIR: path.join(DATA_DIR, 'projects'),
  TMP_DIR: path.join(DATA_DIR, 'tmp'),
  WORKFLOWS_DIR: path.join(ROOT, 'workflows'),
  WORKER_SCRIPT: path.join(ROOT, 'worker', 'video_worker.py'),
  defaults,
};
