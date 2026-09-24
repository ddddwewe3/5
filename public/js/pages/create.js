import { api } from '../api.js';
import { refreshStatus, onStatus } from '../state.js';
import { icon, esc, toast, toastError, timeAgo, errorCard, ffmpegBanner, wireFfmpegInstall } from '../ui.js';

const DRAFT_KEY = 'openreel.draft';
const PLACEHOLDERS = [
  'A man talking to the camera in a cozy room…',
  'A perfume bottle rotating on a marble pedestal, soft studio light…',
  'Drone shot over turquoise water and a white sand beach…',
  'Steam rising from a fresh cup of coffee in a sunny café…',
];

function loadDraft() {
  try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY)) || {}; } catch { return {}; }
}

export async function render(main) {
  const tpl = (() => { try { return JSON.parse(sessionStorage.getItem('openreel.template')); } catch { return null; } })();
  sessionStorage.removeItem('openreel.template');
  const draft = loadDraft();
  const state = {
    mode: 't2v', prompt: '', image: null, aspectRatio: '16:9', duration: 5, quality: null,
    ...draft,
    ...(tpl ? { mode: tpl.mode === 'i2v' ? 'i2v' : 't2v', prompt: tpl.prompt, aspectRatio: tpl.aspectRatio, duration: tpl.duration } : {}),
  };
  let uploading = false;
  let submitting = false;
  const saveDraft = () => sessionStorage.setItem(DRAFT_KEY, JSON.stringify(state));

  main.innerHTML = `
  <div class="page narrow">
    <div class="hero-title">
      <h1>Turn your ideas into <span>video</span></h1>
      <p>Free &amp; self-hosted — open-source AI models running on your own computer.</p>
    </div>
    <div id="engineBanner"></div>
    ${tpl ? `<div class="banner info">${icon('layout')}<div class="banner-body"><strong>Template: ${esc(tpl.title)}</strong><p>Edit the prompt as you like, then press Generate.</p></div></div>` : ''}
    <form class="composer" id="composer" autocomplete="off">
      <div class="composer-top">
        <div class="segmented" role="group" aria-label="Generation mode">
          <button type="button" data-mode="t2v">${icon('type')} Text to Video</button>
          <button type="button" data-mode="i2v">${icon('image')} Image to Video</button>
        </div>
        <span class="small muted" id="charCount"></span>
      </div>
      <div class="prompt-box">
        <label class="sr-only" for="prompt">Describe your video</label>
        <textarea id="prompt" maxlength="2000" placeholder="${esc(PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)])}"></textarea>
      </div>
      <div class="composer-mid">
        <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Upload an image"></div>
        <input type="file" id="fileInput" accept="image/png,image/jpeg,image/webp,image/bmp,image/gif" hidden>
      </div>
      <div class="options-grid">
        <div>
          <span class="opt-label">Aspect ratio</span>
          <div class="chips" id="arChips">
            ${[['16:9', 'ar-16x9', 'Landscape'], ['9:16', 'ar-9x16', 'Vertical'], ['1:1', 'ar-1x1', 'Square']].map(([v, c, t]) =>
              `<button type="button" class="chip" data-ar="${v}" title="${t}"><span class="ar-shape ${c}"></span>${v}</button>`).join('')}
          </div>
        </div>
        <div>
          <span class="opt-label">Duration</span>
          <div class="chips" id="durChips">${[3, 5, 8, 10].map(d => `<button type="button" class="chip" data-dur="${d}">${d}s</button>`).join('')}</div>
        </div>
        <div>
          <span class="opt-label">Speed / quality</span>
          <div class="chips" id="qChips">
            <button type="button" class="chip" data-q="fast" title="Lowest latency: generates at reduced resolution, FFmpeg upscales to 720p">${icon('zap')} Fast</button>
            <button type="button" class="chip" data-q="balanced">Balanced</button>
            <button type="button" class="chip" data-q="quality">High</button>
          </div>
        </div>
      </div>
      <div id="enhancedBox"></div>
      <div class="composer-foot">
        <button type="button" class="btn ghost" id="previewBtn">${icon('wand')} Preview AI prompt</button>
        <button type="submit" class="btn primary lg" id="generateBtn">${icon('sparkles')} Generate video</button>
      </div>
      <div id="formError"></div>
    </form>
    <section style="margin-top:40px">
      <div class="spread" style="margin-bottom:12px"><h2 style="margin:0">Recent projects</h2><a href="#/projects" class="btn ghost sm">View all ${icon('right')}</a></div>
      <div class="recent-strip" id="recent"></div>
    </section>
  </div>`;

  const $ = sel => main.querySelector(sel);
  const promptEl = $('#prompt');
  promptEl.value = state.prompt || '';

  function sync() {
    main.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
    main.querySelectorAll('[data-ar]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ar === state.aspectRatio)));
    main.querySelectorAll('[data-dur]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.dur) === state.duration)));
    main.querySelectorAll('[data-q]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.q === state.quality)));
    $('#charCount').textContent = `${promptEl.value.length} / 2000`;
    const dz = $('#dropzone');
    if (uploading) {
      dz.innerHTML = `<span class="spinner"></span><div class="dz-text"><strong>Uploading…</strong><span id="upPct">0%</span></div>`;
    } else if (state.image) {
      dz.innerHTML = `<img class="thumb" src="${esc(state.image.url)}" alt="Uploaded image">
        <div class="dz-text"><strong>${esc(state.image.originalName)}</strong>${state.image.width}×${state.image.height} · the video will start from this image</div>
        <button type="button" class="btn ghost sm icon-only" id="removeImg" aria-label="Remove image">${icon('x')}</button>`;
    } else {
      dz.innerHTML = `${icon('upload')}<div class="dz-text"><strong>${state.mode === 'i2v' ? 'Upload an image (required)' : 'Add an image (optional)'}</strong>
        Product photo, character or scene — drag &amp; drop or click. PNG, JPG, WEBP.</div>`;
    }
    promptEl.placeholder = state.mode === 'i2v' ? 'Describe the motion, e.g. "the product rotates slowly while light glides across it"' : promptEl.placeholder;
    saveDraft();
  }

  async function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('Please choose an image file (PNG, JPG or WEBP).', { type: 'warn' });
    uploading = true;
    sync();
    try {
      state.image = await api.upload(file, p => { const el = $('#upPct'); if (el) el.textContent = `${Math.round(p * 100)}%`; });
      state.mode = 'i2v';
    } catch (err) {
      toastError(err, 'Upload failed');
    } finally {
      uploading = false;
      sync();
    }
  }

  main.addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.mode) { state.mode = t.dataset.mode; if (state.mode === 't2v') state.image = state.image; sync(); }
    if (t.dataset.ar) { state.aspectRatio = t.dataset.ar; sync(); }
    if (t.dataset.dur) { state.duration = Number(t.dataset.dur); sync(); }
    if (t.dataset.q) { state.quality = t.dataset.q; sync(); }
    if (t.id === 'removeImg') { e.stopPropagation(); state.image = null; if (state.mode === 'i2v') state.mode = 't2v'; sync(); }
  });
  const dz = $('#dropzone');
  const fileInput = $('#fileInput');
  dz.addEventListener('click', e => { if (!e.target.closest('#removeImg')) fileInput.click(); });
  dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', () => { handleFile(fileInput.files[0]); fileInput.value = ''; });
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); handleFile(e.dataTransfer.files[0]); });
  main.addEventListener('paste', e => {
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find(i => i.type.startsWith('image/'));
    if (item) handleFile(item.getAsFile());
  });
  promptEl.addEventListener('input', () => { state.prompt = promptEl.value; sync(); });
  promptEl.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#composer').requestSubmit(); });

  $('#previewBtn').addEventListener('click', async () => {
    const box = $('#enhancedBox');
    if (!promptEl.value.trim() && !state.image) return toast('Type a prompt first.', { type: 'warn' });
    box.innerHTML = `<div class="enhanced"><span class="spinner"></span> Building cinematic prompt…</div>`;
    try {
      const r = await api.enhance({ prompt: promptEl.value, mode: state.mode, aspectRatio: state.aspectRatio, duration: state.duration, hasImage: Boolean(state.image) });
      const s = r.structured || {};
      const keys = ['subject', 'action', 'environment', 'camera_movement', 'camera_angle', 'lighting', 'style', 'motion'];
      box.innerHTML = `<div class="enhanced">
        <div class="spread"><strong>${icon('wand')} How the AI will interpret your idea</strong><span class="badge accent">${r.engine === 'ollama' ? 'Local LLM' : 'Built-in engine'}</span></div>
        ${r.note ? `<p class="small" style="color:#fcd34d">${esc(r.note)}</p>` : ''}
        <dl>${keys.filter(k => s[k]).map(k => `<dt>${k.replace('_', ' ')}</dt><dd>${esc(s[k])}</dd>`).join('')}
          <dt>duration</dt><dd>${esc(state.duration)} seconds</dd><dt>aspect ratio</dt><dd>${esc(state.aspectRatio)}</dd></dl>
        <details class="devlog"><summary>Full prompt sent to the model</summary><pre>${esc(r.prompt)}</pre></details></div>`;
    } catch (err) {
      box.innerHTML = '';
      toastError(err);
    }
  });

  $('#composer').addEventListener('submit', async e => {
    e.preventDefault();
    if (submitting) return;
    if (uploading) return toast('Please wait until the image has finished uploading.', { type: 'warn' });
    if (state.mode === 'i2v' && !state.image) return toast('Image to Video needs an image — upload one or switch to Text to Video.', { type: 'warn' });
    if (state.mode === 't2v' && !promptEl.value.trim()) { promptEl.focus(); return toast('Describe the video you want to create.', { type: 'warn' }); }
    submitting = true;
    const btn = $('#generateBtn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Starting…';
    $('#formError').innerHTML = '';
    try {
      const res = await api.generate({
        prompt: promptEl.value.trim(), mode: state.mode, imageId: state.mode === 'i2v' && state.image ? state.image.id : undefined,
        aspectRatio: state.aspectRatio, duration: state.duration, quality: state.quality || undefined,
      });
      if (tpl && tpl.voiceover) sessionStorage.setItem(`openreel.voice.${res.projectId}`, tpl.voiceover);
      if (res.promptNote) toast(res.promptNote, { type: 'warn', timeout: 9000 });
      state.prompt = '';
      state.image = null;
      state.mode = 't2v';
      saveDraft();
      location.hash = `#/project/${res.projectId}`;
    } catch (err) {
      $('#formError').innerHTML = `<div style="margin-top:16px">${errorCard(err.error, { heading: 'Could not start the generation.', showRetry: false })}</div>`;
      btn.disabled = false;
      btn.innerHTML = `${icon('sparkles')} Generate video`;
      submitting = false;
    }
  });

  function renderBanner(status) {
    const box = $('#engineBanner');
    if (!box) return;
    if (!status) {
      box.innerHTML = `<div class="banner err">${icon('alert')}<div class="banner-body"><strong>Server unreachable</strong><p>The OpenReel server is not responding.</p></div></div>`;
      return;
    }
    const comfy = status.providers.comfyui;
    const local = status.providers.local;
    const parts = [];
    if (status.providerSetting === 'auto' || status.providerSetting === 'comfyui') {
      if (comfy.status === 'offline') {
        parts.push(`<div class="banner ${status.activeProvider ? 'warn' : 'err'}">${icon('alert')}<div class="banner-body">
          <strong>ComfyUI is not running. Start ComfyUI to enable local AI video generation.</strong>
          <p>${status.activeProvider === 'local' ? 'Meanwhile videos are generated with the local model worker.' : 'No other engine is available right now.'}
          <a href="#/settings" style="text-decoration:underline">Engine settings</a></p></div></div>`);
      } else if (comfy.status === 'no_models') {
        parts.push(`<div class="banner warn">${icon('alert')}<div class="banner-body"><strong>ComfyUI is running but has no video model yet.</strong>
          <p>Run <code>download-models.bat</code> (or see Settings) to install LTX-Video. ${status.activeProvider === 'local' ? 'Using the local model worker meanwhile.' : ''}</p></div></div>`);
      }
    }
    const active = status.activeProvider && status.providers[status.activeProvider];
    if (active && active.warning) {
      parts.push(`<div class="banner warn">${icon('cpu')}<div class="banner-body"><strong>${esc(active.warning)}</strong>
        <p>Progress is shown live, so you'll always see the real remaining time.</p></div></div>`);
    }
    if (!status.activeProvider && comfy.status !== 'offline') {
      parts.push(`<div class="banner err">${icon('alert')}<div class="banner-body"><strong>No video engine available</strong><p>${esc(local.message)} — see <a href="#/settings" style="text-decoration:underline">Settings</a>.</p></div></div>`);
    }
    if (status.ffmpeg && !status.ffmpeg.available) parts.unshift(ffmpegBanner());
    box.innerHTML = parts.join('');
  }

  const settings = await api.settings().catch(() => null);
  if (!state.quality) state.quality = (settings && settings.defaultQuality) || 'fast';
  sync();
  const off = onStatus(renderBanner);
  wireFfmpegInstall($('#engineBanner'), () => refreshStatus(true));
  refreshStatus().then(renderBanner);

  api.projects().then(list => {
    const box = $('#recent');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = `<p class="muted small">Your projects will appear here.</p>`;
      return;
    }
    box.innerHTML = list.slice(0, 4).map(p => `
      <a class="media-card" href="#/project/${p.id}">
        <div class="media-thumb">${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="" loading="lazy">` : `<div class="placeholder">${icon(p.status === 'running' ? 'clock' : 'film')}</div>`}
          <div class="corner">${p.status === 'running' ? '<span class="badge info">Generating</span>' : ''}</div></div>
        <div class="media-body"><div class="media-title">${esc(p.name)}</div><div class="media-sub">${timeAgo(p.updatedAt)} · ${p.sceneCount} scene${p.sceneCount === 1 ? '' : 's'}</div></div>
      </a>`).join('');
  }).catch(() => {});

  promptEl.focus();
  return () => off();
}
