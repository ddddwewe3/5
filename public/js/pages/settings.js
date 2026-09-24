import { api } from '../api.js';
import { refreshStatus } from '../state.js';
import { icon, esc, toast, toastError } from '../ui.js';

const STATUS_BADGE = {
  online: '<span class="badge ok">Online</span>',
  offline: '<span class="badge err">Offline</span>',
  no_models: '<span class="badge warn">No models</span>',
  not_installed: '<span class="badge err">Not installed</span>',
  not_configured: '<span class="badge">Not configured</span>',
  error: '<span class="badge err">Error</span>',
};

export async function render(main) {
  main.innerHTML = `<div class="page narrow"><div class="page-head"><div><h1>Settings</h1><p>Engines, models, voice and diagnostics.</p></div>
    <button class="btn" id="refreshAll">${icon('refresh')} Re-check</button></div><div id="body"><div class="empty"><span class="spinner"></span></div></div></div>`;
  const body = main.querySelector('#body');
  let settings;
  let status;
  let voices = [];
  let logTimer = null;

  async function load(force) {
    [settings, status, voices] = await Promise.all([
      api.settings(), (force ? api.status(true) : refreshStatus(true)).then(s => s || api.status(force)), api.get('/api/tts/voices').catch(() => []),
    ]);
    draw();
  }

  function providerCard(p, selected) {
    const extra = [];
    if (p.gpu) extra.push(`${icon('cpu')} ${esc(p.gpu.name || p.gpu.type)}${p.gpu.vramTotalGB ? ` · ${p.gpu.vramTotalGB} GB VRAM` : ''}`);
    if (p.version) extra.push(`ComfyUI ${esc(p.version)}`);
    if (p.torch) extra.push(`torch ${esc(p.torch)} · diffusers ${esc(p.diffusers)}`);
    let details = '';
    if (p.id === 'comfyui' && p.engines && p.engines.length) {
      details = `<div class="small muted">Detected video engines:</div><ul class="file-list">${p.engines.map(e =>
        `<li>${esc(e.label)} ${e.t2v ? '<span class="badge">T2V</span>' : ''} ${e.i2v ? '<span class="badge">I2V</span>' : ''}</li>`).join('')}</ul>`;
    }
    if (p.id === 'comfyui' && (p.status === 'no_models' || p.status === 'offline') && p.recommended) {
      details += `<details class="devlog" ${p.status === 'no_models' ? 'open' : ''}><summary>Recommended free models (download once)</summary>
        <p class="small muted" style="margin:8px 0 4px">Run <code>download-models.bat</code> (Windows) or <code>npm run download-models</code> — or download manually into your ComfyUI folder:</p>
        ${p.recommended.map(m => `<div class="small" style="margin-top:8px"><b>${esc(m.label)}</b><ul class="file-list">${m.files.map(f =>
          `<li><code>ComfyUI/models/${esc(f.folder)}/${esc(f.name)}</code> (${f.sizeGB} GB) <a href="${esc(f.url)}" target="_blank" rel="noopener" style="text-decoration:underline">download</a></li>`).join('')}</ul></div>`).join('')}</details>`;
    }
    if (p.id === 'local' && p.recommended) {
      details = `<div class="small muted">Model: <code>${esc(p.model)}</code> ${p.status === 'online' ? `(${p.modelCached ? 'downloaded' : 'downloads automatically on first use'})` : ''}</div>`;
    }
    return `<div class="provider-card ${selected ? 'selected' : ''}">
      <div class="spread"><h3>${esc(p.label)}</h3>${STATUS_BADGE[p.status] || ''}</div>
      <div class="small">${esc(p.message || '')}</div>
      ${p.warning ? `<div class="small" style="color:#fcd34d">${icon('alert')} ${esc(p.warning)}</div>` : ''}
      ${extra.length ? `<div class="small muted row">${extra.join('<span>·</span>')}</div>` : ''}
      ${details}
      ${p.details && p.status !== 'online' ? `<details class="devlog"><summary>Developer details</summary><pre>${esc(p.details)}</pre></details>` : ''}
    </div>`;
  }

  function draw() {
    const s = settings;
    const comfy = status.providers.comfyui;
    const comfyEngines = (comfy.engines || []);
    const ff = status.ffmpeg;
    body.innerHTML = `
    <div class="settings-grid">
      <section class="card">
        <h2>${icon('cpu')} Video engine</h2>
        <div class="stack">
          <label class="field">Engine<select class="select" data-k="provider">
            <option value="auto" ${s.provider === 'auto' ? 'selected' : ''}>Automatic — ComfyUI if running, otherwise local model (recommended)</option>
            <option value="comfyui" ${s.provider === 'comfyui' ? 'selected' : ''}>ComfyUI only</option>
            <option value="local" ${s.provider === 'local' ? 'selected' : ''}>Local model worker (Python) only</option>
            <option value="external" ${s.provider === 'external' ? 'selected' : ''}>External API (optional, paid)</option>
          </select></label>
          <div class="small muted">Currently generating with: <b style="color:var(--text)">${esc(status.activeProvider ? status.providers[status.activeProvider].label : 'no engine available')}</b></div>
          ${['comfyui', 'local', 'external'].map(id => providerCard(status.providers[id], status.activeProvider === id)).join('')}
        </div>
      </section>

      <section class="card">
        <h2>ComfyUI</h2>
        <div class="stack">
          <label class="field">ComfyUI URL
            <div class="row"><input class="input grow" data-k="comfyuiUrl" value="${esc(s.comfyuiUrl)}" placeholder="http://127.0.0.1:8188" style="width:auto">
            <button class="btn" id="testComfy">${icon('zap')} Test connection</button></div>
            <span class="hint" id="comfyTest"></span></label>
          <label class="field">ComfyUI install folder (optional — lets start.bat launch ComfyUI for you)
            <input class="input" data-k="comfyuiPath" value="${esc(s.comfyuiPath)}" placeholder="C:\\ComfyUI_windows_portable\\ComfyUI"></label>
          <label class="field">Model / workflow<select class="select" data-k="comfyuiModel">
            <option value="auto" ${s.comfyuiModel === 'auto' ? 'selected' : ''}>Automatic (fastest installed model)</option>
            ${comfyEngines.map(e => `<option value="${esc(e.id)}" ${s.comfyuiModel === e.id ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}
            ${s.comfyuiModel !== 'auto' && !comfyEngines.some(e => e.id === s.comfyuiModel) ? `<option value="${esc(s.comfyuiModel)}" selected>${esc(s.comfyuiModel)} (not found)</option>` : ''}
          </select><span class="hint">Custom workflows: export from ComfyUI with “Save (API format)” into the <code>workflows/</code> folder, using {{PROMPT}}, {{WIDTH}}, {{HEIGHT}}, {{FRAMES}}, {{FPS}}, {{SEED}}, {{IMAGE}} placeholders.</span></label>
          <div class="row"><a class="btn sm" href="/api/comfyui/workflow?mode=t2v" download>${icon('download')} Example T2V workflow JSON</a>
            <a class="btn sm" href="/api/comfyui/workflow?mode=i2v" download>${icon('download')} Example I2V workflow JSON</a></div>
        </div>
      </section>

      <section class="card">
        <h2>Local model worker</h2>
        <div class="stack">
          <label class="field">Model (Hugging Face id or local folder)
            <input class="input" data-k="localModel" value="${esc(s.localModel)}" list="localModels">
            <datalist id="localModels">${(status.providers.local.recommended || []).map(m => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join('')}</datalist>
            <span class="hint">Downloaded once into <code>models/</code>, then cached in GPU memory between generations.</span></label>
          <div class="field-row">
            <label class="field">GPU memory mode<select class="select" data-k="localOffload">
              ${[['auto', 'Automatic'], ['none', 'Keep all on GPU (fastest)'], ['model', 'CPU offload (less VRAM)'], ['sequential', 'Sequential offload (lowest VRAM, slow)']].map(([v, l]) => `<option value="${v}" ${s.localOffload === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
            <label class="field">Precision<select class="select" data-k="localDtype">
              ${[['auto', 'Automatic (BF16/FP16 on GPU)'], ['bf16', 'BF16'], ['fp16', 'FP16'], ['fp32', 'FP32']].map(([v, l]) => `<option value="${v}" ${s.localDtype === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
          </div>
          <div class="row"><button class="btn sm" id="preload">${icon('zap')} Load model now</button><span class="hint">Pre-loads the model so the next generation starts instantly.</span></div>
        </div>
      </section>

      <section class="card">
        <h2>Generation</h2>
        <div class="stack">
          <label class="field">Default speed / quality<select class="select" data-k="defaultQuality">
            <option value="fast" ${s.defaultQuality === 'fast' ? 'selected' : ''}>⚡ Fast — lowest latency (recommended)</option>
            <option value="balanced" ${s.defaultQuality === 'balanced' ? 'selected' : ''}>Balanced</option>
            <option value="quality" ${s.defaultQuality === 'quality' ? 'selected' : ''}>High quality (slower)</option></select></label>
          <label class="check"><input type="checkbox" data-k="upscaleOutput" ${s.upscaleOutput ? 'checked' : ''}> Upscale output to 720p with FFmpeg (fast, generation stays at low resolution)</label>
          <label class="check"><input type="checkbox" data-k="enhancePrompts" ${s.enhancePrompts ? 'checked' : ''}> Automatically enhance prompts into cinematic descriptions</label>
          <label class="check"><input type="checkbox" data-k="autoRetry" ${s.autoRetry ? 'checked' : ''}> Retry automatically when it is safe (GPU out of memory → lower resolution, worker crash, connection drop)</label>
          <label class="field">Hardware video encoder<select class="select" data-k="hardwareEncoder">
            <option value="auto" ${s.hardwareEncoder === 'auto' ? 'selected' : ''}>Automatic (${esc(ff.hwEncoder || 'none detected — libx264')})</option>
            <option value="off" ${s.hardwareEncoder === 'off' ? 'selected' : ''}>Off (always libx264)</option></select></label>
          <div class="field-row">
            <label class="field">Local LLM for prompts (Ollama URL, optional)<input class="input" data-k="ollamaUrl" value="${esc(s.ollamaUrl)}" placeholder="http://127.0.0.1:11434"></label>
            <label class="field">Ollama model<input class="input" data-k="ollamaModel" value="${esc(s.ollamaModel)}"></label>
          </div>
          <span class="hint">With Ollama you can also write prompts in Arabic or any other language — they are translated automatically.</span>
        </div>
      </section>

      <section class="card">
        <h2>${icon('mic')} Voice (text-to-speech)</h2>
        <div class="stack">
          ${voices.length ? '' : '<div class="banner warn">No local TTS engine found. Install Piper or espeak-ng (setup.bat does this), or use the built-in Windows voices.</div>'}
          <div class="field-row">
            <label class="field">Engine<select class="select" data-k="ttsEngine">
              <option value="auto" ${s.ttsEngine === 'auto' ? 'selected' : ''}>Automatic</option>
              ${voices.map(e => `<option value="${e.id}" ${s.ttsEngine === e.id ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}
            </select></label>
            <label class="field">Default voice<select class="select" data-k="ttsVoice"><option value="">Engine default</option>
              ${voices.map(e => `<optgroup label="${esc(e.label)}">${e.voices.map(v => `<option value="${esc(v.id)}" ${s.ttsVoice === v.id ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</optgroup>`).join('')}
            </select></label>
          </div>
          <label class="field">Piper voice model (.onnx, optional)<input class="input" data-k="piperVoice" value="${esc(s.piperVoice)}" placeholder="models/piper/en_US-lessac-medium.onnx"></label>
        </div>
      </section>

      <section class="card">
        <h2>Optional external provider</h2>
        <div class="stack">
          <div class="banner warn">${icon('alert')}<div class="banner-body"><strong>Costs money per video.</strong><p>Not needed — local generation is free. Only use this if you have no suitable GPU.</p></div></div>
          <label class="field">API URL (Replicate-compatible)<input class="input" data-k="externalApiUrl" value="${esc(s.externalApiUrl)}"></label>
          <div class="field-row">
            <label class="field">API token<input class="input" type="password" data-k="externalApiToken" value="${esc(s.externalApiToken)}" autocomplete="off"></label>
            <label class="field">Model<input class="input" data-k="externalModel" value="${esc(s.externalModel)}"></label>
          </div>
          <label class="field">Extra model input (JSON)<input class="input mono" data-k="externalExtraInput" value="${esc(s.externalExtraInput)}" placeholder='{"num_frames": 121}'></label>
        </div>
      </section>

      <div class="row" style="position:sticky;bottom:12px;justify-content:flex-end;z-index:5">
        <button class="btn primary lg" id="save">${icon('check')} Save settings</button>
      </div>

      <section class="card">
        <h2>System</h2>
        <table class="sys-table">
          <tr><td>OpenReel Studio</td><td>${esc(status.app.version)} · Node ${esc(status.app.node)} · ${esc(status.app.platform)} · ${status.app.cpus} CPU cores · ${status.app.ramGB} GB RAM</td></tr>
          <tr><td>FFmpeg</td><td>${ff.available ? `${esc(ff.version)} ${ff.ffprobe ? '' : '<span class="badge err">ffprobe missing</span>'}` : `<span class="badge err">Not found</span> ${esc(ff.error || '')}`}</td></tr>
          <tr><td>Video encoder</td><td>${ff.hwEncoder ? `<span class="badge ok">${esc(ff.hwEncoder)}</span> GPU accelerated` : 'libx264 (CPU)'}</td></tr>
          <tr><td>FFmpeg filters</td><td>${Object.entries(ff.filters || {}).map(([k, v]) => `<span class="badge ${v ? 'ok' : 'err'}">${esc(k)}</span>`).join(' ')}</td></tr>
          <tr><td>Text-to-speech</td><td>${voices.length ? voices.map(e => `${esc(e.label)} (${e.voices.length})`).join(', ') : 'none'}</td></tr>
          <tr><td>Job queue</td><td>${status.queue.running} running · ${status.queue.waiting} waiting</td></tr>
        </table>
      </section>

      <section class="card">
        <div class="spread"><h2 style="margin:0">Developer logs</h2>
          <div class="row"><select class="select" id="logLevel" style="width:auto"><option value="">All</option><option value="info">Info+</option><option value="warn">Warnings+</option><option value="error">Errors</option></select>
          <label class="check"><input type="checkbox" id="logAuto" checked> Live</label></div></div>
        <div class="logs" id="logs" style="margin-top:12px">Loading…</div>
      </section>
    </div>`;
    loadLogs();
  }

  async function loadLogs() {
    const box = body.querySelector('#logs');
    if (!box) return;
    const level = body.querySelector('#logLevel').value;
    try {
      const lines = await api.get(`/api/system/logs?limit=300${level ? `&level=${level}` : ''}`);
      const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
      box.innerHTML = lines.length ? lines.map(l => `<div class="l-${l.level}">${esc(l.time.slice(11, 19))} [${esc(l.level)}] [${esc(l.scope)}] ${esc(l.message)}</div>`).join('') : 'No log entries yet.';
      if (atBottom) box.scrollTop = box.scrollHeight;
    } catch {
      box.textContent = 'Could not load logs.';
    }
  }

  body.addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'save') {
      const patch = {};
      body.querySelectorAll('[data-k]').forEach(el => { patch[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.value; });
      btn.disabled = true;
      try {
        settings = await api.saveSettings(patch);
        toast('Settings saved', { type: 'ok' });
        await load(true);
      } catch (err) {
        toastError(err, 'Could not save settings');
      } finally {
        btn.disabled = false;
      }
    }
    if (btn.id === 'testComfy') {
      const out = body.querySelector('#comfyTest');
      out.innerHTML = '<span class="spinner"></span> Testing…';
      try {
        const r = await api.post('/api/system/comfyui/test', { url: body.querySelector('[data-k=comfyuiUrl]').value });
        out.innerHTML = r.ok
          ? `<span style="color:var(--ok)">${icon('check')} Connected to ComfyUI ${esc(r.version || '')}${r.devices && r.devices[0] ? ` on ${esc(r.devices[0].name)}` : ''}. Save to use this URL.</span>`
          : `<span style="color:var(--err)">${esc(r.message)}</span> <span class="muted">(${esc(r.details || '')})</span>`;
      } catch (err) {
        out.textContent = err.message;
      }
    }
    if (btn.id === 'preload') {
      try {
        await api.post('/api/system/preload');
        toast('Loading the model in the background — watch the developer log.', { type: 'ok' });
      } catch (err) { toastError(err); }
    }
  });
  body.addEventListener('change', e => { if (e.target.id === 'logLevel') loadLogs(); });
  main.querySelector('#refreshAll').addEventListener('click', async () => {
    body.innerHTML = '<div class="empty"><span class="spinner"></span> Checking engines, GPU and FFmpeg…</div>';
    await load(true).catch(toastError);
  });
  logTimer = setInterval(() => { const auto = body.querySelector('#logAuto'); if (auto && auto.checked) loadLogs(); }, 3000);

  try {
    await load(false);
  } catch (err) {
    body.innerHTML = `<div class="banner err">${icon('alert')}<div class="banner-body"><strong>Could not load settings</strong><p>${esc(err.message)}</p></div></div>`;
  }
  return () => clearInterval(logTimer);
}
