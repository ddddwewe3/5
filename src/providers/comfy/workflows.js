'use strict';
const fs = require('fs');
const path = require('path');
const { WORKFLOWS_DIR } = require('../../config');
const { AppError } = require('../../errors');

/**
 * Builds ComfyUI API-format workflows (the JSON that POST /prompt expects) for the supported
 * open-source model families. Only core ComfyUI nodes are used — no custom nodes required.
 * Frames are returned through PreviewImage (lossless PNG in ComfyUI's temp dir, auto-cleaned)
 * and encoded by our own FFmpeg pipeline.
 */

// Node class → progress stage, used to translate ComfyUI's "executing" events.
const NODE_STAGE = {
  CheckpointLoaderSimple: 'loading_model', UNETLoader: 'loading_model', CLIPLoader: 'loading_model',
  VAELoader: 'loading_model', CLIPVisionLoader: 'loading_model', DualCLIPLoader: 'loading_model',
  CLIPTextEncode: 'loading_model', LoadImage: 'loading_model', LTXVPreprocess: 'loading_model',
  CLIPVisionEncode: 'loading_model', LTXVImgToVideo: 'loading_model', WanImageToVideo: 'loading_model',
  Wan22ImageToVideoLatent: 'loading_model',
  KSampler: 'generating', KSamplerAdvanced: 'generating', SamplerCustom: 'generating', SamplerCustomAdvanced: 'generating',
  VAEDecode: 'processing', VAEDecodeTiled: 'processing', PreviewImage: 'processing', SaveImage: 'processing',
  CreateVideo: 'processing', SaveVideo: 'processing', VHS_VideoCombine: 'processing',
};

function decodeNode(samples, vae, tiled) {
  return tiled
    ? { class_type: 'VAEDecodeTiled', inputs: { samples, vae, tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } }
    : { class_type: 'VAEDecode', inputs: { samples, vae } };
}

function ltxv({ engine, mode, prompt, negativePrompt, imageName, width, height, frames, fps, steps, cfg, seed, tiledDecode, hasPreprocess }) {
  const wf = {
    1: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: engine.files.checkpoint } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: engine.files.textEncoder, type: 'ltxv', device: 'default' } },
    3: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt, clip: ['2', 0] } },
  };
  let pos = ['3', 0];
  let neg = ['4', 0];
  let latent;
  if (mode === 'i2v') {
    wf[10] = { class_type: 'LoadImage', inputs: { image: imageName } };
    let image = ['10', 0];
    if (hasPreprocess) {
      // Adds the mild compression LTX-Video was trained on; improves motion from still images.
      wf[11] = { class_type: 'LTXVPreprocess', inputs: { image, img_compression: 35 } };
      image = ['11', 0];
    }
    wf[12] = { class_type: 'LTXVImgToVideo', inputs: { positive: pos, negative: neg, vae: ['1', 2], image, width, height, length: frames, batch_size: 1, strength: 1.0 } };
    pos = ['12', 0];
    neg = ['12', 1];
    latent = ['12', 2];
  } else {
    wf[6] = { class_type: 'EmptyLTXVLatentVideo', inputs: { width, height, length: frames, batch_size: 1 } };
    latent = ['6', 0];
  }
  wf[5] = { class_type: 'LTXVConditioning', inputs: { positive: pos, negative: neg, frame_rate: fps } };
  wf[7] = { class_type: 'LTXVScheduler', inputs: { steps, max_shift: 2.05, base_shift: 0.95, stretch: true, terminal: 0.1, latent } };
  wf[8] = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } };
  wf[9] = { class_type: 'SamplerCustom', inputs: {
    model: ['1', 0], add_noise: true, noise_seed: seed, cfg, positive: ['5', 0], negative: ['5', 1],
    sampler: ['8', 0], sigmas: ['7', 0], latent_image: latent,
  } };
  wf[13] = decodeNode(['9', 0], ['1', 2], tiledDecode);
  wf[14] = { class_type: 'PreviewImage', inputs: { images: ['13', 0] } };
  return { workflow: wf, outputNode: '14' };
}

