'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { VideoProvider } = require('./VideoProvider');
const { familyFromModelName } = require('./families');
const { LOCAL_MODELS } = require('./modelGuide');
const settings = require('../store/settings');
const ffmpeg = require('../media/ffmpeg');
const { ROOT, MODELS_DIR, WORKER_SCRIPT } = require('../config');
const { AppError } = require('../errors');
const log = require('../logger').createLogger('local-worker');

function resolveModel(model) {
  // Relative paths (e.g. models/test-tiny-ltx) are resolved against the project folder.
  if (!model) return 'Lightricks/LTX-Video';
  if (/^[.\\/]|^[A-Za-z]:[\\/]|^models[\\/]/.test(model)) return path.resolve(ROOT, model);
  return model;
}

function pythonCandidates() {
  const s = settings.get();
  const list = [];
  if (s.pythonPath) list.push(s.pythonPath);
  list.push(process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python'));
  return list.filter(p => fs.existsSync(p)).concat(process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']);
}

/**
 * Runs open-source video models directly through a persistent Python (diffusers) worker. The
 * worker process stays alive so the model remains loaded in GPU memory between generations.
 */
class LocalVideoModelProvider extends VideoProvider {
  constructor() {
    super('local', 'Local model (Python/diffusers)', 'local');
    this.proc = null;
    this.python = null;
    this.pending = new Map();
    this.stderrTail = [];
    this.probeCache = null;
    this.probeAt = 0;
    this.buffer = '';
  }

  modelId() {
    return resolveModel(settings.get().localModel);
  }

  runProbe(python) {
    return new Promise(resolve => {
      const child = spawn(python, ['-u', WORKER_SCRIPT, '--probe', '--model', this.modelId(), '--models-dir', MODELS_DIR], { windowsHide: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message, missingPython: e.code === 'ENOENT' }); });
      child.on('close', () => {
        clearTimeout(timer);
        const line = out.trim().split('\n').pop();
        try {
          resolve(JSON.parse(line).info);
        } catch {
          resolve({ ok: false, error: (err || out || 'Python worker did not respond').slice(-2000) });
        }
      });
    });
  }

  async probe(force = false) {
    if (!force && this.probeCache && Date.now() - this.probeAt < 60000) return this.probeCache;
    let result = null;
    for (const python of pythonCandidates()) {
      result = await this.runProbe(python);
      if (result.missingPython) continue;
      result.pythonPath = python;
      if (result.ok) break;
    }
    if (!result || result.missingPython) result = { ok: false, error: 'Python was not found. Run setup to create the .venv environment.' };
    this.probeCache = result;
    this.probeAt = Date.now();
    if (result.ok) this.python = result.pythonPath;
    return result;
  }

  async health(force = false) {
    const info = await this.probe(force);
    const model = this.modelId();
    const base = { id: this.id, label: this.label, kind: this.kind, model, recommended: LOCAL_MODELS };
    if (!info.ok) {
      return { ...base, available: false, status: 'not_installed', message: 'Local model worker is not installed (Python + torch + diffusers).', details: info.error, python: info.python };
    }
    const gpu = info.gpus && info.gpus[0]
      ? { name: info.gpus[0].name, type: 'cuda', vramTotalGB: info.gpus[0].vram_gb }
      : { name: info.device === 'mps' ? 'Apple Silicon (MPS)' : 'CPU', type: info.device };
    const isTest = /test-tiny/i.test(model);
    return {
      ...base,
      available: true,
      status: 'online',
      python: info.python, torch: info.torch, diffusers: info.diffusers, device: info.device, gpu,
      modelCached: info.model_cached, loadedModel: this.loadedModel || null,
      message: `Ready on ${info.device.toUpperCase()} — model ${info.model_cached ? 'downloaded' : 'downloads on first use'}`,
      warning: isTest ? 'The selected local model is the tiny TEST model (random weights) — it produces noise, not real video.'
        : info.device === 'cpu' ? 'No GPU detected — generation on CPU is very slow. An NVIDIA GPU is strongly recommended.' : undefined,
    };
  }

  async selectEngine(mode) {
    const model = this.modelId();
    const family = familyFromModelName(model);
    const i2v = family !== 'wan' || /i2v/i.test(model);
    const t2v = !/i2v/i.test(model);
    if ((mode === 'i2v' && !i2v) || (mode === 't2v' && !t2v)) {
      throw new AppError('MODEL_MISSING', `The local model ${model} does not support ${mode === 'i2v' ? 'image-to-video' : 'text-to-video'}.`);
    }
    return { id: `local:${model}`, label: path.basename(model), family, t2v, i2v, distilled: /distill/i.test(model), model };
  }

  async ensureWorker() {
    if (this.proc) return this.proc;
    if (!this.python) {
      const info = await this.probe(true);
      if (!info.ok) throw new AppError('WORKER_UNAVAILABLE', null, { details: info.error });
    }
    log.info(`Starting Python worker (${this.python})`);
    const proc = spawn(this.python, ['-u', WORKER_SCRIPT], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false' },
    });
    this.proc = proc;
    this.stderrTail = [];
    this.buffer = '';
    proc.stdout.on('data', chunk => {
      this.buffer += chunk.toString();
      let idx;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { log.debug(`worker: ${line}`); continue; }
        this.dispatch(msg);
      }
    });
    proc.stderr.on('data', chunk => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 60) this.stderrTail.shift();
        log.debug(`worker stderr: ${line}`);
      }
    });
    proc.on('error', err => log.error('Worker process error:', err.message));
    proc.on('exit', (code, sig) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.loadedModel = null;
      const details = this.stderrTail.join('\n');
      if (this.pending.size) log.error(`Python worker exited (code ${code}, signal ${sig}) with ${this.pending.size} job(s) running\n${details}`);
      for (const [, p] of this.pending) {
        if (p.cancelled) p.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        else p.reject(new AppError('WORKER_CRASHED', `The Python worker stopped unexpectedly (exit code ${code ?? sig}).`, { details }));
      }
      this.pending.clear();
    });
    return proc;
  }

  send(msg) {
    if (!this.proc) throw new AppError('WORKER_CRASHED', 'Python worker is not running');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  dispatch(msg) {
    if (msg.event === 'ready') return log.info(`Python worker ready (pid ${msg.pid})`);
    if (msg.event === 'log') return log.info(`worker: ${msg.message}`);
    const p = this.pending.get(msg.id);
    if (!p) return;
    switch (msg.event) {
      case 'stage': p.ctx.stage(msg.stage, 0, msg.message); break;
      case 'download': p.ctx.stage('loading_model', msg.total ? msg.done / msg.total : 0, msg.message); break;
      case 'step': p.ctx.step(msg.step, msg.total); break;
      case 'frames': p.ctx.stage('processing', msg.done / msg.total, `Writing frames ${msg.done}/${msg.total}`); break;
      case 'loaded':
        this.loadedModel = msg.model;
        this.pending.delete(msg.id);
        p.resolve(msg);
        break;
      case 'done':
        this.loadedModel = msg.result.model;
        this.pending.delete(msg.id);
        p.resolve(msg.result);
        break;
      case 'cancelled':
        this.pending.delete(msg.id);
        p.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        break;
      case 'error':
        this.pending.delete(msg.id);
        p.reject(new AppError(msg.code in { GPU_OOM: 1, MODEL_MISSING: 1, INVALID_INPUT: 1, FFMPEG_ERROR: 1 } ? msg.code : 'PROVIDER_ERROR',
          msg.message, { details: msg.details }));
        break;
      default:
    }
  }

  request(msg, ctx) {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, ctx, cancelled: false };
      this.pending.set(msg.id, entry);
      const signal = ctx.signal;
      if (signal) {
        const onAbort = () => {
          entry.cancelled = true;
          try { this.send({ cmd: 'cancel', id: msg.id }); } catch { /* worker gone */ }
          // Model loading / VAE decoding can't be interrupted mid-way; kill the worker if it doesn't stop soon.
          setTimeout(() => {
            if (this.pending.has(msg.id) && this.proc) {
              log.warn('Worker did not stop after cancel — restarting it');
              this.proc.kill('SIGKILL');
            }
          }, 20000).unref();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        this.send(msg);
      } catch (err) {
        this.pending.delete(msg.id);
        reject(err);
      }
    });
  }

  workerOptions() {
    const s = settings.get();
    return { model: this.modelId(), models_dir: MODELS_DIR, offload: s.localOffload, dtype: s.localDtype };
  }

  /** Loads the model in the background so the first generation starts immediately. */
  async preload() {
    const info = await this.probe();
    if (!info.ok) return;
    await this.ensureWorker();
    const ctx = { stage: () => {}, step: () => {}, log: () => {} };
    try {
      await this.request({ cmd: 'load', id: `preload_${Date.now()}`, ...this.workerOptions() }, ctx);
      log.info(`Model preloaded: ${this.modelId()}`);
    } catch (err) {
      log.warn(`Model preload failed: ${err.message}`);
    }
  }

  async generate(req, ctx) {
    await ffmpeg.requireFfmpeg();
    if (!this.proc || this.loadedModel !== path.basename(this.modelId()) && this.loadedModel !== this.modelId()) {
      ctx.stage('loading_model', 0, this.proc ? 'Loading model' : 'Starting the local AI engine');
    }
    await this.ensureWorker();
    const output = path.join(req.outDir, `segment-${req.segment || 0}.mp4`);
    const { intermediateArgs } = require('./LocalComfyUIProvider');
    const result = await this.request({
      cmd: 'generate',
      id: `${req.jobId}_${req.segment || 0}`,
      ...this.workerOptions(),
      mode: req.mode,
      prompt: req.prompt,
      negative_prompt: req.negativePrompt,
      image_path: req.imagePath,
      width: req.width,
      height: req.height,
      frames: req.frames,
      fps: req.fps,
      steps: req.steps,
      cfg: req.cfg,
      seed: req.seed,
      tiled_decode: Boolean(req.tiledDecode),
      ffmpeg: ffmpeg.bin('ffmpeg'),
      encode_args: intermediateArgs(),
      output,
    }, ctx);
    ctx.log(`Local worker: ${result.frames} frames on ${result.device} (${result.dtype}, offload ${result.offload}); ` +
      `load ${result.timings.load}s, generate ${result.timings.generate}s, write ${result.timings.encode}s`);
    return { video: output, width: result.width, height: result.height, fps: result.fps, frames: result.frames,
      model: path.basename(result.model), device: result.device };
  }

  async shutdown() {
    if (!this.proc) return;
    try { this.send({ cmd: 'shutdown' }); } catch { /* ignore */ }
    const proc = this.proc;
    setTimeout(() => proc.kill('SIGKILL'), 3000).unref();
  }
}

module.exports = { LocalVideoModelProvider };
