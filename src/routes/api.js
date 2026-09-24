'use strict';
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const generation = require('../services/generation');
const projects = require('../store/projects');
const uploads = require('../store/uploads');
const settings = require('../store/settings');
const providers = require('../providers');
const workflows = require('../providers/comfy/workflows');
const { ComfyClient } = require('../providers/comfy/client');
const ffmpeg = require('../media/ffmpeg');
const tts = require('../tts');
const events = require('../events');
const logger = require('../logger');
const { enhance } = require('../prompt/enhancer');
const { TEMPLATES } = require('../templates');
const { AppError, toClient } = require('../errors');
const { TMP_DIR } = require('../config');
const { newId, isId, slug } = require('../util');
const pkg = require('../../package.json');

const log = logger.createLogger('api');
const router = express.Router();
const upload = multer({ dest: TMP_DIR, limits: { fileSize: 200 * 1024 * 1024, files: 1 } });

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Video ───────────────────────────────────────────────────────────────────────────────────
router.post('/video/generate', wrap(async (req, res) => {
  res.status(202).json(await generation.generate(req.body || {}));
}));

router.post('/video/extend', wrap(async (req, res) => {
  res.status(202).json(await generation.extend(req.body || {}));
}));

router.post('/video/regenerate', wrap(async (req, res) => {
  res.status(202).json(await generation.regenerate(req.body || {}));
}));

router.get('/video/status/:id', (req, res, next) => {
  try {
    if (req.query.stream === undefined) return res.json(generation.status(req.params.id));
    // Live stream of a single job's progress (Server-Sent Events).
    const first = generation.status(req.params.id);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`event: job\ndata: ${JSON.stringify(first)}\n\n`);
    const jobId = first.id;
    const onUpdate = snap => {
      if (snap.id !== jobId) return;
      res.write(`event: job\ndata: ${JSON.stringify(snap)}\n\n`);
      if (['completed', 'failed', 'cancelled'].includes(snap.status)) res.end();
    };
    generation.queue.on('update', onUpdate);
    req.on('close', () => generation.queue.off('update', onUpdate));
    if (['completed', 'failed', 'cancelled'].includes(first.status)) res.end();
  } catch (err) {
    next(err);
  }
});

router.post('/video/cancel/:id', (req, res) => {
  res.json(generation.cancel(req.params.id));
});

router.post('/video/upload', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new AppError('INVALID_INPUT', 'No file received (form field name must be "file").');
  const entry = await uploads.add(req.file.path, req.file.originalname);
  res.status(201).json(entry);
}));

router.post('/video/render', wrap(async (req, res) => {
  res.status(202).json(generation.startRender(req.body || {}));
}));

function mediaInfo(id) {
  const hit = projects.findMedia(id);
  if (!hit) throw new AppError('NOT_FOUND', 'Video not found');
  const rec = hit.take || hit.render;
  return {
    id,
    kind: hit.take ? 'scene' : 'final',
    projectId: hit.project.id,
    projectName: hit.project.name,
    sceneId: hit.scene ? hit.scene.id : null,
    status: rec.status,
    url: rec.video || null,
    downloadUrl: rec.video ? `/api/video/${id}/download` : null,
    thumbnail: rec.thumbnail || null,
    width: rec.width, height: rec.height, fps: rec.fps, durationSec: rec.durationSec, sizeBytes: rec.sizeBytes,
    seed: rec.seed, provider: rec.provider, engine: rec.engine, timings: rec.timings,
    createdAt: rec.createdAt, completedAt: rec.completedAt, error: rec.error || null,
  };
}

router.get('/video/:id', (req, res) => {
  res.json(mediaInfo(req.params.id));
});

router.get('/video/:id/download', (req, res) => {
  const info = mediaInfo(req.params.id);
  if (!info.url) throw new AppError('NOT_FOUND', 'This video has not finished yet');
  const file = projects.mediaPath(info.projectId, info.url);
  if (!file || !fs.existsSync(file)) throw new AppError('NOT_FOUND', 'Video file is missing on disk');
  const name = `${slug(info.projectName)}-${info.kind === 'final' ? 'final' : `scene`}-${req.params.id.slice(-6)}.mp4`;
  res.download(file, name);
});

router.get('/video/:id/preview.webm', wrap(async (req, res) => {
  const info = mediaInfo(req.params.id);
  const file = info.url && projects.mediaPath(info.projectId, info.url);
  if (!file || !fs.existsSync(file)) throw new AppError('NOT_FOUND', 'Video not ready');
  res.sendFile(await ffmpeg.webmPreview(file));
}));

router.get('/videos', (req, res) => {
  res.json(projects.allVideos());
});

// ── Projects ────────────────────────────────────────────────────────────────────────────────
router.get('/projects', (req, res) => {
  res.json(projects.list());
});

