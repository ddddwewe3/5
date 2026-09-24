'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { VideoProvider } = require('./VideoProvider');
const { ComfyClient, comboOptions } = require('./comfy/client');
const workflows = require('./comfy/workflows');
const { COMFY_MODELS } = require('./modelGuide');
const settings = require('../store/settings');
const ffmpeg = require('../media/ffmpeg');
const { AppError, classify } = require('../errors');
const log = require('../logger').createLogger('comfyui');

const OFFLINE_MESSAGE = 'ComfyUI is not running. Start ComfyUI to enable local AI video generation.';
const PROBE_NODES = [
  'CheckpointLoaderSimple', 'UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPVisionLoader',
  'EmptyLTXVLatentVideo', 'LTXVImgToVideo', 'LTXVConditioning', 'LTXVScheduler', 'LTXVPreprocess', 'SamplerCustom',
  'EmptyHunyuanLatentVideo', 'WanImageToVideo', 'Wan22ImageToVideoLatent', 'ModelSamplingSD3', 'CLIPVisionEncode', 'PreviewImage',
];
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|gif)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

function prefer(list, patterns) {
  for (const re of patterns) {
    const hit = list.find(f => re.test(f));
    if (hit) return hit;
  }
  return null;
}

class LocalComfyUIProvider extends VideoProvider {
  constructor() {
    super('comfyui', 'ComfyUI (local)', 'local');
    this.discovery = null;
    this.discoveredAt = 0;
  }

  client() {
    return new ComfyClient(settings.get().comfyuiUrl);
  }

  /** Queries ComfyUI for its GPU, available nodes and installed model files. */
  async discover(force = false) {
    const url = settings.get().comfyuiUrl;
    if (!force && this.discovery && this.discovery.url === url && Date.now() - this.discoveredAt < 15000) return this.discovery;
    const client = this.client();
    const stats = await client.systemStats();
    const infos = await Promise.all(PROBE_NODES.map(n => client.objectInfo(n).catch(() => ({}))));
    const info = Object.assign({}, ...infos);
    const nodes = new Set(Object.keys(info));
    const files = {
      checkpoints: comboOptions(info, 'CheckpointLoaderSimple', 'ckpt_name'),
      unets: comboOptions(info, 'UNETLoader', 'unet_name'),
      textEncoders: comboOptions(info, 'CLIPLoader', 'clip_name'),
      vaes: comboOptions(info, 'VAELoader', 'vae_name'),
      clipVisions: comboOptions(info, 'CLIPVisionLoader', 'clip_name'),
    };
    const engines = [];
    const t5 = prefer(files.textEncoders.filter(f => !/umt5/i.test(f)), [/t5xxl.*fp16/i, /t5xxl/i, /t5.*xxl/i]);
    const umt5 = prefer(files.textEncoders, [/umt5.*fp16/i, /umt5/i]);
    const hasLtxNodes = ['EmptyLTXVLatentVideo', 'LTXVConditioning', 'LTXVScheduler', 'SamplerCustom'].every(n => nodes.has(n));
    for (const ckpt of files.checkpoints) {
      if (!/ltx-?v|ltx-video/i.test(ckpt) || /ltx-?2[._-]\d|ltx_2/i.test(ckpt)) continue;
      if (!t5 || !hasLtxNodes) continue;
      engines.push({
        id: `ltxv:${ckpt}`, label: `LTX-Video — ${ckpt}`, family: 'ltxv', distilled: /distill/i.test(ckpt),
        t2v: true, i2v: nodes.has('LTXVImgToVideo'), files: { checkpoint: ckpt, textEncoder: t5 },
      });
    }
    const hasWanNodes = nodes.has('ModelSamplingSD3') && nodes.has('EmptyHunyuanLatentVideo');
    const wan21Vae = prefer(files.vaes, [/wan_?2\.?1_vae|wan2\.1_vae|wan_2\.1_vae/i, /^(?!.*2\.?2).*wan.*vae/i]);
    const wan22Vae = prefer(files.vaes, [/wan_?2\.?2_vae/i]);
    const clipVisionH = prefer(files.clipVisions, [/clip_vision_h/i, /vit-?h/i]);
    for (const unet of files.unets) {
      if (!/wan/i.test(unet) || /high_noise|low_noise|vace|fun|camera|animate|s2v/i.test(unet) || !umt5) continue;
      if (/ti2v/i.test(unet) && wan22Vae && nodes.has('Wan22ImageToVideoLatent')) {
        engines.push({ id: `wan22:${unet}`, label: `Wan 2.2 TI2V — ${unet}`, family: 'wan22', t2v: true, i2v: true,
          files: { unet, textEncoder: umt5, vae: wan22Vae } });
      } else if (/t2v/i.test(unet) && wan21Vae && hasWanNodes) {
        engines.push({ id: `wan:${unet}`, label: `Wan 2.1 T2V — ${unet}`, family: 'wan', t2v: true, i2v: false,
          files: { unet, textEncoder: umt5, vae: wan21Vae } });
      } else if (/i2v/i.test(unet) && wan21Vae && clipVisionH && nodes.has('WanImageToVideo')) {
        engines.push({ id: `wan:${unet}`, label: `Wan 2.1 I2V — ${unet}`, family: 'wan', t2v: false, i2v: true,
          files: { unet, textEncoder: umt5, vae: wan21Vae, clipVision: clipVisionH } });
      }
    }
    engines.push(...workflows.listCustom());
    const device = (stats.devices || [])[0] || null;
    this.discovery = {
      url,
      version: stats.system && stats.system.comfyui_version,
      pytorch: stats.system && stats.system.pytorch_version,
      gpu: device ? {
        name: device.name, type: device.type,
        vramTotalGB: device.vram_total ? Math.round(device.vram_total / 1e8) / 10 : null,
        vramFreeGB: device.vram_free ? Math.round(device.vram_free / 1e8) / 10 : null,
      } : null,
      nodes,
      files,
      engines,
    };
    this.discoveredAt = Date.now();
    return this.discovery;
  }

