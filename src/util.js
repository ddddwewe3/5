'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ID_RE = /^[a-z]{2,4}_[a-z0-9]{6,32}$/;

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        const e = new Error('Aborted');
        e.name = 'AbortError';
        reject(e);
      }, { once: true });
    }
  });
}

function randomSeed() {
  return crypto.randomInt(1, 2 ** 31 - 1);
}

function safeFileName(name, fallback = 'file') {
  const base = path.basename(String(name || fallback)).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
  return base || fallback;
}

function slug(text, max = 40) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'video';
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    throw e;
  }
}

module.exports = { newId, isId, writeJsonAtomic, readJson, clamp, sleep, randomSeed, safeFileName, slug, throwIfAborted };