router.get('/projects/:id', (req, res) => {
  res.json(generation.projectWithJobs(req.params.id));
});

router.patch('/projects/:id', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  if (!name) throw new AppError('INVALID_INPUT', 'Name cannot be empty');
  projects.update(req.params.id, p => { p.name = name; }, { immediate: true });
  res.json(projects.summary(projects.get(req.params.id)));
});

router.delete('/projects/:id', (req, res) => {
  const project = projects.get(req.params.id);
  generation.cancelProjectJobs(project);
  projects.remove(project.id);
  res.json({ ok: true });
});

router.patch('/projects/:id/scenes/:sceneId', (req, res) => {
  const b = req.body || {};
  projects.update(req.params.id, p => {
    const scene = projects.findScene(p, req.params.sceneId);
    if (b.activeTakeId) {
      const take = scene.takes.find(t => t.id === b.activeTakeId);
      if (!take) throw new AppError('NOT_FOUND', 'Take not found');
      scene.activeTakeId = take.id;
    }
    if (b.trimStart !== undefined || b.trimEnd !== undefined) {
      const start = Math.max(0, Number(b.trimStart) || 0);
      const end = b.trimEnd === null || b.trimEnd === '' || b.trimEnd === undefined ? null : Number(b.trimEnd);
      if (end !== null && (!Number.isFinite(end) || end <= start + 0.2)) throw new AppError('INVALID_INPUT', 'Trim end must be after trim start');
      scene.trim = { start, end };
    }
    if (b.speed !== undefined) {
      const speed = Number(b.speed);
      if (!(speed >= 0.25 && speed <= 4)) throw new AppError('INVALID_INPUT', 'Speed must be between 0.25× and 4×');
      scene.speed = speed;
    }
  }, { immediate: true });
  res.json(generation.projectWithJobs(req.params.id));
});

router.delete('/projects/:id/scenes/:sceneId', (req, res) => {
  const project = projects.get(req.params.id);
  const scene = projects.findScene(project, req.params.sceneId);
  for (const t of scene.takes) if (t.jobId && generation.queue.get(t.jobId)) generation.queue.cancel(t.jobId);
  projects.update(project.id, p => {
    p.scenes = p.scenes.filter(s => s.id !== scene.id);
    p.scenes.forEach((s, i) => { s.index = i + 1; });
  }, { immediate: true });
  for (const t of scene.takes) fs.rmSync(path.join(projects.dirOf(project.id), 'scenes', t.id), { recursive: true, force: true });
  res.json(generation.projectWithJobs(project.id));
});

router.post('/projects/:id/scenes/reorder', (req, res) => {
  const order = Array.isArray(req.body && req.body.order) ? req.body.order : [];
  projects.update(req.params.id, p => {
    if (order.length !== p.scenes.length || !order.every(id => p.scenes.some(s => s.id === id))) {
      throw new AppError('INVALID_INPUT', 'Order must list every scene exactly once');
    }
    p.scenes.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    p.scenes.forEach((s, i) => { s.index = i + 1; });
  }, { immediate: true });
  res.json(generation.projectWithJobs(req.params.id));
});

// ── Prompt / templates / TTS ────────────────────────────────────────────────────────────────
router.post('/prompt/enhance', wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await enhance({ prompt: String(b.prompt || '').slice(0, 2000), mode: b.mode === 'i2v' ? 'i2v' : 't2v',
    aspectRatio: b.aspectRatio || '16:9', duration: Number(b.duration) || 5, hasImage: Boolean(b.hasImage) }));
}));

router.get('/templates', (req, res) => {
  res.json(TEMPLATES);
});

router.get('/tts/voices', wrap(async (req, res) => {
  res.json(await tts.detectEngines(req.query.refresh !== undefined));
}));

router.post('/tts/preview', wrap(async (req, res) => {
  const b = req.body || {};
  const id = newId('tts');
  const out = path.join(TMP_DIR, `${id}.wav`);
  const result = await tts.synthesize({ text: String(b.text || '').slice(0, 1000), output: out, engine: b.engine, voice: b.voice, rate: b.rate });
  res.json({ url: `/tmp-media/${id}.wav`, durationSec: result.durationSec, engine: result.engine, voice: result.voice });
}));

// ── System / settings ───────────────────────────────────────────────────────────────────────
router.get('/system/status', wrap(async (req, res) => {
  const refresh = req.query.refresh !== undefined;
  const [health, ff, voices] = await Promise.all([providers.healthAll(refresh), ffmpeg.detect(refresh), tts.detectEngines(refresh)]);
  const s = settings.get();
  let active = null;
  if (s.provider === 'auto') active = health.comfyui.available ? 'comfyui' : health.local.available ? 'local' : null;
  else active = health[s.provider] && health[s.provider].available ? s.provider : null;
  res.json({
    app: { name: 'OpenReel Studio', version: pkg.version, node: process.version, platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length, ramGB: Math.round(os.totalmem() / 1e9) },
    providerSetting: s.provider,
    activeProvider: active,
    providers: health,
    ffmpeg: ff,
    tts: voices.map(e => ({ id: e.id, label: e.label, voices: e.voices.length })),
    queue: { running: generation.queue.list().filter(j => j.status === 'running').length, waiting: generation.queue.list().filter(j => j.status === 'queued').length },
  });
}));

