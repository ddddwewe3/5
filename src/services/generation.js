'use strict';
const fs = require('fs');
const path = require('path');
const { JobQueue, STAGES } = require('../queue/jobQueue');
const projects = require('../store/projects');
const uploads = require('../store/uploads');
const settings = require('../store/settings');
const providers = require('../providers');
const families = require('../providers/families');
const ffmpeg = require('../media/ffmpeg');
const renderer = require('../media/render');
const { enhance } = require('../prompt/enhancer');
const events = require('../events');
const { AppError } = require('../errors');
const { DATA_DIR } = require('../config');
const { newId, randomSeed, readJson, writeJsonAtomic, clamp } = require('../util');
const log = require('../logger').createLogger('generation');

const queue = new JobQueue({ gpu: 1, cpu: 2 });
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const stats = readJson(STATS_FILE, {});
const ASPECTS = ['16:9', '9:16', '1:1'];
const DURATIONS = [3, 5, 8, 10];

// ── Mirror job state into the project records + push it to browsers ─────────────────────────────
queue.on('update', snap => {
  events.broadcast('job', snap);
  const { projectId, sceneId, takeId, renderId } = snap.meta || {};
  if (!projectId) return;
  const terminal = ['completed', 'failed', 'cancelled'].includes(snap.status);
  try {
    projects.update(projectId, p => {
      let rec = null;
      if (takeId) {
        const scene = p.scenes.find(s => s.id === sceneId);
        rec = scene && scene.takes.find(t => t.id === takeId);
      } else if (renderId) {
        rec = p.renders.find(r => r.id === renderId);
      }
      if (!rec) return;
      Object.assign(rec, {
        status: snap.status === 'completed' ? 'complete' : snap.status,
        stage: snap.stage,
        progress: snap.progress,
        message: snap.message,
        etaSec: snap.etaSec,
        elapsedSec: snap.elapsedSec,
        error: snap.error,
        logs: snap.logs.slice(-25),
      });
      if (terminal) rec.finishedAt = new Date().toISOString();
    }, { immediate: terminal, silent: !terminal && snap.stage !== 'queued' });
  } catch {
    /* project deleted while the job was running */
  }
});

function recordStats(key, totalSec, perStep) {
  const prev = stats[key] || { count: 0 };
  const a = prev.count ? 0.5 : 1;
  stats[key] = {
    count: prev.count + 1,
    totalSec: Math.round(((prev.totalSec || totalSec) * (1 - a) + totalSec * a) * 10) / 10,
    perStepSec: perStep ? Math.round(((prev.perStepSec || perStep) * (1 - a) + perStep * a) * 1000) / 1000 : prev.perStepSec,
    updatedAt: new Date().toISOString(),
  };
  try { writeJsonAtomic(STATS_FILE, stats); } catch { /* non-critical */ }
}

/**
 * Converts provider callbacks into one monotonic progress bar with honest stages and an ETA that
 * is measured from real step timings (not guessed).
 */
