const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const TOKEN = 'test-engine-token';
const seen = [];
let engine;
let site;
let siteUrl;

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

before(async () => {
  // Fake video engine that records what the proxy sends.
  engine = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url.startsWith('/api/generations/' + 'a'.repeat(32) + '/video')) {
        res.writeHead(req.headers.range ? 206 : 200, {
          'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-range': 'bytes 0-3/10',
        });
        return res.end('mp4!');
      }
      res.writeHead(req.url === '/api/upload' ? 201 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  const enginePort = await listen(engine);

  process.env.ENGINE_URL = `http://127.0.0.1:${enginePort}`;
  process.env.ENGINE_API_TOKEN = TOKEN;
  delete process.env.STRIPE_SECRET_KEY;
  const app = require('../server');
  site = http.createServer(app);
  siteUrl = `http://127.0.0.1:${await listen(site)}`;
});

after(() => {
  engine.close();
  site.close();
});

test('assigns an anonymous owner cookie and forwards it with the engine token', async () => {
  const first = await fetch(`${siteUrl}/api/studio/models`);
  assert.strictEqual(first.status, 200);
  const cookie = first.headers.get('set-cookie');
  assert.match(cookie, /^vs_uid=[a-f0-9]{32}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax/);
  const owner = cookie.split(';')[0].split('=')[1];
  const forwarded = seen.at(-1);
  assert.strictEqual(forwarded.url, '/api/models');
  assert.strictEqual(forwarded.headers['x-owner-id'], owner);
  assert.strictEqual(forwarded.headers.authorization, `Bearer ${TOKEN}`);

  const second = await fetch(`${siteUrl}/api/studio/generations?limit=5`, { headers: { cookie: `vs_uid=${owner}` } });
  assert.strictEqual(second.headers.get('set-cookie'), null);
  assert.strictEqual(seen.at(-1).url, '/api/generations?limit=5');
  assert.strictEqual(seen.at(-1).headers['x-owner-id'], owner);
});

test('a forged owner id is replaced by a fresh one', async () => {
  const res = await fetch(`${siteUrl}/api/studio/health`, { headers: { cookie: 'vs_uid=../../etc' } });
  assert.match(res.headers.get('set-cookie'), /^vs_uid=[a-f0-9]{32}/);
  assert.match(seen.at(-1).headers['x-owner-id'], /^[a-f0-9]{32}$/);
});

test('streams multipart uploads and JSON bodies unchanged', async () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('fake-png-bytes')], { type: 'image/png' }), 'a.png');
  const res = await fetch(`${siteUrl}/api/studio/upload`, { method: 'POST', body: form });
  assert.strictEqual(res.status, 201);
  const upload = seen.at(-1);
  assert.match(upload.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.ok(upload.body.includes(Buffer.from('fake-png-bytes')));

  const body = JSON.stringify({ mode: 't2v', prompt: 'مدينة في المطر' });
  await fetch(`${siteUrl}/api/studio/generations`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body,
  });
  assert.strictEqual(seen.at(-1).method, 'POST');
  assert.strictEqual(seen.at(-1).body.toString(), body);
});

test('passes range requests through for video seeking', async () => {
  const res = await fetch(`${siteUrl}/api/studio/generations/${'a'.repeat(32)}/video`, { headers: { range: 'bytes=0-3' } });
  assert.strictEqual(res.status, 206);
  assert.strictEqual(res.headers.get('content-type'), 'video/mp4');
  assert.strictEqual(res.headers.get('content-range'), 'bytes 0-3/10');
  assert.strictEqual(seen.at(-1).headers.range, 'bytes=0-3');
  assert.strictEqual(await res.text(), 'mp4!');
});

test('only the studio API is exposed', async () => {
  const count = seen.length;
  for (const path of ['/api/generate', '/api/status/x', '/docs', '/files/bad', '/generations/x/video']) {
    const res = await fetch(`${siteUrl}/api/studio${path}`);
    assert.strictEqual(res.status, 404, path);
  }
  assert.strictEqual(seen.length, count);
});

test('rejects oversized uploads before contacting the engine', async () => {
  const count = seen.length;
  const res = await fetch(`${siteUrl}/api/studio/upload`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(22 * 1024 * 1024),
  });
  assert.strictEqual(res.status, 413);
  assert.strictEqual(seen.length, count);
});

test('returns an Arabic 502 with setup steps when the engine is down', async () => {
  const { createStudioProxy, ownerCookie } = require('../lib/studio-proxy');
  const express = require('express');
  const app = express();
  app.use('/api/studio', ownerCookie, createStudioProxy({ engineUrl: 'http://127.0.0.1:1' }));
  const server = http.createServer(app);
  const url = `http://127.0.0.1:${await listen(server)}`;
  const res = await fetch(`${url}/api/studio/health`);
  server.close();
  assert.strictEqual(res.status, 502);
  const body = await res.json();
  assert.match(body.detail.message, /غير متصل/);
  assert.ok(body.detail.setup_steps.length > 0);
});

test('serves the studio page and the storefront', async () => {
  const studio = await fetch(`${siteUrl}/studio`);
  assert.strictEqual(studio.status, 200);
  assert.match(await studio.text(), /استوديو/);
  const home = await fetch(`${siteUrl}/`);
  assert.strictEqual(home.status, 200);
});
