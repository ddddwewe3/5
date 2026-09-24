'use strict';
const path = require('path');
const { DATA_DIR, defaults } = require('../config');
const { readJson, writeJsonAtomic } = require('../util');

const FILE = path.join(DATA_DIR, 'settings.json');

const ENUMS = {
  provider: ['auto', 'comfyui', 'local', 'external'],
  localOffload: ['auto', 'none', 'model', 'sequential'],
  localDtype: ['auto', 'bf16', 'fp16', 'fp32'],
  defaultQuality: ['fast', 'balanced', 'quality'],
  hardwareEncoder: ['auto', 'off'],
  ttsEngine: ['auto', 'piper', 'sapi', 'espeak', 'say'],
};
const SECRET_KEYS = ['externalApiToken'];

let current = { ...defaults, ...readJson(FILE, {}) };
const listeners = new Set();

function get() {
  return current;
}

/** Settings for the browser: secrets are masked. */
function publicView() {
  const out = { ...current };
  for (const k of SECRET_KEYS) out[k] = current[k] ? '••••••••' : '';
  return out;
}

function update(patch) {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in defaults)) continue;
    if (SECRET_KEYS.includes(key) && value === '••••••••') continue; // unchanged masked secret
    const def = defaults[key];
    if (ENUMS[key] && !ENUMS[key].includes(value)) {
      throw Object.assign(new Error(`Invalid value for ${key}`), { status: 400 });
    }
    if (typeof def === 'boolean') next[key] = Boolean(value);
    else if (typeof def === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw Object.assign(new Error(`Invalid number for ${key}`), { status: 400 });
      next[key] = n;
    } else next[key] = String(value ?? '').trim();
  }
  for (const k of ['comfyuiUrl', 'externalApiUrl', 'ollamaUrl']) next[k] = next[k].replace(/\/+$/, '');
  current = next;
  // Only persist values that differ from the environment defaults.
  const persisted = {};
  for (const [k, v] of Object.entries(current)) if (v !== defaults[k]) persisted[k] = v;
  writeJsonAtomic(FILE, persisted);
  for (const fn of listeners) fn(current);
  return current;
}

function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

module.exports = { get, publicView, update, onChange, ENUMS };