function progressTracker(ctx, { segments, statsKey }) {
  const start = Date.now();
  let seg = 0;
  let stageIdx = 0;
  let firstStepAt = null;
  let genStartedAt = null; // first sampler step: excludes one-time model download/loading
  let firstStep = 0;
  let perStep = stats[statsKey] && stats[statsKey].perStepSec;
  let lastSteps = { step: 0, total: 0 };
  const band = 0.8 / segments;
  const prefix = () => (segments > 1 ? `Segment ${seg + 1}/${segments} · ` : '');
  const postEstimate = () => Math.max(3, (perStep || 1) * 3);
  const estimateFromHistory = () => {
    const h = stats[statsKey];
    return h ? Math.max(1, h.totalSec - (Date.now() - start) / 1000) : null;
  };
  const push = (stage, progress, message, extra = {}) => {
    const idx = STAGES.indexOf(stage);
    if (idx > stageIdx) stageIdx = idx;
    ctx.update({ stage: STAGES[stageIdx], progress: clamp(progress, 0, 0.995), message, ...extra });
  };
  return {
    setSegment(i) {
      seg = i;
      firstStepAt = null;
    },
    stage(stage, frac = 0, message = '') {
      const f = clamp(frac || 0, 0, 1);
      let p;
      if (stage === 'queued') p = 0;
      else if (stage === 'loading_model') p = seg === 0 ? 0.02 + 0.06 * f : 0.1 + seg * band;
      else if (stage === 'generating') p = 0.1 + seg * band + band * 0.85 * (lastSteps.total ? lastSteps.step / lastSteps.total : 0);
      else if (stage === 'processing') p = 0.1 + seg * band + band * (0.85 + 0.15 * f);
      else p = 0.9 + 0.09 * f;
      const eta = stage === 'encoding' ? null : (perStep && lastSteps.total ? undefined : estimateFromHistory());
      push(stage, p, `${prefix()}${message}`, eta !== undefined ? { etaSec: eta } : {});
    },
    step(step, total) {
      const now = Date.now();
      if (!genStartedAt) genStartedAt = now;
      if (!firstStepAt || step <= firstStep) {
        firstStepAt = now;
        firstStep = step;
      } else {
        perStep = (now - firstStepAt) / 1000 / (step - firstStep);
      }
      lastSteps = { step, total };
      const remainingSteps = (total - step) + (segments - seg - 1) * total;
      const etaSec = perStep ? Math.round(remainingSteps * perStep + postEstimate() * (segments - seg)) : estimateFromHistory();
      push('generating', 0.1 + seg * band + band * 0.85 * (step / total), `${prefix()}Generating · step ${step}/${total}`,
        { step, totalSteps: total, etaSec, genElapsedSec: (now - genStartedAt) / 1000, loadSec: (genStartedAt - start) / 1000 });
    },
    encoding(frac, message) {
      push('encoding', 0.9 + 0.09 * clamp(frac, 0, 1), message, { etaSec: null });
    },
    perStep: () => perStep,
    elapsed: () => (Date.now() - start) / 1000,
  };
}

function sourceImagePath(project, scene) {
  const src = scene.sourceImage;
  if (!src) return null;
  if (src.type === 'upload') {
    const up = project.uploads.find(u => u.id === src.uploadId);
    return up ? path.join(projects.dirOf(project.id), 'uploads', up.file) : null;
  }
  if (src.type === 'lastFrame') {
    for (const s of project.scenes) {
      const t = s.takes.find(x => x.id === src.takeId);
      if (t && t.lastFrame) return projects.mediaPath(project.id, t.lastFrame);
    }
  }
  return null;
}