  async health() {
    const base = { id: this.id, label: this.label, kind: this.kind, url: settings.get().comfyuiUrl, recommended: COMFY_MODELS };
    let d;
    try {
      d = await this.discover(true);
    } catch (err) {
      return { ...base, available: false, status: 'offline', message: OFFLINE_MESSAGE, details: classify(err, 'COMFYUI_OFFLINE').details };
    }
    const cpuOnly = d.gpu && d.gpu.type === 'cpu';
    const common = { ...base, version: d.version, pytorch: d.pytorch, gpu: d.gpu, engines: d.engines,
      files: d.files, warning: cpuOnly ? 'ComfyUI is running on CPU only — video generation will be very slow.' : undefined };
    if (!d.engines.length) {
      return { ...common, available: false, status: 'no_models',
        message: 'ComfyUI is running, but no supported video model is installed. See the recommended models below.' };
    }
    return { ...common, available: true, status: 'online',
      message: `ComfyUI ${d.version || ''} online — ${d.engines.length} video engine(s) ready` };
  }

  async selectEngine(mode) {
    let d;
    try {
      d = await this.discover();
    } catch (err) {
      throw classify(err, 'COMFYUI_OFFLINE');
    }
    const wanted = settings.get().comfyuiModel;
    if (wanted && wanted !== 'auto') {
      const e = d.engines.find(x => x.id === wanted);
      if (!e) throw new AppError('MODEL_MISSING', `The selected ComfyUI model "${wanted}" is not installed anymore.`);
      if (!e[mode]) throw new AppError('MODEL_MISSING', `${e.label} does not support ${mode === 'i2v' ? 'image-to-video' : 'text-to-video'}.`);
      return e;
    }
    const rank = e => ({ ltxv: e.distilled ? 0 : 1, wan22: 2, wan: 3, custom: 4 }[e.family] ?? 5);
    const candidates = d.engines.filter(e => e[mode]).sort((a, b) => rank(a) - rank(b));
    if (!candidates.length) {
      const what = mode === 'i2v' ? 'image-to-video' : 'text-to-video';
      throw new AppError('MODEL_MISSING', d.engines.length
        ? `No installed ComfyUI model supports ${what}.`
        : 'ComfyUI is running but no supported video model is installed.', {
        details: `Checkpoints: ${d.files.checkpoints.join(', ') || '(none)'}\nDiffusion models: ${d.files.unets.join(', ') || '(none)'}\n` +
          `Text encoders: ${d.files.textEncoders.join(', ') || '(none)'}\nVAEs: ${d.files.vaes.join(', ') || '(none)'}\n\n` +
          `Recommended: ${COMFY_MODELS[0].files.map(f => `ComfyUI/models/${f.folder}/${f.name}`).join(', ')} ` +
          '(run "npm run download-models" or download-models.bat)',
      });
    }
    return candidates[0];
  }

