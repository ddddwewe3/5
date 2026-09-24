#!/usr/bin/env node
'use strict';
/**
 * End-to-end test against a running OpenReel Studio server (default http://localhost:3000).
 * Generates a real short video with whatever engine is active, extends it, renders a final cut
 * with a voice-over + subtitles, and verifies every output is a valid, downloadable MP4.
 *
 *   node scripts/e2e-test.js [--url http://localhost:3000] [--duration 3] [--quality fast]
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const BASE = arg('url', 'http://localhost:3000').replace(/\/$/, '');
const DURATION = Number(arg('duration', 3));
const QUALITY = arg('quality', 'fast');
let failures = 0;

const pass = m => console.log(`  \x1b[32m✔\x1b[0m ${m}`);
const fail = m => { failures++; console.log(`  \x1b[31m✖\x1b[0m ${m}`); };

async function api(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error((data && data.error && data.error.message) || `HTTP ${res.status}`), { data });
  return data;
}

async function waitJob(jobId, label) {
  const t0 = Date.now();
  let lastStage = '';
  for (;;) {
    const s = await api('GET', `/api/video/status/${jobId}`);
    if (s.stage !== lastStage) {
      lastStage = s.stage;
      console.log(`      ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${s.stage.toUpperCase().padEnd(14)} ${s.message || ''}`);
    }
    if (['completed', 'failed', 'cancelled'].includes(s.status)) {
      if (s.status !== 'completed') {
        fail(`${label} ${s.status}: [${s.error && s.error.code}] ${s.error && s.error.message}`);
        if (s.error && s.error.details) console.log(String(s.error.details).split('\n').slice(0, 12).map(l => `        ${l}`).join('\n'));
        return null;
      }
      pass(`${label} finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return s.result;
    }
    await new Promise(r => setTimeout(r, 700));
  }
}

async function verifyMp4(id, label, { expectAudio = false } = {}) {
  const res = await fetch(`${BASE}/api/video/${id}/download`);
  if (!res.ok) return fail(`${label}: download HTTP ${res.status}`);
  const cd = res.headers.get('content-disposition') || '';
  const file = path.join(os.tmpdir(), `openreel-e2e-${id}.mp4`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  if (!/attachment/.test(cd)) fail(`${label}: download is not served as an attachment`);
  try {
    const out = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]).toString());
    const v = out.streams.find(s => s.codec_type === 'video');
    const a = out.streams.find(s => s.codec_type === 'audio');
    if (!v || v.codec_name !== 'h264') return fail(`${label}: not an H.264 video`);
    if (expectAudio && !a) return fail(`${label}: missing audio track`);
    execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-']); // full decode = file is intact
    pass(`${label}: valid MP4 ${v.width}×${v.height} ${v.codec_name}/${v.pix_fmt}${a ? ` + ${a.codec_name}` : ''}, ${Number(out.format.duration).toFixed(2)}s, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB, downloaded as ${cd.split('filename=')[1]}`);
  } catch (err) {
    fail(`${label}: ffprobe/ffmpeg check failed: ${err.message}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function main() {
  console.log(`\nOpenReel Studio end-to-end test → ${BASE}\n`);
  const status = await api('GET', '/api/system/status?refresh=1').catch(e => { console.error(`Server not reachable: ${e.message}`); process.exit(1); });
  pass(`API reachable (Node ${status.app.node}, FFmpeg ${status.ffmpeg.version || 'missing'})`);
  const c = status.providers.comfyui;
  console.log(`      ComfyUI: ${c.status} — ${c.message}`);
  console.log(`      Local worker: ${status.providers.local.status} — ${status.providers.local.message}`);
  if (!status.activeProvider) { fail('No video engine available'); return; }
  pass(`Active engine: ${status.providers[status.activeProvider].label}`);

  console.log('\n  1) Text-to-video');
  const gen = await api('POST', '/api/video/generate', { prompt: 'A man talking in a room', aspectRatio: '16:9', duration: DURATION, quality: QUALITY });
  const r1 = await waitJob(gen.jobId, 'Scene 1');
  if (!r1) return;
  await verifyMp4(gen.takeId, 'Scene 1');
  const range = await fetch(BASE + r1.video, { headers: { Range: 'bytes=0-99' } });
  if (range.status === 206) pass('Browser streaming (HTTP range requests) works'); else fail(`Range request returned ${range.status}`);

  console.log('\n  2) Extend video (continues from the last frame)');
  const ext = await api('POST', '/api/video/extend', { projectId: gen.projectId, prompt: 'he stands up and walks to the window', duration: DURATION });
  if (await waitJob(ext.jobId, 'Scene 2')) await verifyMp4(ext.takeId, 'Scene 2');

  console.log('\n  3) Final render: merge + crossfade + voice-over + subtitles');
  const rnd = await api('POST', '/api/video/render', { projectId: gen.projectId, spec: {
    transition: { type: 'fade', duration: 0.5 }, voice: { text: 'Welcome to my new product.' }, subtitles: { enabled: true },
  } });
  if (await waitJob(rnd.jobId, 'Final render')) await verifyMp4(rnd.renderId, 'Final video', { expectAudio: true });

  console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m\n` : '\n\x1b[32mAll checks passed.\x1b[0m\n');
}

main().then(() => process.exit(failures ? 1 : 0)).catch(err => {
  console.error(`\n✖ ${err.message}`, err.data ? JSON.stringify(err.data.error) : '');
  process.exit(1);
});