async function runTake(ctx, meta, state) {
  const { projectId, sceneId, takeId } = meta;
  const project = projects.get(projectId);
  const scene = projects.findScene(project, sceneId);
  const take = scene.takes.find(t => t.id === takeId);
  if (!take) throw new AppError('NOT_FOUND', 'Take was removed');
  const outDir = path.join(projects.dirOf(projectId), 'scenes', takeId);
  fs.mkdirSync(outDir, { recursive: true });

  ctx.update({ stage: 'queued', progress: 0, message: 'Selecting video engine' });
  let mode = scene.mode;
  const srcImage = sourceImagePath(project, scene);
  if (mode === 'i2v' && (!srcImage || !fs.existsSync(srcImage))) {
    throw new AppError('INVALID_INPUT', 'The reference image for this scene is missing.');
  }
  let resolved;
  try {
    resolved = await providers.resolve(mode);
  } catch (err) {
    // A continuation scene can still be generated text-only if no image-to-video model is installed.
    if (mode === 'i2v' && scene.sourceImage.type === 'lastFrame' && err.code === 'MODEL_MISSING') {
      resolved = await providers.resolve('t2v');
      mode = 't2v';
      ctx.log('No image-to-video model installed — continuing this scene from the prompt only (less consistent).');
    } else throw err;
  }
  const { provider, engine } = resolved;
  const plan = families.plan({
    family: engine.family, overrides: engine.overrides, aspectRatio: project.aspectRatio,
    durationSec: scene.duration, quality: state.quality, distilled: engine.distilled,
  });
  const seed = take.seed;
  const statsKey = `${provider.id}|${engine.id}|${plan.width}x${plan.height}|${plan.segments.join('+')}|${plan.steps}`;
  const tracker = progressTracker(ctx, { segments: plan.segments.length, statsKey });
  ctx.log(`Engine: ${provider.label} → ${engine.label}. Plan: ${plan.width}×${plan.height}, ${plan.segments.join('+')} frames @ ${plan.fps}fps, ` +
    `${plan.steps} steps, cfg ${plan.cfg}, quality ${plan.quality}, seed ${seed}`);
  projects.update(projectId, p => {
    const t = projects.findScene(p, sceneId).takes.find(x => x.id === takeId);
    Object.assign(t, { provider: provider.id, engine: engine.label, plan: { ...plan, negative: undefined }, modeUsed: mode });
  }, { silent: true });

  // Reference image → exact generation size, so every engine receives identical framing.
  let initImage = null;
  if (mode === 'i2v') {
    initImage = path.join(outDir, 'init.png');
    await ffmpeg.run(['-i', srcImage, '-frames:v', '1', '-vf', ffmpeg.fitFilter(plan.width, plan.height, 'crop'), initImage], { signal: ctx.signal });
  }

  const segmentFiles = [];
  let last = null;
  const t0 = Date.now();
  for (let i = 0; i < plan.segments.length; i++) {
    tracker.setSegment(i);
    const segMode = i === 0 ? mode : (engine.i2v ? 'i2v' : 't2v');
    let segImage = i === 0 ? initImage : null;
    if (i > 0 && segMode === 'i2v') {
      segImage = path.join(outDir, `seg-${i}-init.png`);
      await ffmpeg.extractFrame(last.video, segImage, 'last');
    }
    last = await provider.generate({
      jobId: ctx.job.id, segment: i, mode: segMode, prompt: scene.enhancedPrompt || scene.prompt,
      negativePrompt: scene.negativePrompt || plan.negative || '', imagePath: segImage,
      width: plan.width, height: plan.height, frames: plan.segments[i], fps: plan.fps,
      steps: plan.steps, cfg: plan.cfg, shift: plan.shift, seed: seed + i, outDir, engine,
      aspectRatio: project.aspectRatio, tiledDecode: state.tiledDecode,
    }, {
      signal: ctx.signal,
      stage: (stage, frac, message) => tracker.stage(stage, frac, message),
      step: (step, total) => tracker.step(step, total),
      log: message => ctx.log(message),
    });
    segmentFiles.push(last.video);
  }
  const genSec = (Date.now() - t0) / 1000;

  // ── ENCODING: one FFmpeg pass → final MP4 ──
  const s = settings.get();
  const size = ffmpeg.outputSize(project.aspectRatio, last.width, last.height, s.upscaleOutput);
  const totalFrames = plan.segments.reduce((a, n, i) => a + n - (i > 0 ? 1 : 0), 0);
  const finalPath = path.join(outDir, 'video.mp4');
  const encoder = ffmpeg.encoderArgs()[1];
  tracker.encoding(0, `Encoding MP4 ${size.width}×${size.height} (${encoder})`);
  const te = Date.now();
  await ffmpeg.finalizeSegments(segmentFiles, finalPath, {
    width: size.width, height: size.height, fps: plan.fps, signal: ctx.signal, totalDuration: totalFrames / plan.fps,
    onProgress: f => tracker.encoding(f * 0.9, `Encoding MP4 ${Math.round(f * 100)}%`),
  });
  const info = await ffmpeg.probe(finalPath);
  tracker.encoding(0.95, 'Creating preview images');
  const thumb = await ffmpeg.thumbnail(finalPath, path.join(outDir, 'thumb.jpg'), info.durationSec);
  const lastFrame = await ffmpeg.extractFrame(finalPath, path.join(outDir, 'last.png'), 'last');
  for (const f of fs.readdirSync(outDir)) {
    if (/^(segment-\d+\.mp4|seg-\d+-init\.png)$/.test(f)) fs.rmSync(path.join(outDir, f), { force: true });
  }
  const totalSec = tracker.elapsed();
  recordStats(statsKey, totalSec, tracker.perStep());
  const result = {
    video: projects.mediaUrl(projectId, path.relative(projects.dirOf(projectId), finalPath)),
    thumbnail: projects.mediaUrl(projectId, path.relative(projects.dirOf(projectId), thumb)),
    lastFrame: projects.mediaUrl(projectId, path.relative(projects.dirOf(projectId), lastFrame)),
    width: info.width, height: info.height, fps: plan.fps, frames: totalFrames, durationSec: info.durationSec,
    sizeBytes: info.sizeBytes, model: last.model, device: last.device || (last.gpu && last.gpu.name) || null,
    timings: { totalSec: Math.round(totalSec * 10) / 10, generateSec: Math.round(genSec * 10) / 10, encodeSec: Math.round((Date.now() - te) / 100) / 10 },
    encoder,
  };
  projects.update(projectId, p => {
    const t = projects.findScene(p, sceneId).takes.find(x => x.id === takeId);
    if (t) Object.assign(t, result, { completedAt: new Date().toISOString() });
    const sc = projects.findScene(p, sceneId);
    sc.activeTakeId = takeId;
    p.metadata.lastProvider = provider.id;
    p.metadata.lastEngine = engine.label;
  }, { immediate: true });
  ctx.log(`Done in ${result.timings.totalSec}s (generation ${result.timings.generateSec}s, encode ${result.timings.encodeSec}s) → ${info.width}×${info.height}, ${info.durationSec.toFixed(1)}s`);
  return result;
}

