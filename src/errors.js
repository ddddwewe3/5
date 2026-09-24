'use strict';

/**
 * Error taxonomy. Every failure shown to the user is mapped to one of these codes so the UI can
 * explain *why* it failed and what to do — never a bare "AI generation failed". The raw backend
 * error is kept in `details` and written to the developer log.
 */
const ERROR_INFO = {
  COMFYUI_OFFLINE: {
    title: 'ComfyUI is not running',
    message: 'ComfyUI is not running. Start ComfyUI to enable local AI video generation.',
    reasons: ['ComfyUI is offline or still starting up', 'COMFYUI_URL points to the wrong address/port'],
    fixes: ['Start ComfyUI (start.bat starts it automatically when COMFYUI_PATH is set)', 'Check the ComfyUI URL on the Settings page'],
    retryable: true,
  },
  MODEL_MISSING: {
    title: 'Model is missing',
    message: 'The video model required for this generation is not installed.',
    reasons: ['No supported video model found in ComfyUI/models', 'The configured local model could not be downloaded or found'],
    fixes: ['Open Settings → Engine to see which model files are expected and where to put them', 'Run setup again with internet access so the model can be downloaded'],
    retryable: false,
  },
  GPU_OOM: {
    title: 'GPU memory is insufficient',
    message: 'The GPU ran out of memory while generating.',
    reasons: ['Resolution or duration too large for this GPU', 'Another program is using GPU memory'],
    fixes: ['Choose the "Fast" quality preset or a shorter duration', 'Close other GPU-heavy apps', 'Enable CPU offload in Settings'],
    retryable: true,
  },
  INVALID_INPUT: {
    title: 'Invalid input',
    message: 'The request could not be processed because some input is invalid.',
    reasons: ['Missing prompt or image', 'Unsupported file type', 'Value out of range'],
    fixes: ['Check the prompt, uploaded image and selected options'],
    retryable: false,
  },
  FFMPEG_MISSING: {
    title: 'FFmpeg is not installed',
    message: 'FFmpeg is required to encode videos but was not found.',
    reasons: ['FFmpeg is not installed or not on PATH'],
    fixes: ['Run setup.bat (installs FFmpeg with winget) or install FFmpeg manually and add it to PATH', 'Or set FFMPEG_PATH in .env'],
    retryable: false,
  },
  FFMPEG_ERROR: {
    title: 'FFmpeg processing error',
    message: 'FFmpeg failed while processing the video.',
    reasons: ['A source clip is corrupt or missing', 'Unsupported codec/filter in your FFmpeg build', 'Disk is full'],
    fixes: ['See the developer log below for the exact FFmpeg error', 'Update FFmpeg to a full build (e.g. gyan.dev "full")'],
    retryable: true,
  },
  WORKER_UNAVAILABLE: {
    title: 'Local model worker is not installed',
    message: 'The local Python video worker is not available.',
    reasons: ['Python or its AI packages (torch, diffusers) are not installed'],
    fixes: ['Run setup.bat to create the Python environment', 'Or start ComfyUI and use it as the engine'],
    retryable: false,
  },
  WORKER_CRASHED: {
    title: 'Local model worker crashed',
    message: 'The local Python video worker stopped unexpectedly.',
    reasons: ['GPU driver error', 'System ran out of RAM', 'Incompatible torch/CUDA installation'],
    fixes: ['Check the developer log for the Python traceback', 'Try again — the worker restarts automatically'],
    retryable: true,
  },
  NO_ENGINE: {
    title: 'No video engine available',
    message: 'No video generation engine is available right now.',
    reasons: ['ComfyUI is offline', 'The local Python worker is not installed', 'No external provider is configured'],
    fixes: ['Start ComfyUI, or run setup.bat to install the local worker'],
    retryable: false,
  },
  PROVIDER_NOT_CONFIGURED: {
    title: 'Provider not configured',
    message: 'The selected video provider is not configured.',
    reasons: ['Missing API token or URL'],
    fixes: ['Configure the provider on the Settings page, or switch to a local engine'],
    retryable: false,
  },
  PROVIDER_ERROR: {
    title: 'Video engine error',
    message: 'The video engine reported an error.',
    reasons: ['The model rejected the input', 'An unexpected error inside the engine'],
    fixes: ['See the developer log below for the engine\'s own error message'],
    retryable: true,
  },
  NETWORK_ERROR: {
    title: 'Network error',
    message: 'Could not reach the video engine.',
    reasons: ['Connection interrupted', 'Service temporarily unavailable'],
    fixes: ['Try again in a moment'],
    retryable: true,
  },
  TTS_ERROR: {
    title: 'Voice generation failed',
    message: 'Text-to-speech could not generate the voice track.',
    reasons: ['No local TTS engine installed', 'Selected voice not available'],
    fixes: ['Install Piper or espeak-ng, or pick another voice in Settings'],
    retryable: false,
  },
  INTERRUPTED: {
    title: 'Interrupted',
    message: 'The job was interrupted because the server restarted.',
    reasons: ['The server was stopped while this job was running'],
    fixes: ['Click Regenerate to run it again'],
    retryable: false,
  },
  CANCELLED: {
    title: 'Cancelled',
    message: 'The job was cancelled.',
    reasons: ['Cancelled by the user'],
    fixes: [],
    retryable: false,
  },
  NOT_FOUND: {
    title: 'Not found',
    message: 'The requested item does not exist.',
    reasons: [],
    fixes: [],
    retryable: false,
  },
  UNKNOWN: {
    title: 'Unexpected error',
    message: 'An unexpected error occurred.',
    reasons: ['See developer log for details'],
    fixes: ['Check the developer log (Settings → Developer logs)'],
    retryable: false,
  },
};