  mapValidationError(err) {
    const body = err.body || {};
    const nodeErrors = body.node_errors || {};
    const lines = [];
    let missingModel = false;
    for (const [id, ne] of Object.entries(nodeErrors)) {
      for (const e of ne.errors || []) {
        lines.push(`node ${id} (${ne.class_type}): ${e.message} — ${e.details || ''}`);
        if (e.type === 'value_not_in_list' && /Loader/.test(ne.class_type || '')) missingModel = true;
      }
    }
    const top = body.error ? `${body.error.message || ''} ${body.error.details || ''}`.trim() : '';
    const details = `${top}\n${lines.join('\n')}`.trim() || JSON.stringify(body).slice(0, 4000);
    if (missingModel) return new AppError('MODEL_MISSING', 'ComfyUI could not find a model file used by the workflow.', { details });
    if (/does not exist|not found/i.test(top)) {
      return new AppError('PROVIDER_ERROR', 'Your ComfyUI version is missing a required node — update ComfyUI.', { details, retryable: false });
    }
    return new AppError('INVALID_INPUT', `ComfyUI rejected the workflow: ${top || 'validation failed'}`, { details });
  }

  async cancelPrompt(client, promptId) {
    try {
      const q = await client.queue();
      const running = (q.queue_running || []).some(item => item[1] === promptId);
      if (running) await client.interrupt(promptId);
      else await client.deleteQueued([promptId]);
      log.info(`Cancelled ComfyUI prompt ${promptId} (${running ? 'interrupted' : 'removed from queue'})`);
    } catch (err) {
      log.warn(`Could not cancel ComfyUI prompt ${promptId}: ${err.message}`);
    }
  }

