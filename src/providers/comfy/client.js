'use strict';
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { AppError } = require('../../errors');

/** Thin client for the ComfyUI HTTP + WebSocket API. */
class ComfyClient {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
  }

  offline(err) {
    const reason = err && err.name === 'TimeoutError' ? 'timed out' : ((err && err.cause && err.cause.code) || (err && err.message) || 'unreachable');
    return new AppError('COMFYUI_OFFLINE', null, { details: `ComfyUI at ${this.baseUrl}: ${reason}` });
  }

  async request(pathname, { method = 'GET', json, body, headers = {}, timeout = 15000, signal, raw = false } = {}) {
    const signals = [AbortSignal.timeout(timeout)];
    if (signal) signals.push(signal);
    let res;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        method,
        headers: json !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
        body: json !== undefined ? JSON.stringify(json) : body,
        signal: AbortSignal.any ? AbortSignal.any(signals) : signals[0],
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      throw this.offline(err);
    }
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const e = new Error(`ComfyUI ${method} ${pathname} → HTTP ${res.status}`);
      e.status = res.status;
      e.body = data;
      throw e;
    }
    return data;
  }

  systemStats(opts) { return this.request('/system_stats', { timeout: 4000, ...opts }); }
  objectInfo(node) { return this.request(`/object_info/${encodeURIComponent(node)}`, { timeout: 10000 }); }
  queue() { return this.request('/queue', { timeout: 5000 }); }
  history(promptId) { return this.request(`/history/${encodeURIComponent(promptId)}`, { timeout: 10000 }); }

  submit(workflow, clientId) {
    return this.request('/prompt', { method: 'POST', json: { prompt: workflow, client_id: clientId }, timeout: 30000 });
  }

  interrupt(promptId) {
    return this.request('/interrupt', { method: 'POST', json: promptId ? { prompt_id: promptId } : {}, timeout: 5000 });
  }

  deleteQueued(promptIds) {
    return this.request('/queue', { method: 'POST', json: { delete: promptIds }, timeout: 5000 });
  }

  async uploadImage(filePath, name) {
    const form = new FormData();
    form.append('image', new Blob([fs.readFileSync(filePath)], { type: 'image/png' }), name || path.basename(filePath));
    form.append('type', 'input');
    form.append('subfolder', 'openreel');
    form.append('overwrite', 'true');
    return this.request('/upload/image', { method: 'POST', body: form, timeout: 60000 });
  }

  async download(file, dest, signal) {
    const qs = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || '', type: file.type || 'output' });
    const res = await this.request(`/view?${qs}`, { raw: true, timeout: 60000, signal });
    if (!res.ok) throw new AppError('PROVIDER_ERROR', `Could not download ${file.filename} from ComfyUI (HTTP ${res.status})`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return dest;
  }

  openSocket(clientId) {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + `/ws?clientId=${encodeURIComponent(clientId)}`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { handshakeTimeout: 5000 });
      const fail = err => reject(this.offline(err));
      ws.once('open', () => {
        ws.off('error', fail);
        resolve(ws);
      });
      ws.once('error', fail);
    });
  }
}

/** Reads the option list of a combo input from /object_info (supports old and V3 schemas). */
function comboOptions(info, node, input) {
  const def = info && info[node] && info[node].input;
  if (!def) return [];
  const spec = (def.required && def.required[input]) || (def.optional && def.optional[input]);
  if (!spec) return [];
  if (Array.isArray(spec[0])) return spec[0];
  if (spec[0] === 'COMBO' && spec[1] && Array.isArray(spec[1].options)) return spec[1].options;
  return [];
}

module.exports = { ComfyClient, comboOptions };
