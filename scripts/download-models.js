#!/usr/bin/env node
'use strict';
/**
 * Downloads free, openly-licensed video models for ComfyUI (resumable, with progress).
 *
 *   node scripts/download-models.js [--model ltxv-2b|wan22-5b|wan21-1.3b] [--comfyui <ComfyUI folder>] [--list]
 *
 * The ComfyUI folder defaults to COMFYUI_PATH from .env, then ./ComfyUI.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { COMFY_MODELS } = require('../src/providers/modelGuide');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function human(n) {
  return n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
}

async function download(url, dest) {
  const part = `${dest}.part`;
  let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await fetch(url, { headers: start ? { Range: `bytes=${start}-` } : {}, redirect: 'follow' });
  if (res.status === 416) { fs.renameSync(part, dest); return; }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (start && res.status !== 206) start = 0; // server ignored the range → restart
  const total = start + Number(res.headers.get('content-length') || 0);
  const out = fs.createWriteStream(part, { flags: start ? 'a' : 'w' });
  let done = start;
  let last = 0;
  const t0 = Date.now();
  for await (const chunk of res.body) {
    if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    done += chunk.length;
    if (Date.now() - last > 500) {
      last = Date.now();
      const speed = (done - start) / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r    ${human(done)} / ${total ? human(total) : '?'}  ${total ? `${((done / total) * 100).toFixed(1)}%` : ''}  ${human(speed)}/s   `);
    }
  }
  await new Promise(r => out.end(r));
  process.stdout.write('\n');
  fs.renameSync(part, dest);
}

async function main() {
  if (process.argv.includes('--list')) {
    for (const m of COMFY_MODELS) console.log(`${m.id.padEnd(12)} ${m.label} (${m.files.reduce((a, f) => a + f.sizeGB, 0).toFixed(1)} GB)`);
    return;
  }
  const id = arg('model', 'ltxv-2b');
  const model = COMFY_MODELS.find(m => m.id === id);
  if (!model) throw new Error(`Unknown model "${id}". Use --list to see the options.`);
  const comfy = path.resolve(arg('comfyui', process.env.COMFYUI_PATH || path.join(__dirname, '..', 'ComfyUI')));
  if (!fs.existsSync(path.join(comfy, 'models'))) {
    throw new Error(`"${comfy}" does not look like a ComfyUI folder (no models/ sub-folder). Pass --comfyui <path> or set COMFYUI_PATH in .env.`);
  }
  console.log(`\nDownloading ${model.label}\ninto ${comfy}\n`);
  for (const f of model.files) {
    const dir = path.join(comfy, 'models', f.folder);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, f.name);
    if (fs.existsSync(dest)) { console.log(`  ✔ ${f.folder}/${f.name} already present`); continue; }
    console.log(`  ↓ ${f.folder}/${f.name} (~${f.sizeGB} GB)`);
    await download(f.url, dest);
    console.log(`  ✔ ${f.folder}/${f.name}`);
  }
  console.log('\nDone. Restart ComfyUI (or refresh its model list) and OpenReel will detect the model automatically.\n');
}

main().catch(err => {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
});
