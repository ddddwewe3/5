'use strict';
const { LocalComfyUIProvider } = require('./LocalComfyUIProvider');
const { LocalVideoModelProvider } = require('./LocalVideoModelProvider');
const { OptionalExternalProvider } = require('./OptionalExternalProvider');
const settings = require('../store/settings');
const { AppError } = require('../errors');

const providers = {
  comfyui: new LocalComfyUIProvider(),
  local: new LocalVideoModelProvider(),
  external: new OptionalExternalProvider(),
};

function get(id) {
  const p = providers[id];
  if (!p) throw new AppError('INVALID_INPUT', `Unknown provider ${id}`);
  return p;
}

/**
 * Picks the provider + engine for a generation. "auto" prefers ComfyUI (primary local engine),
 * then the local Python worker. The paid external provider is only used when chosen explicitly.
 */
async function resolve(mode, preferred) {
  const choice = preferred || settings.get().provider || 'auto';
  if (choice !== 'auto') {
    const provider = get(choice);
    return { provider, engine: await provider.selectEngine(mode) };
  }
  const problems = [];
  let comfyError = null;
  for (const id of ['comfyui', 'local']) {
    const provider = providers[id];
    try {
      if (id === 'local') {
        const info = await provider.probe();
        if (!info.ok) throw new AppError('WORKER_UNAVAILABLE', null, { details: info.error });
      }
      return { provider, engine: await provider.selectEngine(mode) };
    } catch (err) {
      if (id === 'comfyui') comfyError = err;
      problems.push(`${provider.label}: ${err.message}${err.details ? `\n  ${String(err.details).split('\n').slice(0, 6).join('\n  ')}` : ''}`);
    }
  }
  const details = problems.join('\n\n');
  if (comfyError && comfyError.code === 'COMFYUI_OFFLINE') throw new AppError('COMFYUI_OFFLINE', null, { details, retryable: false });
  if (comfyError && comfyError.code === 'MODEL_MISSING') throw new AppError('MODEL_MISSING', comfyError.message, { details });
  throw new AppError('NO_ENGINE', null, { details });
}

async function healthAll(force = false) {
  const entries = await Promise.all(Object.values(providers).map(async p => {
    try {
      return await p.health(force);
    } catch (err) {
      return { id: p.id, label: p.label, kind: p.kind, available: false, status: 'error', message: err.message, details: err.details };
    }
  }));
  return Object.fromEntries(entries.map(e => [e.id, e]));
}

module.exports = { providers, get, resolve, healthAll };