router.get('/system/logs', (req, res) => {
  res.json(logger.recent({ limit: Math.min(1000, Number(req.query.limit) || 300), level: req.query.level }));
});

router.post('/system/comfyui/test', wrap(async (req, res) => {
  const url = String((req.body && req.body.url) || settings.get().comfyuiUrl).replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(url)) throw new AppError('INVALID_INPUT', 'Enter a valid URL such as http://127.0.0.1:8188');
  try {
    const stats = await new ComfyClient(url).systemStats();
    res.json({ ok: true, url, version: stats.system && stats.system.comfyui_version, devices: stats.devices });
  } catch (err) {
    res.json({ ok: false, url, message: 'ComfyUI is not running. Start ComfyUI to enable local AI video generation.', details: err.details || err.message });
  }
}));

// One-click FFmpeg install (portable build into tools/ffmpeg) + progress polling.
router.post('/system/ffmpeg/install', (req, res) => {
  res.status(202).json(require('../media/ffmpegInstaller').start());
});
router.get('/system/ffmpeg/install', (req, res) => {
  res.json(require('../media/ffmpegInstaller').status());
});

router.post('/system/preload', wrap(async (req, res) => {
  providers.get('local').preload();
  res.status(202).json({ ok: true });
}));

router.get('/settings', (req, res) => {
  res.json(settings.publicView());
});

router.put('/settings', (req, res) => {
  settings.update(req.body || {});
  res.json(settings.publicView());
});

// Exports the auto-generated ComfyUI workflow so it can be inspected/loaded in ComfyUI itself.
router.get('/comfyui/workflow', wrap(async (req, res) => {
  const mode = req.query.mode === 'i2v' ? 'i2v' : 't2v';
  const comfy = providers.get('comfyui');
  let engine;
  try {
    engine = await comfy.selectEngine(mode);
  } catch {
    const family = ['ltxv', 'wan', 'wan22'].includes(req.query.family) ? req.query.family : 'ltxv';
    engine = { family, label: family, files: { checkpoint: 'ltx-video-2b-v0.9.5.safetensors', textEncoder: family === 'ltxv' ? 't5xxl_fp8_e4m3fn_scaled.safetensors' : 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
      unet: family === 'wan22' ? 'wan2.2_ti2v_5B_fp16.safetensors' : 'wan2.1_t2v_1.3B_fp16.safetensors', vae: family === 'wan22' ? 'wan2.2_vae.safetensors' : 'wan_2.1_vae.safetensors', clipVision: 'clip_vision_h.safetensors' } };
  }
  const plan = require('../providers/families').plan({ family: engine.family, aspectRatio: '16:9', durationSec: 5, quality: 'fast', distilled: engine.distilled });
  const { workflow } = workflows.build({ engine, mode, prompt: '{{PROMPT}}', negativePrompt: plan.negative || '', imageName: 'example.png',
    width: plan.width, height: plan.height, frames: plan.segments[0], fps: plan.fps, steps: plan.steps, cfg: plan.cfg, shift: plan.shift, seed: 42, hasPreprocess: true });
  res.setHeader('Content-Disposition', `attachment; filename="openreel-${engine.family}-${mode}.json"`);
  res.json(workflow);
}));

router.get('/events', events.handler);

// ── Errors ──────────────────────────────────────────────────────────────────────────────────
router.use((req, res) => {
  res.status(404).json({ error: toClient(new AppError('NOT_FOUND', `No API route ${req.method} ${req.path}`)) });
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  let e = err;
  if (err instanceof multer.MulterError) {
    e = new AppError('INVALID_INPUT', err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 200 MB)' : err.message);
  } else if (err.type === 'entity.parse.failed') {
    e = new AppError('INVALID_INPUT', 'Request body is not valid JSON');
  } else if (!(err instanceof AppError) && err.status === 400) {
    e = new AppError('INVALID_INPUT', err.message);
  }
  const client = toClient(e);
  if (client.code !== 'NOT_FOUND' && client.code !== 'INVALID_INPUT') log.error(`${req.method} ${req.path} → [${client.code}] ${client.message}${client.details ? `\n${client.details}` : ''}`);
  else log.warn(`${req.method} ${req.path} → [${client.code}] ${client.message}`);
  res.status(e instanceof AppError ? e.status : 500).json({ error: client });
});

module.exports = { router, isId };