  /** Waits for a prompt to finish, translating ComfyUI events into real progress stages. */
  waitForPrompt(ws, client, promptId, workflow, ctx) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let started = false;
      let pollTimer = null;
      const settle = (err, value) => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        ctx.signal && ctx.signal.removeEventListener('abort', onAbort);
        if (err) reject(err); else resolve(value);
      };
      const onAbort = () => {
        this.cancelPrompt(client, promptId);
        const e = new Error('Aborted');
        e.name = 'AbortError';
        settle(e);
      };
      if (ctx.signal) {
        if (ctx.signal.aborted) return onAbort();
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
      const poll = async () => {
        try {
          const h = await client.history(promptId);
          const entry = h && h[promptId];
          if (!entry || !entry.status) return;
          if (entry.status.status_str === 'error') {
            const msg = (entry.status.messages || []).find(m => m[0] === 'execution_error');
            settle(this.executionError(msg ? msg[1] : { exception_message: 'Unknown ComfyUI error' }));
          } else if (entry.status.completed) settle(null, entry);
        } catch (err) {
          if (!settled && err.code === 'COMFYUI_OFFLINE') settle(new AppError('COMFYUI_OFFLINE', 'ComfyUI stopped responding during generation.', { details: err.details }));
        }
      };
      // Polling is a safety net in case a WebSocket event is missed; the socket drives progress.
      pollTimer = setInterval(poll, 5000);
      ws.on('close', () => {
        if (settled) return;
        clearInterval(pollTimer);
        pollTimer = setInterval(poll, 1500);
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary || settled) return;
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        const d = msg.data || {};
        if (d.prompt_id && d.prompt_id !== promptId) return;
        switch (msg.type) {
          case 'status': {
            const remaining = d.status && d.status.exec_info && d.status.exec_info.queue_remaining;
            if (!started && remaining > 1) ctx.stage('queued', 0, `Waiting for ComfyUI (${remaining - 1} job(s) ahead)`);
            break;
          }
          case 'execution_start':
            started = true;
            ctx.stage('loading_model', 0.05, 'Loading model');
            break;
          case 'execution_cached':
            if ((d.nodes || []).some(id => workflows.NODE_STAGE[workflow[id] && workflow[id].class_type] === 'loading_model')) {
              ctx.log('Model already loaded in ComfyUI memory (cached) — skipping load');
            }
            break;
          case 'executing': {
            if (d.node === null || d.node === undefined) {
              if (started) poll();
              break;
            }
            started = true;
            const cls = workflow[d.node] && workflow[d.node].class_type;
            const stage = workflows.NODE_STAGE[cls];
            if (stage === 'loading_model') ctx.stage('loading_model', 0.1, /TextEncode/.test(cls) ? 'Encoding prompt' : /Image|Preprocess/.test(cls) ? 'Preparing reference image' : `Loading model (${cls})`);
            else if (stage === 'generating') ctx.stage('generating', 0, 'Generating frames');
            else if (stage === 'processing') ctx.stage('processing', 0, /Decode/.test(cls) ? 'Decoding frames (VAE)' : 'Saving frames');
            break;
          }
          case 'progress': {
            const cls = workflow[d.node] && workflow[d.node].class_type;
            const stage = workflows.NODE_STAGE[cls];
            if (stage === 'generating' || (!stage && d.max > 1 && started)) ctx.step(d.value, d.max);
            else if (stage === 'processing' && d.max) ctx.stage('processing', d.value / d.max, `Decoding frames ${Math.round((d.value / d.max) * 100)}%`);
            break;
          }
          case 'execution_success':
            poll();
            break;
          case 'execution_error':
            settle(this.executionError(d));
            break;
          case 'execution_interrupted':
            if (!(ctx.signal && ctx.signal.aborted)) {
              settle(new AppError('PROVIDER_ERROR', 'The generation was interrupted inside ComfyUI (someone pressed Cancel in ComfyUI?).'));
            }
            break;
          default:
        }
      });
    });
  }

  executionError(d) {
    const details = `${d.node_type ? `Node ${d.node_id} (${d.node_type})\n` : ''}${d.exception_type || ''}: ${d.exception_message || ''}\n` +
      (Array.isArray(d.traceback) ? d.traceback.join('') : d.traceback || '');
    const e = classify({ message: `${d.exception_type || ''} ${d.exception_message || ''}`, details }, 'PROVIDER_ERROR');
    if (e.code === 'PROVIDER_ERROR' && /Loader/.test(d.node_type || '')) {
      // A loader that cannot read its file means the model is missing, corrupt or only partly downloaded.
      return new AppError('MODEL_MISSING', `ComfyUI could not load the model in ${d.node_type} — the file is corrupt or incomplete. ` +
        'Re-download it (download-models.bat resumes).', { details, retryable: false });
    }
    if (e.code === 'PROVIDER_ERROR') e.message = `ComfyUI error in ${d.node_type || 'workflow'}: ${String(d.exception_message || '').trim().slice(0, 300)}`;
    e.details = details;
    return e;
  }

  collectFiles(entry, outputNode) {
    const outputs = entry.outputs || {};
    const ids = outputNode && outputs[outputNode] ? [outputNode] : Object.keys(outputs);
    const files = [];
    for (const id of ids) {
      for (const key of ['videos', 'gifs', 'images', 'animated']) {
        for (const f of outputs[id][key] || []) if (f && f.filename) files.push(f);
      }
    }
    return files;
  }

  async generate(req, ctx) {
    const client = this.client();
    const d = await this.discover().catch(err => { throw classify(err, 'COMFYUI_OFFLINE'); });
    let imageName = null;
    if (req.mode === 'i2v') {
      ctx.stage('loading_model', 0, 'Uploading reference image to ComfyUI');
      const up = await client.uploadImage(req.imagePath, `${req.jobId}_${path.basename(req.imagePath)}`);
      imageName = up.subfolder ? `${up.subfolder}/${up.name}` : up.name;
    }
    const { workflow, outputNode } = workflows.build({ ...req, imageName, hasPreprocess: d.nodes.has('LTXVPreprocess') });
    // Keep the exact workflow next to the take so it can be opened in ComfyUI for debugging.
    fs.writeFileSync(path.join(req.outDir, `workflow-${req.segment || 0}.json`), JSON.stringify(workflow, null, 2));

    const clientId = crypto.randomUUID();
    const ws = await client.openSocket(clientId);
    let entry;
    try {
      let submitted;
      try {
        submitted = await client.submit(workflow, clientId);
      } catch (err) {
        if (err.status === 400) throw this.mapValidationError(err);
        throw classify(err, 'COMFYUI_OFFLINE');
      }
      if (submitted.node_errors && Object.keys(submitted.node_errors).length) throw this.mapValidationError({ body: submitted });
      ctx.log(`Submitted to ComfyUI (prompt ${submitted.prompt_id}, engine ${req.engine.label})`);
      ctx.stage('queued', 0, 'Queued in ComfyUI');
      entry = await this.waitForPrompt(ws, client, submitted.prompt_id, workflow, ctx);
    } finally {
      ws.terminate();
    }

    const files = this.collectFiles(entry, outputNode);
    if (!files.length) throw new AppError('PROVIDER_ERROR', 'ComfyUI finished but produced no output files.', { details: JSON.stringify(entry.outputs || {}).slice(0, 3000) });
    const fps = req.fps;
    const intermediate = path.join(req.outDir, `segment-${req.segment || 0}.mp4`);
    const video = files.find(f => VIDEO_EXT.test(f.filename));
    if (video) {
      ctx.stage('processing', 0.5, 'Receiving video from ComfyUI');
      const dest = path.join(req.outDir, `comfy-${req.segment || 0}${path.extname(video.filename)}`);
      await client.download(video, dest, ctx.signal);
      await ffmpeg.run(['-i', dest, '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', ...intermediateArgs(), '-an', intermediate], { signal: ctx.signal });
      fs.rmSync(dest, { force: true });
    } else {
      const frames = files.filter(f => IMAGE_EXT.test(f.filename)).sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
      const dir = path.join(req.outDir, `frames-${req.segment || 0}`);
      fs.mkdirSync(dir, { recursive: true });
      let done = 0;
      const queue = frames.map((f, i) => ({ f, i }));
      const worker = async () => {
        while (queue.length) {
          const { f, i } = queue.shift();
          await client.download(f, path.join(dir, `f_${String(i + 1).padStart(6, '0')}${path.extname(f.filename).toLowerCase()}`), ctx.signal);
          done += 1;
          if (done % 8 === 0 || done === frames.length) ctx.stage('processing', done / frames.length, `Receiving frames ${done}/${frames.length}`);
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      const ext = path.extname(frames[0].filename).toLowerCase();
      ctx.stage('processing', 1, 'Assembling frames');
      await ffmpeg.run(['-framerate', String(fps), '-i', path.join(dir, `f_%06d${ext}`), '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
        ...intermediateArgs(), '-an', intermediate], { signal: ctx.signal, durationSec: frames.length / fps });
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const info = await ffmpeg.probe(intermediate);
    return { video: intermediate, width: info.width, height: info.height, fps, frames: info.frames, model: req.engine.label, gpu: d.gpu };
  }
}

/** Near-lossless, very fast intermediate encode; the final encode happens once, later. */
function intermediateArgs() {
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv444p'];
}

module.exports = { LocalComfyUIProvider, intermediateArgs, OFFLINE_MESSAGE };