function wan({ engine, mode, prompt, negativePrompt, imageName, width, height, frames, steps, cfg, shift, seed, tiledDecode }) {
  const wf = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: engine.files.unet, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: engine.files.textEncoder, type: 'wan', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: engine.files.vae } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: negativePrompt, clip: ['2', 0] } },
    6: { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: shift || 8 } },
  };
  let pos = ['4', 0];
  let neg = ['5', 0];
  let latent;
  if (engine.family === 'wan22') {
    const inputs = { vae: ['3', 0], width, height, length: frames, batch_size: 1 };
    if (mode === 'i2v') {
      wf[10] = { class_type: 'LoadImage', inputs: { image: imageName } };
      inputs.start_image = ['10', 0];
    }
    wf[7] = { class_type: 'Wan22ImageToVideoLatent', inputs };
    latent = ['7', 0];
  } else if (mode === 'i2v') {
    wf[10] = { class_type: 'LoadImage', inputs: { image: imageName } };
    wf[11] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: engine.files.clipVision } };
    wf[12] = { class_type: 'CLIPVisionEncode', inputs: { clip_vision: ['11', 0], image: ['10', 0], crop: 'none' } };
    wf[7] = { class_type: 'WanImageToVideo', inputs: {
      positive: pos, negative: neg, vae: ['3', 0], width, height, length: frames, batch_size: 1,
      clip_vision_output: ['12', 0], start_image: ['10', 0],
    } };
    pos = ['7', 0];
    neg = ['7', 1];
    latent = ['7', 2];
  } else {
    wf[7] = { class_type: 'EmptyHunyuanLatentVideo', inputs: { width, height, length: frames, batch_size: 1 } };
    latent = ['7', 0];
  }
  wf[8] = { class_type: 'KSampler', inputs: {
    model: ['6', 0], seed, steps, cfg, sampler_name: 'uni_pc', scheduler: 'simple',
    positive: pos, negative: neg, latent_image: latent, denoise: 1,
  } };
  wf[9] = decodeNode(['8', 0], ['3', 0], tiledDecode);
  wf[13] = { class_type: 'PreviewImage', inputs: { images: ['9', 0] } };
  return { workflow: wf, outputNode: '13' };
}

// ── Custom workflows ─────────────────────────────────────────────────────────────
// Drop any ComfyUI workflow exported with "Save (API Format)" into ./workflows/*.json and use these
// placeholders as input values: {{PROMPT}} {{NEGATIVE}} {{WIDTH}} {{HEIGHT}} {{FRAMES}} {{FPS}}
// {{SEED}} {{STEPS}} {{CFG}} {{IMAGE}}. Optional "_openreel": { fps, frameStep, sizeStep, maxFrames }.
const PLACEHOLDER_RE = /\{\{(PROMPT|NEGATIVE|WIDTH|HEIGHT|FRAMES|FPS|SEED|STEPS|CFG|IMAGE)\}\}/g;

function listCustom() {
  if (!fs.existsSync(WORKFLOWS_DIR)) return [];
  const out = [];
  for (const file of fs.readdirSync(WORKFLOWS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const text = fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf8');
      const json = JSON.parse(text);
      if (json.nodes && json.links) continue; // UI-format workflow, not API format
      const meta = json._openreel || {};
      const needsImage = text.includes('{{IMAGE}}');
      out.push({
        id: `custom:${file}`,
        label: meta.label || `Custom: ${file.replace(/\.json$/, '')}`,
        family: 'custom',
        file,
        t2v: !needsImage,
        i2v: needsImage,
        overrides: {
          ...(meta.fps ? { fps: meta.fps } : {}),
          ...(meta.frameStep ? { frameStep: meta.frameStep } : {}),
          ...(meta.maxFrames ? { maxFrames: meta.maxFrames } : {}),
        },
      });
    } catch {
      /* ignore unreadable files */
    }
  }
  return out;
}

function custom({ engine, prompt, negativePrompt, imageName, width, height, frames, fps, steps, cfg, seed }) {
  const file = path.join(WORKFLOWS_DIR, engine.file);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new AppError('INVALID_INPUT', `Custom workflow ${engine.file} could not be read`, { details: err.message });
  }
  delete json._openreel;
  const values = { PROMPT: prompt, NEGATIVE: negativePrompt, WIDTH: width, HEIGHT: height, FRAMES: frames, FPS: fps,
    SEED: seed, STEPS: steps, CFG: cfg, IMAGE: imageName || '' };
  const fill = v => {
    if (typeof v === 'string') {
      const whole = v.match(/^\{\{(\w+)\}\}$/);
      if (whole && whole[1] in values) return values[whole[1]]; // keeps numbers numeric
      return v.replace(PLACEHOLDER_RE, (_, k) => String(values[k]));
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  const workflow = fill(json);
  const outputNode = Object.keys(workflow).find(id => ['PreviewImage', 'SaveImage', 'SaveVideo', 'VHS_VideoCombine', 'SaveAnimatedWEBP']
    .includes(workflow[id].class_type));
  return { workflow, outputNode: outputNode || null };
}

function build(params) {
  switch (params.engine.family) {
    case 'ltxv': return ltxv(params);
    case 'wan':
    case 'wan22': return wan(params);
    case 'custom': return custom(params);
    default: throw new AppError('INVALID_INPUT', `Unknown model family ${params.engine.family}`);
  }
}

module.exports = { build, listCustom, NODE_STAGE };
