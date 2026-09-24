// Thin client for the OpenReel Studio REST API + live Server-Sent Events.

export class ApiError extends Error {
  constructor(error, status) {
    super((error && error.message) || `Request failed (${status})`);
    this.error = error || { code: 'UNKNOWN', title: 'Request failed', message: this.message, reasons: [], fixes: [] };
    this.status = status;
  }
}

async function request(method, url, body, { isForm = false } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
  } catch (err) {
    throw new ApiError({ code: 'NETWORK_ERROR', title: 'Server unreachable', message: 'Could not reach the OpenReel server. Is it still running?',
      reasons: ['The server (start-server.bat) was closed'], fixes: ['Start the server again'], details: String(err) }, 0);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new ApiError(data && data.error, res.status);
  return data;
}

export const api = {
  get: url => request('GET', url),
  post: (url, body) => request('POST', url, body || {}),
  put: (url, body) => request('PUT', url, body || {}),
  patch: (url, body) => request('PATCH', url, body || {}),
  del: url => request('DELETE', url),

  status: (refresh) => request('GET', `/api/system/status${refresh ? '?refresh=1' : ''}`),
  settings: () => request('GET', '/api/settings'),
  saveSettings: s => request('PUT', '/api/settings', s),
  projects: () => request('GET', '/api/projects'),
  project: id => request('GET', `/api/projects/${id}`),
  videos: () => request('GET', '/api/videos'),
  templates: () => request('GET', '/api/templates'),
  generate: body => request('POST', '/api/video/generate', body),
  extend: body => request('POST', '/api/video/extend', body),
  regenerate: body => request('POST', '/api/video/regenerate', body),
  cancel: id => request('POST', `/api/video/cancel/${id}`),
  render: body => request('POST', '/api/video/render', body),
  enhance: body => request('POST', '/api/prompt/enhance', body),

  /** Uploads a file with real upload progress (XHR, since fetch has no upload progress). */
  upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append('file', file);
      xhr.open('POST', '/api/video/upload');
      xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(data && data.error, xhr.status));
      };
      xhr.onerror = () => reject(new ApiError({ code: 'NETWORK_ERROR', title: 'Upload failed', message: 'The upload was interrupted.', reasons: [], fixes: [] }, 0));
      xhr.send(form);
    });
  },
};

// ── Live events ──
const listeners = { job: new Set(), project: new Set(), connection: new Set() };
let source = null;
export let liveConnected = false;

export function connectEvents() {
  if (source) return;
  source = new EventSource('/api/events');
  source.addEventListener('open', () => { liveConnected = true; listeners.connection.forEach(fn => fn(true)); });
  source.addEventListener('error', () => { liveConnected = false; listeners.connection.forEach(fn => fn(false)); });
  source.addEventListener('job', e => { const d = JSON.parse(e.data); listeners.job.forEach(fn => fn(d)); });
  source.addEventListener('project', e => { const d = JSON.parse(e.data); listeners.project.forEach(fn => fn(d)); });
}

export function on(event, fn) {
  listeners[event].add(fn);
  return () => listeners[event].delete(fn);
}