class AppError extends Error {
  constructor(code, message, { details, cause, retryable, status, hint } = {}) {
    const info = ERROR_INFO[code] || ERROR_INFO.UNKNOWN;
    super(message || info.message);
    this.name = 'AppError';
    this.code = ERROR_INFO[code] ? code : 'UNKNOWN';
    this.details = details || (cause && (cause.stack || cause.message)) || undefined;
    this.retryable = retryable ?? info.retryable;
    this.status = status || statusFor(this.code);
    this.hint = hint;
  }
}

function statusFor(code) {
  switch (code) {
    case 'INVALID_INPUT': return 400;
    case 'NOT_FOUND': return 404;
    case 'COMFYUI_OFFLINE':
    case 'NO_ENGINE':
    case 'WORKER_UNAVAILABLE':
    case 'PROVIDER_NOT_CONFIGURED':
    case 'FFMPEG_MISSING': return 503;
    default: return 500;
  }
}

/** Best-effort mapping of an arbitrary error (engine message, exception) onto the taxonomy. */
function classify(err, fallbackCode = 'UNKNOWN') {
  if (err instanceof AppError) return err;
  const text = `${err && err.message ? err.message : err} ${err && err.details ? err.details : ''}`;
  const raw = err && (err.stack || err.message) ? (err.stack || err.message) : String(err);
  if (err && err.name === 'AbortError') return new AppError('CANCELLED', null, { details: raw });
  if (/out of memory|CUDA_OUT_OF_MEMORY|OutOfMemoryError|allocation on device|not enough memory/i.test(text)) {
    return new AppError('GPU_OOM', null, { details: raw });
  }
  if (/ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(text)) {
    return new AppError(fallbackCode === 'COMFYUI_OFFLINE' ? 'COMFYUI_OFFLINE' : 'NETWORK_ERROR', null, { details: raw });
  }
  if (/ENOENT.*ffmpeg|spawn .*ffmpeg/i.test(text)) return new AppError('FFMPEG_MISSING', null, { details: raw });
  if (/ENOSPC/i.test(text)) return new AppError('FFMPEG_ERROR', 'The disk is full.', { details: raw, retryable: false });
  return new AppError(fallbackCode, null, { details: raw });
}

/** Serializable error for API responses / project records. */
function toClient(err) {
  const e = err instanceof AppError ? err : classify(err);
  const info = ERROR_INFO[e.code] || ERROR_INFO.UNKNOWN;
  return {
    code: e.code,
    title: info.title,
    message: e.message,
    reasons: info.reasons,
    fixes: info.fixes,
    hint: e.hint,
    details: e.details ? String(e.details).slice(-8000) : undefined,
    retryable: e.retryable,
  };
}

module.exports = { AppError, ERROR_INFO, classify, toClient };