function enqueueTake(projectId, sceneId, takeId, quality) {
  const state = { quality, tiledDecode: false };
  const meta = { projectId, sceneId, takeId };
  const job = queue.enqueue({
    type: 'generate',
    lane: 'gpu',
    meta,
    run: ctx => runTake(ctx, meta, state),
    retry: {
      max: settings.get().autoRetry ? 1 : 0,
      // Only retry failures that can plausibly succeed on a second attempt.
      shouldRetry: err => ['GPU_OOM', 'WORKER_CRASHED', 'NETWORK_ERROR', 'COMFYUI_OFFLINE'].includes(err.code),
      onRetry: err => {
        if (err.code === 'GPU_OOM') {
          state.quality = families.downgrade(state.quality);
          state.tiledDecode = true;
          return `lowering resolution to "${state.quality}" and using tiled decoding to fit GPU memory`;
        }
        return null;
      },
    },
  });
  projects.update(projectId, p => {
    const t = projects.findScene(p, sceneId).takes.find(x => x.id === takeId);
    t.jobId = job.id;
  }, { immediate: true });
  return job;
}

function newTake({ seed, quality }) {
  return {
    id: newId('tk'), jobId: null, seed: Number.isInteger(seed) && seed > 0 ? seed : randomSeed(), quality,
    status: 'queued', stage: 'queued', progress: 0, message: 'Waiting in queue', createdAt: new Date().toISOString(),
  };
}

function attachUpload(project, uploadId) {
  const up = uploads.get(uploadId);
  if (!up) throw new AppError('INVALID_INPUT', 'The uploaded file was not found — please upload it again.');
  if (!project.uploads.find(u => u.id === up.id)) {
    fs.copyFileSync(uploads.filePath(up.id), path.join(projects.dirOf(project.id), 'uploads', up.file));
    project.uploads.push({ ...up, url: projects.mediaUrl(project.id, `uploads/${up.file}`) });
  }
  return up;
}

function validateCommon(body) {
  const aspectRatio = ASPECTS.includes(body.aspectRatio) ? body.aspectRatio : '16:9';
  const duration = DURATIONS.includes(Number(body.duration)) ? Number(body.duration) : 5;
  const quality = ['fast', 'balanced', 'quality'].includes(body.quality) ? body.quality : settings.get().defaultQuality;
  return { aspectRatio, duration, quality };
}

// ── Public API ─────────────────────────────────────────────────────────────────────────────

