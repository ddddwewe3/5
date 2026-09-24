'use strict';
const fs = require('fs');
const path = require('path');
const { VideoProvider } = require('./VideoProvider');
const settings = require('../store/settings');
const ffmpeg = require('../media/ffmpeg');
const { AppError, classify } = require('../errors');
const { sleep } = require('../util');

/**
 * Optional hosted provider using a Replicate-compatible predictions API. It is OFF unless an API
 * token is configured, because hosted generation costs money per video. The app never depends on it.
 * Model-specific inputs can be added with the "externalExtraInput" JSON setting.
 */
class OptionalExternalProvider extends VideoProvider {
  constructor() {
    super('external', 'External API (optional, paid)', 'external');
  }

  config() {
    const s = settings.get();
    return { url: s.externalApiUrl, token: s.externalApiToken, model: s.externalModel, extra: s.externalExtraInput };
  }

  async api(pathOrUrl, { method = 'GET', json, signal, timeout = 30000 } = {}) {
    const { url, token } = this.config();
    const target = /^https?:/.test(pathOrUrl) ? pathOrUrl : `${url}${pathOrUrl}`;
    const signals = [AbortSignal.timeout(timeout)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await fetch(target, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
        body: json ? JSON.stringify(json) : undefined,
        signal: AbortSignal.any ? AbortSignal.any(signals) : signals[0],
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      throw classify(err, 'NETWORK_ERROR');
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { detail: text }; }
    if (!res.ok) {
      const detail = data.detail || data.error || text;
      if (res.status === 401 || res.status === 403) throw new AppError('PROVIDER_NOT_CONFIGURED', 'The external API rejected the token.', { details: String(detail) });
      if (res.status === 402) throw new AppError('PROVIDER_ERROR', 'The external API account has no credit left.', { details: String(detail), retryable: false });
      if (res.status === 422 || res.status === 400) throw new AppError('INVALID_INPUT', `The external model rejected the input: ${String(detail).slice(0, 200)}`, { details: String(detail) });
      throw new AppError('NETWORK_ERROR', `External API error (HTTP ${res.status})`, { details: String(detail), retryable: res.status >= 500 || res.status === 429 });
    }
    return data;
  }

  async health() {
    const { token, model, url } = this.config();
    const base = { id: this.id, label: this.label, kind: this.kind, model, url };
    if (!token) {
      return { ...base, available: false, status: 'not_configured',
        message: 'Optional. Disabled — add an API token in Settings to enable (paid per generation).' };
    }
    try {
      await this.api('/account', { timeout: 8000 });
      return { ...base, available: true, status: 'online', message: `Connected — model ${model}` };
    } catch (err) {
      return { ...base, available: false, status: 'error', message: err.message, details: err.details };
    }
  }

  async selectEngine(mode) {
    const { token, model } = this.config();
    if (!token) throw new AppError('PROVIDER_NOT_CONFIGURED', 'The external provider has no API token configured.');
    return { id: `external:${model}`, label: model, family: 'custom', t2v: true, i2v: true, model, overrides: { maxFrames: 10000 }, mode };
  }

  async generate(req, ctx) {
    const { model, extra } = this.config();
    const input = { prompt: req.prompt, seed: req.seed, aspect_ratio: req.aspectRatio };
    if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
    if (req.mode === 'i2v') input.image = `data:image/png;base64,${fs.readFileSync(req.imagePath).toString('base64')}`;
    if (extra) {
      try { Object.assign(input, JSON.parse(extra)); } catch { throw new AppError('INVALID_INPUT', 'External extra input is not valid JSON'); }
    }
    ctx.stage('queued', 0, 'Submitting to external API');
    const endpoint = model.includes(':') ? '/predictions' : `/models/${model}/predictions`;
    const body = model.includes(':') ? { version: model.split(':')[1], input } : { input };
    let prediction = await this.api(endpoint, { method: 'POST', json: body, signal: ctx.signal });
    const cancel = () => prediction.urls && prediction.urls.cancel && this.api(prediction.urls.cancel, { method: 'POST' }).catch(() => {});
    ctx.signal && ctx.signal.addEventListener('abort', cancel, { once: true });
    while (!['succeeded', 'failed', 'canceled'].includes(prediction.status)) {
      await sleep(2000, ctx.signal);
      prediction = await this.api(prediction.urls.get, { signal: ctx.signal });
      if (prediction.status === 'starting') ctx.stage('loading_model', 0, 'External model is starting');
      if (prediction.status === 'processing') {
        const logs = String(prediction.logs || '');
        const pct = [...logs.matchAll(/(\d{1,3})%\|/g)].pop();
        const frac = [...logs.matchAll(/\b(\d+)\/(\d+)\b/g)].pop();
        if (frac && Number(frac[2]) > 0) ctx.step(Number(frac[1]), Number(frac[2]));
        else ctx.stage('generating', pct ? Number(pct[1]) / 100 : 0, 'Generating on external API');
      }
    }
    if (prediction.status !== 'succeeded') {
      if (prediction.status === 'canceled') throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      throw new AppError('PROVIDER_ERROR', `External generation failed: ${String(prediction.error || 'unknown error').slice(0, 300)}`, { details: prediction.logs });
    }
    const outputs = [].concat(prediction.output || []).flatMap(o => (typeof o === 'string' ? [o] : Object.values(o || {})));
    const url = outputs.find(u => typeof u === 'string' && /^https?:/.test(u));
    if (!url) throw new AppError('PROVIDER_ERROR', 'External API returned no video URL', { details: JSON.stringify(prediction.output) });
    ctx.stage('processing', 0.5, 'Downloading result');
    const res = await fetch(url, { signal: ctx.signal });
    if (!res.ok) throw new AppError('NETWORK_ERROR', `Could not download the result (HTTP ${res.status})`);
    const raw = path.join(req.outDir, `external-${req.segment || 0}${path.extname(new URL(url).pathname) || '.mp4'}`);
    fs.writeFileSync(raw, Buffer.from(await res.arrayBuffer()));
    const out = path.join(req.outDir, `segment-${req.segment || 0}.mp4`);
    const { intermediateArgs } = require('./LocalComfyUIProvider');
    await ffmpeg.run(['-i', raw, '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', ...intermediateArgs(), '-an', out], { signal: ctx.signal });
    fs.rmSync(raw, { force: true });
    const info = await ffmpeg.probe(out);
    return { video: out, width: info.width, height: info.height, fps: info.fps, frames: info.frames, model };
  }
}

module.exports = { OptionalExternalProvider };
