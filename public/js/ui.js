// Shared UI helpers: icons, escaping, toasts, modals, formatting, error cards.

const ICONS = {
  sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4M21 5h-4M5 17v4M7 19H3"/>',
  film: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 7.5h4M3 12h18M3 16.5h4M17 7.5h4M17 16.5h4"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
  type: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  play: '<path d="M6 4l14 8-14 8z"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8"/>',
  captions: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M15 15h2M7 11h2M13 11h4"/>',
  wand: '<path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  left: '<path d="M15 18l-6-6 6-6"/>',
  right: '<path d="M9 18l6-6-6-6"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
  zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  layers: '<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  package: '<path d="M16.5 9.4L7.5 4.21M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>',
  gift: '<path d="M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  smartphone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  utensils: '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/>',
  coffee: '<path d="M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8zM6 1v3M10 1v3M14 1v3"/>',
  home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  shirt: '<path d="M20.38 3.46L16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>',
  mountain: '<path d="M8 3l4 8 5-5 5 15H2L8 3z"/>',
  car: '<path d="M5 17h14M3 17v-5l2-5h14l2 5v5"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>',
};

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;
}

export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (!el.firstChild) el.innerHTML = icon(el.dataset.icon);
  });
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtTime(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '–';
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDuration(sec) {
  if (!sec && sec !== 0) return '';
  return sec < 60 ? `${sec.toFixed(1)}s` : fmtTime(sec);
}

export function fmtBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function timeAgo(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export function toast(message, { type = 'info', title, timeout = 4500 } = {}) {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${title ? `<strong>${esc(title)}</strong>` : ''}${esc(message)}`;
  box.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

export function toastError(err, fallbackTitle = 'Something went wrong') {
  const e = (err && err.error) || { title: fallbackTitle, message: String(err && err.message ? err.message : err) };
  toast(e.message, { type: 'err', title: e.title || fallbackTitle, timeout: 7000 });
  console.error(err);
}

export function confirmDialog({ title, message, confirm = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mdl-t">
      <h3 id="mdl-t">${esc(title)}</h3><p>${esc(message)}</p>
      <div class="row"><button class="btn ghost" data-a="no">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-a="yes">${esc(confirm)}</button></div></div>`;
    const done = v => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') done(false); };
    wrap.addEventListener('click', e => {
      if (e.target === wrap) done(false);
      const a = e.target.closest('[data-a]');
      if (a) done(a.dataset.a === 'yes');
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-a=yes]').focus();
  });
}

/**
 * <video> markup: the H.264 MP4 first; browsers without an H.264 decoder fall back to a WebM copy
 * that the server transcodes on demand.
 */
export function videoTag(url, id, attrs = '') {
  const webm = id ? `<source src="/api/video/${esc(id)}/preview.webm" type="video/webm">` : '';
  return `<video ${attrs}><source src="${esc(url)}" type='video/mp4; codecs="avc1.640028"'>${webm}</video>`;
}

export function videoModal(url, title, id) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal video-modal" role="dialog" aria-modal="true" aria-label="${esc(title || 'Video')}">
    ${videoTag(url, id, 'controls autoplay playsinline')}</div>`;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(wrap);
}

// The five failure causes the UI always explains; the classified one is highlighted.
const STANDARD_REASONS = [
  ['COMFYUI_OFFLINE', 'ComfyUI is offline'],
  ['MODEL_MISSING', 'Model is missing'],
  ['GPU_OOM', 'GPU memory is insufficient'],
  ['INVALID_INPUT', 'Invalid input'],
  ['FFMPEG_ERROR', 'FFmpeg processing error'],
];

export function errorCard(error, { logs = [], heading = 'Generation failed.', retryLabel = 'Try again', showRetry = true } = {}) {
  const e = error || {};
  const code = e.code === 'FFMPEG_MISSING' ? 'FFMPEG_ERROR' : e.code;
  const standard = STANDARD_REASONS.some(([c]) => c === code);
  const reasons = STANDARD_REASONS.map(([c, label]) =>
    `<li class="${c === code ? 'likely' : ''}">${esc(label)}${c === code ? ' <span class="badge err">most likely</span>' : ''}</li>`).join('');
  const extra = !standard && e.title ? `<li class="likely">${esc(e.title)} <span class="badge err">most likely</span></li>` : '';
  const fixes = (e.fixes || []).map(f => `<li>${esc(f)}</li>`).join('');
  const logText = [
    e.code ? `[${e.code}] ${e.message || ''}` : '',
    e.details ? `\n${e.details}` : '',
    logs.length ? `\n\n— Job log —\n${logs.map(l => `${new Date(l.t).toLocaleTimeString()}  ${l.message}`).join('\n')}` : '',
  ].join('');
  return `<div class="error-card" role="alert">
    <h3>${icon('alert')} ${esc(heading)}</h3>
    <p class="msg">${esc(e.message || 'Unknown error')}</p>
    <div class="small muted">Possible reason:</div>
    <ul>${extra}${reasons}</ul>
    ${fixes ? `<div class="small muted">What you can do:</div><ul>${fixes}</ul>` : ''}
    <details class="devlog"><summary>Developer logs</summary><pre>${esc(logText.trim() || 'No additional details.')}</pre></details>
    ${showRetry ? `<div class="row" style="margin-top:12px"><button class="btn primary sm" data-action="retry">${icon('refresh')} ${esc(retryLabel)}</button>
      <a class="btn sm" href="#/settings">${icon('settings')} Engine settings</a></div>` : ''}
  </div>`;
}

export function aspectClass(ar) {
  return ar === '9:16' ? 'ar-9x16' : ar === '1:1' ? 'ar-1x1' : 'ar-16x9';
}

export const STAGE_LABELS = [
  ['queued', 'Queued'], ['loading_model', 'Loading model'], ['generating', 'Generating'],
  ['processing', 'Processing'], ['encoding', 'Encoding'], ['complete', 'Complete'],
];

// ── One-click FFmpeg install ──────────────────────────────────────────────────
export function ffmpegBanner() {
  return `<div class="banner err">${icon('alert')}<div class="banner-body"><strong>FFmpeg is not installed</strong>
    <p>FFmpeg encodes your videos. Install it with one click — free and open source, about 200 MB, no restart needed.</p>
    <div class="row" style="margin-top:10px">
      <button class="btn primary sm" data-action="install-ffmpeg">${icon('download')} Install FFmpeg automatically</button>
      <span class="small" data-ffmpeg-progress></span>
    </div></div></div>`;
}

let ffmpegPoll = null;

/** Wires every [data-action=install-ffmpeg] button inside `root`; calls onDone() when FFmpeg works. */
export function wireFfmpegInstall(root, onDone) {
  const show = st => {
    const el = root.querySelector('[data-ffmpeg-progress]');
    const btn = root.querySelector('[data-action="install-ffmpeg"]');
    if (!el) return;
    if (st.status === 'downloading') {
      const mb = (st.downloaded / 1e6).toFixed(0);
      el.textContent = st.total ? `Downloading ${Math.round((st.downloaded / st.total) * 100)}% (${mb} / ${(st.total / 1e6).toFixed(0)} MB) from ${st.source}…` : `Downloading ${mb} MB…`;
    } else if (st.status === 'extracting') el.textContent = 'Unpacking…';
    else if (st.status === 'error') el.innerHTML = `<span style="color:#fecaca">${esc(st.error)}</span> — or install manually: <code>winget install Gyan.FFmpeg</code>`;
    else el.textContent = '';
    if (btn) btn.disabled = st.status === 'downloading' || st.status === 'extracting';
  };
  const poll = () => {
    clearInterval(ffmpegPoll);
    ffmpegPoll = setInterval(async () => {
      try {
        const st = await (await fetch('/api/system/ffmpeg/install')).json();
        show(st);
        if (st.status === 'done' || st.status === 'error') {
          clearInterval(ffmpegPoll);
          if (st.status === 'done') { toast('FFmpeg installed — you can generate videos now.', { type: 'ok' }); onDone(); }
        }
      } catch { /* server restarting */ }
    }, 1000);
  };
  root.addEventListener('click', async e => {
    if (!e.target.closest('[data-action="install-ffmpeg"]')) return;
    try {
      show(await (await fetch('/api/system/ffmpeg/install', { method: 'POST' })).json());
      poll();
    } catch (err) { toastError(err); }
  });
  // Resume showing progress if an install is already running (e.g. after a page reload).
  fetch('/api/system/ffmpeg/install').then(r => r.json()).then(st => {
    if (st.status === 'downloading' || st.status === 'extracting') { show(st); poll(); }
  }).catch(() => {});
}