async function generate(body) {
  const prompt = String(body.prompt || '').trim().slice(0, 2000);
  const imageId = body.imageId ? String(body.imageId) : null;
  let mode = body.mode === 'i2v' ? 'i2v' : 't2v';
  if (imageId) mode = 'i2v';
  if (mode === 'i2v' && !imageId) throw new AppError('INVALID_INPUT', 'Image-to-Video needs an image — upload one or switch to Text-to-Video.');
  if (!prompt && mode === 't2v') throw new AppError('INVALID_INPUT', 'Please describe the video you want to create.');
  if (imageId && (!uploads.get(imageId) || uploads.get(imageId).kind !== 'image')) throw new AppError('INVALID_INPUT', 'The uploaded image was not found — please upload it again.');
  const { aspectRatio, duration, quality } = validateCommon(body);
  const enhanceEnabled = body.enhance !== false && settings.get().enhancePrompts;
  const enhanced = await enhance({ prompt: prompt || 'the scene comes to life with subtle, natural motion', mode, aspectRatio, duration, hasImage: Boolean(imageId), enabled: enhanceEnabled });

  let project;
  if (body.projectId) {
    project = projects.get(String(body.projectId));
  } else {
    const name = (prompt || 'Image animation').split(/\s+/).slice(0, 7).join(' ');
    project = projects.create({ name: name.length > 60 ? `${name.slice(0, 57)}…` : name, prompt, mode, aspectRatio, duration, quality, styleBible: enhanced.styleBible });
  }
  const take = newTake({ seed: Number(body.seed), quality });
  const sceneId = newId('scn');
  projects.update(project.id, p => {
    const sourceImage = imageId ? { type: 'upload', uploadId: attachUpload(p, imageId).id } : null;
    p.scenes.push({
      id: sceneId, index: p.scenes.length + 1, prompt, enhancedPrompt: enhanced.prompt, structured: enhanced.structured,
      promptEngine: enhanced.engine, negativePrompt: body.negativePrompt ? String(body.negativePrompt).slice(0, 1000) : null,
      mode, sourceImage, duration, activeTakeId: take.id, takes: [take], trim: { start: 0, end: null }, speed: 1,
      createdAt: new Date().toISOString(),
    });
    if (!p.styleBible) p.styleBible = enhanced.styleBible;
  }, { immediate: true });
  const job = enqueueTake(project.id, sceneId, take.id, quality);
  return { projectId: project.id, sceneId, takeId: take.id, jobId: job.id, enhancedPrompt: enhanced.prompt, promptNote: enhanced.note };
}

async function extend(body) {
  const project = projects.get(String(body.projectId));
  const fromScene = body.sceneId ? projects.findScene(project, String(body.sceneId)) : project.scenes[project.scenes.length - 1];
  if (!fromScene) throw new AppError('INVALID_INPUT', 'There is no scene to extend yet.');
  const fromTake = projects.activeTake(fromScene);
  if (!fromTake || fromTake.status !== 'complete' || !fromTake.lastFrame) {
    throw new AppError('INVALID_INPUT', 'Wait until the scene has finished generating before extending it.');
  }
  const prompt = String(body.prompt || '').trim().slice(0, 2000);
  const duration = DURATIONS.includes(Number(body.duration)) ? Number(body.duration) : fromScene.duration;
  const quality = ['fast', 'balanced', 'quality'].includes(body.quality) ? body.quality : project.quality;
  const enhanced = await enhance({
    prompt: prompt || 'the action continues naturally', mode: 'i2v', aspectRatio: project.aspectRatio, duration,
    styleBible: project.styleBible || null, hasImage: true, enabled: settings.get().enhancePrompts,
  });
  const take = newTake({ seed: fromTake.seed + 1000, quality });
  const sceneId = newId('scn');
  projects.update(project.id, p => {
    const at = p.scenes.findIndex(s => s.id === fromScene.id) + 1;
    p.scenes.splice(at, 0, {
      id: sceneId, index: 0, prompt: prompt || 'Continue the scene', enhancedPrompt: enhanced.prompt, structured: enhanced.structured,
      promptEngine: enhanced.engine, negativePrompt: fromScene.negativePrompt, mode: 'i2v',
      sourceImage: { type: 'lastFrame', takeId: fromTake.id, sceneId: fromScene.id }, duration,
      activeTakeId: take.id, takes: [take], trim: { start: 0, end: null }, speed: 1, extendedFrom: fromScene.id,
      createdAt: new Date().toISOString(),
    });
    p.scenes.forEach((s, i) => { s.index = i + 1; });
  }, { immediate: true });
  const job = enqueueTake(project.id, sceneId, take.id, quality);
  return { projectId: project.id, sceneId, takeId: take.id, jobId: job.id, enhancedPrompt: enhanced.prompt, promptNote: enhanced.note };
}

