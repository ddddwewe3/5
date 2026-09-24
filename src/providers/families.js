'use strict';

/**
 * Open-source video model families and their native constraints. Generation runs at these
 * (reduced) resolutions for speed; FFmpeg then crops to the exact aspect ratio and optionally
 * upscales to 720p during the final encode.
 */
const FAMILIES = {
  ltxv: {
    label: 'LTX-Video',
    fps: 24,
    frameStep: 8, // frames = 8k + 1
    sizeStep: 32,
    maxFrames: 257,
    sizes: {
      fast: { '16:9': [512, 288], '9:16': [288, 512], '1:1': [384, 384] },
      balanced: { '16:9': [768, 448], '9:16': [448, 768], '1:1': [512, 512] },
      quality: { '16:9': [1024, 576], '9:16': [576, 1024], '1:1': [768, 768] },
    },
    steps: { fast: 12, balanced: 25, quality: 40 }, // Fast = turbo: fewest steps that still give clean motion
    cfg: 3,
    distilled: { steps: { fast: 6, balanced: 8, quality: 10 }, cfg: 1 },
    negative: 'worst quality, low quality, blurry, jittery, distorted, deformed, disfigured, motion smear, motion artifacts, ' +
      'inconsistent motion, flicker, fused fingers, bad anatomy, extra limbs, watermark, text, logo, subtitles',
  },
  wan: {
    label: 'Wan 2.1',
    fps: 16,
    frameStep: 4,
    sizeStep: 16,
    maxFrames: 81,
    sizes: {
      fast: { '16:9': [640, 368], '9:16': [368, 640], '1:1': [480, 480] },
      balanced: { '16:9': [832, 480], '9:16': [480, 832], '1:1': [624, 624] },
      quality: { '16:9': [1280, 720], '9:16': [720, 1280], '1:1': [960, 960] },
    },
    steps: { fast: 14, balanced: 30, quality: 40 },
    cfg: 6,
    shift: 8,
    // Wan's recommended negative prompt (trained on Chinese captions) plus English equivalents.
    negative: '色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，' +
      '多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走, ' +
      'worst quality, blurry, static, watermark, text, deformed',
  },
  wan22: {
    label: 'Wan 2.2 TI2V',
    fps: 24,
    frameStep: 4,
    sizeStep: 32,
    maxFrames: 121,
    sizes: {
      fast: { '16:9': [832, 480], '9:16': [480, 832], '1:1': [640, 640] },
      balanced: { '16:9': [1024, 576], '9:16': [576, 1024], '1:1': [768, 768] },
      quality: { '16:9': [1280, 704], '9:16': [704, 1280], '1:1': [960, 960] },
    },
    steps: { fast: 12, balanced: 20, quality: 30 },
    cfg: 5,
    shift: 8,
    negative: null, // filled from wan below
  },
};
FAMILIES.wan22.negative = FAMILIES.wan.negative;
// Custom ComfyUI workflows default to LTX-like constraints unless their _openreel metadata overrides them.
FAMILIES.custom = { ...FAMILIES.ltxv, label: 'Custom workflow' };

function familyFromModelName(name) {
  const n = String(name || '').toLowerCase();
  if (/wan2\.?2|ti2v/.test(n)) return 'wan22';
  if (/wan/.test(n)) return 'wan';
  return 'ltxv';
}

function snapFrames(n, step) {
  return Math.max(step + 1, Math.round((n - 1) / step) * step + 1);
}

/**
 * Plans a generation: resolution, fps, sampler steps and how many segments are needed.
 * Durations longer than the model's native maximum are generated as consecutive segments, each
 * continuing from the previous segment's last frame (image-to-video), then joined.
 */
function plan({ family, overrides = {}, aspectRatio, durationSec, quality, distilled = false }) {
  const f = { ...(FAMILIES[family] || FAMILIES.ltxv), ...overrides };
  const q = ['fast', 'balanced', 'quality'].includes(quality) ? quality : 'balanced';
  const ar = ['16:9', '9:16', '1:1'].includes(aspectRatio) ? aspectRatio : '16:9';
  const [width, height] = f.sizes[q][ar];
  const needed = Math.max(f.frameStep + 1, Math.round(durationSec * f.fps) + 1);
  let segments;
  if (needed <= f.maxFrames) {
    segments = [snapFrames(needed, f.frameStep)];
  } else {
    const count = Math.ceil((needed - 1) / (f.maxFrames - 1));
    const per = Math.min(f.maxFrames, snapFrames(Math.ceil((needed - 1) / count) + 1, f.frameStep));
    segments = Array(count).fill(per);
  }
  const steps = distilled && f.distilled ? f.distilled.steps[q] : f.steps[q];
  const cfg = distilled && f.distilled ? f.distilled.cfg : f.cfg;
  return { family, width, height, fps: f.fps, segments, steps, cfg, shift: f.shift, negative: f.negative, quality: q };
}

/** A smaller plan used when retrying after a GPU out-of-memory error. */
function downgrade(quality) {
  return quality === 'quality' ? 'balanced' : 'fast';
}

module.exports = { FAMILIES, plan, downgrade, familyFromModelName, snapFrames };