async function regenerate(body) {
  const project = projects.get(String(body.projectId));
  const scene = projects.findScene(project, String(body.sceneId));
  if (scene.takes.some(t => ['queued', 'running'].includes(t.status))) {
    throw new AppError('INVALID_INPUT', 'This scene is already generating — wait for it or cancel it first.');
  }
  if (body.prompt !== undefined && String(body.prompt).trim() && String(body.prompt).trim() !== scene.prompt) {
    const enhanced = await enhance({
      prompt: String(body.prompt).trim().slice(0, 2000), mode: scene.mode, aspectRatio: project.aspectRatio, duration: scene.duration,
      styleBible: scene.extendedFrom ? project.styleBible : null, hasImage: scene.mode === 'i2v', enabled: settings.get().enhancePrompts,
    });
    projects.update(project.id, p => {
      const s = projects.findScene(p, scene.id);
      Object.assign(s, { prompt: String(body.prompt).trim(), enhancedPrompt: enhanced.prompt, structured: enhanced.structured });
    });
  }
  const quality = ['fast', 'balanced', 'quality'].includes(body.quality) ? body.quality : (projects.activeTake(scene) || {}).quality || project.quality;
  const take = newTake({ seed: Number(body.seed), quality });
  projects.update(project.id, p => {
    const s = projects.findScene(p, scene.id);
    s.takes.push(take);
    s.activeTakeId = take.id;
  }, { immediate: true });
  const job = enqueueTake(project.id, scene.id, take.id, quality);
  return { projectId: project.id, sceneId: scene.id, takeId: take.id, jobId: job.id };
}

function defaultClips(project) {
  return project.scenes
    .map(s => ({ scene: s, take: projects.activeTake(s) }))
    .filter(({ take }) => take && take.status === 'complete')
    .map(({ scene, take }) => ({ takeId: take.id, trimStart: scene.trim ? scene.trim.start : 0, trimEnd: scene.trim ? scene.trim.end : null, speed: scene.speed || 1 }));
}

function startRender(body) {
  const project = projects.get(String(body.projectId));
  const raw = { ...(body.spec || {}) };
  if (!Array.isArray(raw.clips) || !raw.clips.length) raw.clips = defaultClips(project);
  if (!raw.aspectRatio) raw.aspectRatio = project.aspectRatio;
  const spec = renderer.normalizeSpec(raw);
  if (!spec.clips.length) throw new AppError('INVALID_INPUT', 'Generate at least one scene before rendering the final video.');
  for (const c of spec.clips) {
    const hit = projects.findMedia(c.takeId);
    if (!hit || hit.project.id !== project.id || !hit.take || hit.take.status !== 'complete') {
      throw new AppError('INVALID_INPUT', 'One of the selected scenes is not finished yet.');
    }
  }
  for (const id of [spec.music && spec.music.uploadId, spec.voice && spec.voice.uploadId].filter(Boolean)) {
    const up = uploads.get(id);
    if (!up || up.kind !== 'audio') throw new AppError('INVALID_INPUT', 'Uploaded audio file not found — please upload it again.');
    projects.update(project.id, p => attachUpload(p, id), { silent: true });
  }
  const renderId = newId('rnd');
  projects.update(project.id, p => {
    p.renders.push({ id: renderId, jobId: null, status: 'queued', stage: 'queued', progress: 0, spec, createdAt: new Date().toISOString() });
  }, { immediate: true });
  const meta = { projectId: project.id, renderId };
  const job = queue.enqueue({
    type: 'render',
    lane: 'cpu',
    meta,
    run: async ctx => {
      const outDir = path.join(projects.dirOf(project.id), 'renders', renderId);
      const res = await renderer.render({
        spec, outDir, signal: ctx.signal,
        update: u => ctx.update({ ...u, progress: u.progress }),
        resolveMedia: (kind, id) => {
          if (kind === 'take') {
            const hit = projects.findMedia(id);
            return hit && hit.take ? projects.mediaPath(hit.project.id, hit.take.video) : null;
          }
          const p = projects.get(project.id);
          const up = p.uploads.find(u => u.id === id);
          return up ? path.join(projects.dirOf(project.id), 'uploads', up.file) : uploads.filePath(id);
        },
      });
      const rel = f => projects.mediaUrl(project.id, path.relative(projects.dirOf(project.id), f));
      const result = {
        video: rel(res.output), thumbnail: rel(res.thumbnail), width: res.width, height: res.height, fps: res.fps,
        durationSec: res.durationSec, sizeBytes: res.sizeBytes, voice: res.voice,
        subtitles: res.subtitles ? { ass: rel(path.join(outDir, res.subtitles.ass)), srt: rel(path.join(outDir, res.subtitles.srt)) } : null,
      };
      projects.update(project.id, p => {
        const r = p.renders.find(x => x.id === renderId);
        if (r) Object.assign(r, result, { completedAt: new Date().toISOString() });
        p.finalRenderId = renderId;
      }, { immediate: true });
      ctx.log(`Final video ${res.width}×${res.height}, ${res.durationSec.toFixed(1)}s`);
      return result;
    },
    retry: { max: 0 },
  });
  projects.update(project.id, p => { p.renders.find(r => r.id === renderId).jobId = job.id; }, { immediate: true });
  return { projectId: project.id, renderId, jobId: job.id };
}

/** Cancels by job id, take id or render id. */
function cancel(id) {
  let jobId = id;
  if (!queue.get(id)) {
    const hit = projects.findMedia(id);
    jobId = hit && (hit.take ? hit.take.jobId : hit.render.jobId);
  }
  if (!jobId || !queue.get(jobId)) throw new AppError('NOT_FOUND', 'No running job with that id');
  return queue.cancel(jobId);
}

function status(id) {
  const job = queue.get(id);
  if (job) return queue.snapshot(job);
  const hit = projects.findMedia(id);
  const rec = hit && (hit.take || hit.render);
  if (!rec) throw new AppError('NOT_FOUND', 'Unknown job id');
  const live = rec.jobId && queue.get(rec.jobId);
  if (live) return queue.snapshot(live);
  return { id: rec.jobId || id, status: rec.status === 'complete' ? 'completed' : rec.status, stage: rec.stage, progress: rec.progress,
    message: rec.message, error: rec.error || null, meta: { projectId: hit.project.id, sceneId: hit.scene && hit.scene.id, takeId: hit.take && hit.take.id, renderId: hit.render && hit.render.id } };
}

function projectWithJobs(id) {
  const project = projects.get(id);
  const jobs = {};
  for (const s of project.scenes) for (const t of s.takes) if (t.jobId && queue.get(t.jobId)) jobs[t.jobId] = queue.snapshot(queue.get(t.jobId));
  for (const r of project.renders) if (r.jobId && queue.get(r.jobId)) jobs[r.jobId] = queue.snapshot(queue.get(r.jobId));
  return { ...project, jobs };
}

function cancelProjectJobs(project) {
  for (const s of project.scenes) for (const t of s.takes) if (t.jobId && queue.get(t.jobId)) queue.cancel(t.jobId);
  for (const r of project.renders) if (r.jobId && queue.get(r.jobId)) queue.cancel(r.jobId);
}

module.exports = { queue, generate, extend, regenerate, startRender, cancel, status, projectWithJobs, cancelProjectJobs, stats };
