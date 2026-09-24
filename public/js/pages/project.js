import { api, on, liveConnected } from '../api.js';
import {
  icon, esc, toast, toastError, confirmDialog, errorCard, fmtTime, fmtDuration, fmtBytes, timeAgo, aspectClass, STAGE_LABELS, videoTag,
} from '../ui.js';

const TRANSITIONS = [
  ['none', 'None (hard cut)'], ['fade', 'Crossfade'], ['fadeblack', 'Fade through black'], ['fadewhite', 'Fade through white'],
  ['dissolve', 'Dissolve'], ['wipeleft', 'Wipe'], ['slideleft', 'Slide'], ['smoothleft', 'Smooth slide'], ['circleopen', 'Circle open'],
  ['radial', 'Radial'], ['pixelize', 'Pixelize'],
];
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const TERMINAL = ['complete', 'completed', 'failed', 'cancelled'];

function defaultSpec(project) {
  return {
    aspectRatio: project.aspectRatio, fit: 'crop', resolution: 720, speed: 1, fadeInOut: true,
    transition: { type: 'fade', duration: 0.5 },
    music: null,
    voice: { text: sessionStorage.getItem(`openreel.voice.${project.id}`) || '', voiceKey: '', rate: 1, volume: 1, fitVideo: true, uploadId: null, uploadName: null },
    subtitles: { enabled: false, text: '', position: 'bottom' },
  };
}

export async function render(main, { id, query }) {
  let project;
  try {
    project = await api.project(id);
  } catch (err) {
    main.innerHTML = `<div class="page narrow"><div class="empty">${icon('alert')}<h3>Project not found</h3><p>${esc(err.message)}</p>
      <a class="btn" href="#/projects">${icon('back')} Back to projects</a></div></div>`;
    return;
  }
  const jobs = project.jobs || {};
  const snapAt = {};
  const specKey = `openreel.spec.${project.id}`;
  let spec;
  try { spec = { ...defaultSpec(project), ...JSON.parse(localStorage.getItem(specKey) || 'null') }; } catch { spec = defaultSpec(project); }
  const saveSpec = () => { try { localStorage.setItem(specKey, JSON.stringify(spec)); } catch { /* storage full/blocked */ } };
  let voices = null;

  const ui = {
    view: query.get('view') === 'final' && project.finalRenderId ? 'final' : 'scene',
    sceneId: query.get('scene') || (project.scenes.length ? project.scenes[project.scenes.length - 1].id : null),
    renderId: null,
    tab: 'scene',
    extendOpen: false,
    playerKey: null,
    promptDrafts: {},
  };

  main.innerHTML = `
  <div class="page">
    <div class="project-head">
      <a class="btn ghost icon-only" href="#/projects" aria-label="Back to projects">${icon('back')}</a>
      <input class="project-name" id="projName" aria-label="Project name" maxlength="80">
      <span id="headBadges" class="row"></span>
    </div>
    <div class="workspace">
      <div class="stage-panel">
        <div class="player" id="player"></div>
        <div class="action-bar" id="actions"></div>
        <div id="extendBox"></div>
        <section>
          <div class="spread" style="margin:6px 0 10px"><h2 style="margin:0">Scenes</h2><span class="small muted">Select a scene to preview · Extend to continue the story</span></div>
          <div class="timeline" id="timeline"></div>
        </section>
      </div>
      <aside class="side-panel">
        <div class="tabs" role="tablist">
          <button role="tab" data-tab="scene">Scene</button>
          <button role="tab" data-tab="final">Final video</button>
          <button role="tab" data-tab="details">Details</button>
        </div>
        <div class="card" id="panel"></div>
      </aside>
    </div>
  </div>`;
  const $ = sel => main.querySelector(sel);

  // ── State helpers ──────────────────────────────────────────────────────────────
  const selectedScene = () => project.scenes.find(s => s.id === ui.sceneId) || project.scenes[project.scenes.length - 1] || null;
  const activeTake = scene => (scene ? scene.takes.find(t => t.id === scene.activeTakeId) || scene.takes[scene.takes.length - 1] : null);
  const selectedRender = () => {
    const list = project.renders || [];
    return list.find(r => r.id === ui.renderId) || list.find(r => r.id === project.finalRenderId) || list[list.length - 1] || null;
  };
  const anyRunning = () => project.scenes.some(s => s.takes.some(t => ['queued', 'running'].includes(t.status))) ||
    (project.renders || []).some(r => ['queued', 'running'].includes(r.status));

  function live(rec) {
    if (!rec) return null;
    const job = rec.jobId && jobs[rec.jobId];
    const base = { ...rec };
    if (job) {
      Object.assign(base, {
        stage: job.stage, progress: job.progress, message: job.message, etaSec: job.etaSec, elapsedSec: job.elapsedSec,
        step: job.step, totalSteps: job.totalSteps, error: job.error || rec.error, logs: job.logs || rec.logs,
        jobStatus: job.status, startedAt: job.startedAt,
      });
      if (job.status === 'running' || job.status === 'queued') base.status = job.status;
      else if (job.status === 'failed' || job.status === 'cancelled') base.status = job.status;
      else if (job.status === 'completed' && rec.status !== 'complete') base.status = 'finishing';
    }
    return base;
  }

  function currentItem() {
    if (ui.view === 'final') {
      const r = selectedRender();
      if (r) return { kind: 'render', rec: live(r) };
      // No render record (yet): show the scene without changing the selected view.
    }
    const scene = selectedScene();
    return { kind: 'take', scene, rec: live(activeTake(scene)) };
  }

  function posterFor(scene) {
    if (!scene) return null;
    if (scene.sourceImage && scene.sourceImage.type === 'lastFrame') {
      for (const s of project.scenes) {
        const t = s.takes.find(x => x.id === scene.sourceImage.takeId);
        if (t && t.lastFrame) return t.lastFrame;
      }
    }
    if (scene.sourceImage && scene.sourceImage.type === 'upload') {
      const up = project.uploads.find(u => u.id === scene.sourceImage.uploadId);
      if (up) return up.url;
    }
    const done = scene.takes.find(t => t.thumbnail);
    return done ? done.thumbnail : null;
  }

  // ── Header ─────────────────────────────────────────────────────────────────────
  function renderHead() {
    const nameEl = $('#projName');
    if (document.activeElement !== nameEl) nameEl.value = project.name;
    nameEl.size = Math.max(12, Math.min(48, nameEl.value.length + 2));
    const done = project.scenes.filter(s => (activeTake(s) || {}).status === 'complete').length;
    $('#headBadges').innerHTML = `<span class="badge">${esc(project.aspectRatio)}</span>
      <span class="badge">${project.scenes.length} scene${project.scenes.length === 1 ? '' : 's'}</span>
      ${anyRunning() ? '<span class="badge info">Generating</span>' : done ? '<span class="badge ok">Ready</span>' : ''}`;
  }
  $('#projName').addEventListener('change', async e => {
    const name = e.target.value.trim();
    if (!name || name === project.name) { e.target.value = project.name; return; }
    try { await api.patch(`/api/projects/${project.id}`, { name }); project.name = name; toast('Project renamed', { type: 'ok' }); } catch (err) { toastError(err); }
  });

  // ── Player ─────────────────────────────────────────────────────────────────────
  function progressCard(rec) {
    const heading = rec && rec.kind === 'render' ? 'Rendering final video' : 'Generating video';
    return `<div class="progress-card" aria-live="polite">
      <p class="progress-msg"><span class="spinner"></span><span data-p="msg">${esc(heading)}</span></p>
      <div class="stepper">${STAGE_LABELS.map(([k, l]) => `<div class="st" data-st="${k}">${esc(l)}</div>`).join('')}</div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><div data-p="bar" style="width:0%"></div></div>
      <div class="progress-meta">
        <span><b data-p="pct">0%</b> <span data-p="step"></span></span>
        <span>Elapsed <b data-p="elapsed">0:00</b></span>
        <span>Remaining <b data-p="eta">measuring…</b></span>
      </div>
      <div class="slow-note" data-p="slow" hidden></div>
      <div class="row" style="margin-top:14px"><button class="btn danger sm" data-action="cancel">${icon('stop')} Cancel</button></div>
    </div>`;
  }

  function renderPlayer(force = false) {
    const player = $('#player');
    const item = currentItem();
    const rec = item.rec;
    const status = rec ? rec.status : 'empty';
    const key = `${item.kind}:${rec ? rec.id : '-'}:${status}:${rec && rec.video ? rec.video : ''}`;
    const aspect = item.kind === 'render' && rec && rec.width ? (rec.width > rec.height ? '16:9' : rec.width < rec.height ? '9:16' : '1:1') : project.aspectRatio;
    // Progress/error cards need room: use the wide layout until there is a finished video to show.
    const showsVideo = status === 'complete' && rec && rec.video;
    player.className = `player ${showsVideo ? aspectClass(aspect) : 'ar-16x9'}`;
    if (key === ui.playerKey && !force) { updateProgress(); return; }
    const wasRunning = ui.playerKey && /:(queued|running|finishing):/.test(ui.playerKey) && ui.playerKey.split(':')[1] === (rec && rec.id);
    ui.playerKey = key;
    if (!rec) {
      player.innerHTML = `<div class="player-overlay"><div class="empty" style="border:0">${icon('film')}<h3>No scenes yet</h3><a class="btn primary" href="#/create">${icon('sparkles')} Create a video</a></div></div>`;
      return;
    }
    if (status === 'complete' && rec.video) {
      player.innerHTML = videoTag(rec.video, rec.id, `${rec.thumbnail ? `poster="${esc(rec.thumbnail)}"` : ''} controls playsinline preload="metadata" ${wasRunning ? 'autoplay muted' : ''}`);
      return;
    }
    const poster = item.kind === 'take' ? posterFor(item.scene) : null;
    const bg = poster ? `<div class="poster-bg" style="background-image:url('${esc(poster)}')"></div>` : '';
    if (['queued', 'running', 'finishing'].includes(status)) {
      player.innerHTML = `<div class="player-overlay">${bg}${progressCard({ kind: item.kind })}</div>`;
      updateProgress();
    } else if (status === 'failed') {
      player.innerHTML = `<div class="player-overlay" style="overflow:auto">${bg}${errorCard(rec.error, {
        logs: rec.logs || [], heading: item.kind === 'render' ? 'Rendering failed.' : 'Generation failed.',
        retryLabel: item.kind === 'render' ? 'Render again' : 'Regenerate' })}</div>`;
    } else if (status === 'cancelled') {
      player.innerHTML = `<div class="player-overlay">${bg}<div class="progress-card" style="text-align:center"><h3>Cancelled</h3>
        <p class="muted small">This ${item.kind === 'render' ? 'render' : 'generation'} was cancelled.</p>
        <button class="btn primary sm" data-action="retry">${icon('refresh')} ${item.kind === 'render' ? 'Render again' : 'Generate again'}</button></div></div>`;
    } else {
      player.innerHTML = `<div class="player-overlay">${bg}<div class="progress-card"><span class="spinner"></span> Loading…</div></div>`;
    }
  }

  function updateProgress() {
    const player = $('#player');
    const card = player.querySelector('.progress-card [data-p="bar"]');
    if (!card) return;
    const rec = currentItem().rec;
    if (!rec) return;
    const pct = Math.round((rec.status === 'finishing' ? 1 : rec.progress || 0) * 100);
    const stage = rec.status === 'finishing' ? 'complete' : rec.stage || 'queued';
    const idx = STAGE_LABELS.findIndex(([k]) => k === stage);
    player.querySelectorAll('.stepper .st').forEach((el, i) => {
      el.classList.toggle('done', i < idx || stage === 'complete');
      el.classList.toggle('current', i === idx && stage !== 'complete');
    });
    const set = (k, v) => { const el = player.querySelector(`[data-p="${k}"]`); if (el) el.textContent = v; };
    player.querySelector('[data-p="bar"]').style.width = `${pct}%`;
    player.querySelector('.bar').setAttribute('aria-valuenow', String(pct));
    set('pct', `${pct}%`);
    set('msg', rec.status === 'finishing' ? 'Finishing…' : rec.message || 'Working…');
    set('step', rec.step && rec.totalSteps ? `· step ${rec.step}/${rec.totalSteps}` : '');
    const job = rec.jobId && jobs[rec.jobId];
    const running = job && job.status === 'running';
    const elapsed = job ? (job.elapsedSec || 0) + (running && snapAt[job.id] ? (Date.now() - snapAt[job.id]) / 1000 : 0) : rec.elapsedSec || 0;
    set('elapsed', fmtTime(elapsed));
    let eta = rec.etaSec;
    if (eta != null && running && snapAt[job.id]) eta = Math.max(0, eta - (Date.now() - snapAt[job.id]) / 1000);
    set('eta', stage === 'queued' ? '–' : eta != null ? `~${fmtTime(eta)}` : stage === 'encoding' ? 'a few seconds' : 'measuring…');
    const slow = player.querySelector('[data-p="slow"]');
    if (slow) {
      const total = eta != null ? elapsed + eta : null;
      if (total && total > 120 && ['generating', 'processing'].includes(stage)) {
        slow.hidden = false;
        slow.textContent = `On this hardware this ${currentItem().kind === 'render' ? 'render' : 'generation'} takes about ${Math.ceil(total / 60)} min in total. ` +
          'For faster results choose ⚡ Fast quality or a shorter duration.';
      } else slow.hidden = true;
    }
    const cancelBtn = player.querySelector('[data-action="cancel"]');
    if (cancelBtn) cancelBtn.disabled = rec.status === 'finishing';
  }

  // ── Actions ────────────────────────────────────────────────────────────────────
  function renderActions() {
    const item = currentItem();
    const rec = item.rec;
    const busy = rec && ['queued', 'running', 'finishing'].includes(rec.status);
    const final = selectedRender();
    let html;
    if (item.kind === 'render') {
      html = `<button class="btn" data-action="scenes">${icon('back')} Back to scenes</button>
        ${rec.status === 'complete' ? `<a class="btn primary" href="/api/video/${rec.id}/download" download>${icon('download')} Download MP4</a>` : ''}
        <span class="spacer"></span>
        <button class="btn" data-action="rerender" ${busy ? 'disabled' : ''}>${icon('refresh')} Render again</button>`;
    } else if (!item.scene) {
      html = '';
    } else {
      const done = rec && rec.status === 'complete';
      html = `<button class="btn" data-action="regenerate" ${busy ? 'disabled' : ''} title="Generate another version of this scene with a new seed">${icon('refresh')} Regenerate</button>
        <button class="btn" data-action="extend" ${done ? '' : 'disabled'} title="Continue this video with a new scene">${icon('plus')} Extend video</button>
        ${done ? `<a class="btn" href="/api/video/${rec.id}/download" download>${icon('download')} Download</a>` : `<button class="btn" disabled>${icon('download')} Download</button>`}
        ${busy ? `<button class="btn danger" data-action="cancel">${icon('stop')} Cancel</button>` : ''}
        <span class="spacer"></span>
        ${final && final.status === 'complete' ? `<button class="btn" data-action="viewfinal">${icon('film')} View final video</button>` : ''}
        <button class="btn primary" data-action="gofinal" ${project.scenes.some(s => (activeTake(s) || {}).status === 'complete') ? '' : 'disabled'}>${icon('layers')} Finish &amp; export</button>`;
    }
    $('#actions').innerHTML = html;
  }

  function renderExtendBox() {
    const box = $('#extendBox');
    const scene = selectedScene();
    if (!ui.extendOpen || !scene) { box.innerHTML = ''; return; }
    box.innerHTML = `<form class="extend-box" id="extendForm">
      <div class="spread"><h3 style="margin:0">${icon('plus')} What happens next?</h3><button type="button" class="btn ghost sm icon-only" data-action="closeextend" aria-label="Close">${icon('x')}</button></div>
      <textarea class="textarea" id="extPrompt" maxlength="2000" placeholder="e.g. he picks up the product and smiles at the camera"></textarea>
      <div class="spread">
        <div class="chips" id="extDur">${[3, 5, 8, 10].map(d => `<button type="button" class="chip" data-extdur="${d}" aria-pressed="${d === scene.duration}">${d}s</button>`).join('')}</div>
        <button type="submit" class="btn primary">${icon('sparkles')} Generate next scene</button>
      </div>
      <p class="small muted" style="margin:0">Scene ${scene.index + 1} starts from the last frame of Scene ${scene.index} and keeps the same character, product, location and style.</p>
    </form>`;
    $('#extPrompt').focus();
    $('#extendForm').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = e.target.querySelector('[type=submit]');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Starting…';
      const dur = Number((box.querySelector('[data-extdur][aria-pressed=true]') || {}).dataset?.extdur || scene.duration);
      try {
        const res = await api.extend({ projectId: project.id, sceneId: scene.id, prompt: $('#extPrompt').value.trim(), duration: dur });
        ui.extendOpen = false;
        ui.sceneId = res.sceneId;
        ui.view = 'scene';
        if (res.promptNote) toast(res.promptNote, { type: 'warn' });
        await refetch();
      } catch (err) {
        toastError(err, 'Could not extend the video');
        btn.disabled = false;
        btn.innerHTML = `${icon('sparkles')} Generate next scene`;
      }
    });
  }

  // ── Timeline ───────────────────────────────────────────────────────────────────
  function renderTimeline() {
    const tl = $('#timeline');
    tl.innerHTML = project.scenes.map((s, i) => {
      const t = live(activeTake(s));
      const st = t ? t.status : 'none';
      const selected = ui.view === 'scene' && s.id === (selectedScene() || {}).id;
      const badge = st === 'complete' ? `<span class="badge">${fmtDuration(t.durationSec)}</span>`
        : ['queued', 'running', 'finishing'].includes(st) ? `<span class="badge info">${Math.round((t.progress || 0) * 100)}%</span>`
          : st === 'failed' ? '<span class="badge err">Failed</span>' : st === 'cancelled' ? '<span class="badge warn">Cancelled</span>' : '';
      const poster = t && t.thumbnail ? t.thumbnail : posterFor(s);
      return `<div class="scene-card ${selected ? 'selected' : ''}" data-scene="${s.id}" tabindex="0" role="button" aria-label="Scene ${s.index}">
        <div class="scene-thumb">
          ${poster ? `<img src="${esc(poster)}" alt="" loading="lazy" style="${st === 'complete' ? '' : 'opacity:.35;filter:blur(2px)'}">` : ''}
          ${['queued', 'running', 'finishing'].includes(st) ? `<span class="spinner" style="position:absolute"></span><div class="mini-bar"><div style="width:${Math.round((t.progress || 0) * 100)}%"></div></div>` : ''}
          ${st === 'failed' ? `<span style="position:absolute;color:var(--err)">${icon('alert')}</span>` : ''}
        </div>
        <div class="scene-info">
          <div class="scene-title"><span>Scene ${s.index}${s.extendedFrom ? ' <span class="muted small">· extended</span>' : ''}</span>${badge}</div>
          <div class="scene-prompt" title="${esc(s.prompt)}">${esc(s.prompt || 'Image animation')}</div>
          <div class="spread">
            <div class="takes">${s.takes.map((tk, n) => `<button class="take-dot ${tk.id === s.activeTakeId ? 'active' : ''} ${tk.status === 'failed' ? 'failed' : ''}"
              data-take="${tk.id}" data-scene-of="${s.id}" title="Version ${n + 1} · ${esc(tk.status)}">v${n + 1}</button>`).join('')}</div>
            <div class="scene-tools">
              <button class="btn ghost sm icon-only" data-move="-1" data-scene-of="${s.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move left">${icon('left')}</button>
              <button class="btn ghost sm icon-only" data-move="1" data-scene-of="${s.id}" ${i === project.scenes.length - 1 ? 'disabled' : ''} aria-label="Move right">${icon('right')}</button>
              <button class="btn ghost sm icon-only" data-delscene="${s.id}" aria-label="Delete scene">${icon('trash')}</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join('') + (project.scenes.length ? (() => {
      const ready = (activeTake(selectedScene()) || {}).status === 'complete';
      return `<button class="add-scene" data-action="extend" ${ready ? '' : 'disabled style="opacity:.45;cursor:not-allowed"'} title="${ready ? 'Continue from the selected scene' : 'Available when the selected scene has finished'}">${icon('plus')}<span class="small">Extend video</span></button>`;
    })() : '');
  }

  // ── Side panel ─────────────────────────────────────────────────────────────────
  function renderPanel() {
    main.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab)));
    const panel = $('#panel');
    if (ui.tab === 'scene') panel.innerHTML = scenePanel();
    else if (ui.tab === 'final') { panel.innerHTML = finalPanel(); wireFinalPanel(); }
    else panel.innerHTML = detailsPanel();
  }

  function scenePanel() {
    const s = selectedScene();
    if (!s) return '<p class="muted">No scene selected.</p>';
    const t = activeTake(s);
    const dur = t && t.durationSec ? t.durationSec : s.duration;
    const draft = ui.promptDrafts[s.id] ?? s.prompt;
    return `
      <div class="panel-section">
        <h3>${icon('type')} Scene ${s.index} prompt</h3>
        <textarea class="textarea" id="scenePrompt" maxlength="2000">${esc(draft)}</textarea>
        <div class="row"><button class="btn sm" data-action="regenprompt">${icon('refresh')} Regenerate with this prompt</button></div>
        <details class="devlog"><summary>AI-enhanced prompt (${esc(s.promptEngine === 'ollama' ? 'local LLM' : 'built-in engine')})</summary><pre>${esc(s.enhancedPrompt || s.prompt)}</pre></details>
      </div>
      <div class="panel-section">
        <h3>${icon('scissors')} Trim &amp; speed</h3>
        <div class="field-row" style="grid-template-columns:1fr 1fr">
          <label class="field">Start (s)<input class="input" type="number" id="trimStart" min="0" max="${dur}" step="0.1" value="${s.trim ? s.trim.start : 0}"></label>
          <label class="field">End (s)<input class="input" type="number" id="trimEnd" min="0" max="${dur}" step="0.1" value="${s.trim && s.trim.end != null ? s.trim.end : ''}" placeholder="${dur ? dur.toFixed(1) : ''}"></label>
        </div>
        <label class="field">Playback speed<select class="select" id="sceneSpeed">${SPEEDS.map(v => `<option value="${v}" ${Number(s.speed || 1) === v ? 'selected' : ''}>${v}×</option>`).join('')}</select></label>
        <div class="row"><button class="btn sm" data-action="savetrim">${icon('check')} Save</button><span class="hint">Applied when you render the final video.</span></div>
      </div>`;
  }

  function voiceOptions() {
    if (!voices) return '<option value="">Loading voices…</option>';
    if (!voices.length) return '<option value="">No local TTS engine installed</option>';
    return voices.map(e => `<optgroup label="${esc(e.label)}">${e.voices.map(v => {
      const key = `${e.id}::${v.id}`;
      return `<option value="${esc(key)}" ${spec.voice.voiceKey === key ? 'selected' : ''}>${esc(v.label)}</option>`;
    }).join('')}</optgroup>`).join('');
  }

  function finalPanel() {
    const renders = [...(project.renders || [])].reverse();
    const ready = project.scenes.filter(s => (activeTake(s) || {}).status === 'complete').length;
    return `
      <div class="panel-section">
        <h3>${icon('layers')} Combine ${ready} scene${ready === 1 ? '' : 's'} into one video</h3>
        <span class="opt-label" style="margin:0">Aspect ratio</span>
        <div class="segmented" id="fAspect">${['16:9', '9:16', '1:1', 'original'].map(a => `<button type="button" data-faspect="${a}" aria-pressed="${spec.aspectRatio === a}">${a === 'original' ? 'Original' : a}</button>`).join('')}</div>
        <div class="field-row" style="grid-template-columns:1fr 1fr">
          <label class="field">Fit<select class="select" data-spec="fit">
            <option value="crop" ${spec.fit === 'crop' ? 'selected' : ''}>Crop to fill</option>
            <option value="blur" ${spec.fit === 'blur' ? 'selected' : ''}>Blurred background</option>
            <option value="pad" ${spec.fit === 'pad' ? 'selected' : ''}>Black bars</option></select></label>
          <label class="field">Resolution<select class="select" data-spec="resolution">${[480, 720, 1080].map(r => `<option value="${r}" ${Number(spec.resolution) === r ? 'selected' : ''}>${r}p</option>`).join('')}</select></label>
        </div>
      </div>
      <div class="panel-section">
        <h3>${icon('film')} Transitions &amp; speed</h3>
        <div class="field-row" style="grid-template-columns:1fr 1fr">
          <label class="field">Transition<select class="select" data-spec="transition.type">${TRANSITIONS.map(([v, l]) => `<option value="${v}" ${spec.transition.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field">Playback speed<select class="select" data-spec="speed">${SPEEDS.map(v => `<option value="${v}" ${Number(spec.speed) === v ? 'selected' : ''}>${v}×</option>`).join('')}</select></label>
        </div>
        <label class="field">Transition length: <span id="tdLabel">${spec.transition.duration}s</span><input type="range" min="0.2" max="1.5" step="0.1" value="${spec.transition.duration}" data-spec="transition.duration"></label>
        <label class="check"><input type="checkbox" data-spec="fadeInOut" ${spec.fadeInOut ? 'checked' : ''}> Fade in from / out to black</label>
      </div>
      <div class="panel-section">
        <h3>${icon('music')} Background music</h3>
        ${spec.music ? `<div class="spread"><span class="small">${icon('music')} ${esc(spec.music.name)}</span><button class="btn ghost sm" data-action="rmmusic">${icon('x')} Remove</button></div>
          <label class="field">Volume: <span id="mvLabel">${Math.round(spec.music.volume * 100)}%</span><input type="range" min="0" max="1" step="0.05" value="${spec.music.volume}" data-spec="music.volume"></label>`
          : `<button class="btn sm" data-action="addmusic">${icon('upload')} Upload music (MP3, WAV, M4A…)</button>`}
        <input type="file" id="musicInput" accept="audio/*" hidden>
      </div>
      <div class="panel-section">
        <h3>${icon('mic')} Voice-over</h3>
        ${spec.voice.uploadId ? `<div class="spread"><span class="small">${icon('mic')} ${esc(spec.voice.uploadName)}</span><button class="btn ghost sm" data-action="rmvoicefile">${icon('x')} Remove</button></div>` : `
        <textarea class="textarea" data-spec="voice.text" maxlength="5000" placeholder="e.g. Welcome to my new product.">${esc(spec.voice.text)}</textarea>
        <label class="field">Voice<select class="select" data-spec="voice.voiceKey">${voiceOptions()}</select></label>
        <label class="field">Speaking rate: <span id="vrLabel">${spec.voice.rate}×</span><input type="range" min="0.7" max="1.4" step="0.05" value="${spec.voice.rate}" data-spec="voice.rate"></label>
        <div class="row"><button class="btn sm" data-action="previewvoice">${icon('volume')} Preview voice</button><audio id="voicePreview" controls hidden style="height:32px;max-width:100%"></audio></div>
        <button class="btn ghost sm" data-action="addvoicefile">${icon('upload')} …or upload your own recording</button>`}
        <input type="file" id="voiceInput" accept="audio/*" hidden>
        <label class="check"><input type="checkbox" data-spec="voice.fitVideo" ${spec.voice.fitVideo ? 'checked' : ''}> Extend the video if the voice is longer</label>
      </div>
      <div class="panel-section">
        <h3>${icon('captions')} Subtitles</h3>
        <label class="check"><input type="checkbox" data-spec="subtitles.enabled" ${spec.subtitles.enabled ? 'checked' : ''}> Burn subtitles into the video</label>
        ${spec.subtitles.enabled ? `
        <textarea class="textarea" data-spec="subtitles.text" maxlength="5000" placeholder="Leave empty to use the voice-over text">${esc(spec.subtitles.text)}</textarea>
        <label class="field">Position<select class="select" data-spec="subtitles.position">${['bottom', 'middle', 'top'].map(p => `<option value="${p}" ${spec.subtitles.position === p ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></label>` : ''}
      </div>
      <div class="panel-section">
        <button class="btn primary" data-action="render" ${ready ? '' : 'disabled'}>${icon('film')} Render final video</button>
        ${ready ? '' : '<p class="hint">Generate at least one scene first.</p>'}
      </div>
      <div class="panel-section" id="rendersList">
        <h3>${icon('download')} Exports</h3>
        ${renders.length ? `<div class="renders-list">${renders.map(r => {
          const lr = live(r);
          return `<div class="render-item">
            ${r.thumbnail ? `<img src="${esc(r.thumbnail)}" alt="">` : `<div style="width:64px;height:36px;display:grid;place-items:center">${icon('film')}</div>`}
            <div class="grow"><div>${timeAgo(r.createdAt)}${r.durationSec ? ` · ${fmtDuration(r.durationSec)}` : ''}${r.sizeBytes ? ` · ${fmtBytes(r.sizeBytes)}` : ''}</div>
              <div class="small muted">${lr.status === 'complete' ? `${r.width}×${r.height}` : lr.status === 'failed' ? 'Failed' : lr.status === 'cancelled' ? 'Cancelled' : `${Math.round((lr.progress || 0) * 100)}% · ${esc(lr.message || '')}`}</div></div>
            <button class="btn ghost sm icon-only" data-viewrender="${r.id}" aria-label="View">${icon('play')}</button>
            ${r.status === 'complete' ? `<a class="btn ghost sm icon-only" href="/api/video/${r.id}/download" download aria-label="Download">${icon('download')}</a>` : ''}
          </div>`;
        }).join('')}</div>` : '<p class="hint">Rendered videos appear here.</p>'}
      </div>`;
  }

  function setSpec(path, value) {
    const keys = path.split('.');
    let obj = spec;
    while (keys.length > 1) obj = obj[keys.shift()];
    obj[keys[0]] = value;
    saveSpec();
  }

  function wireFinalPanel() {
    const panel = $('#panel');
    panel.querySelectorAll('[data-spec]').forEach(el => {
      const evt = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        const path = el.dataset.spec;
        let value = el.type === 'checkbox' ? el.checked : el.value;
        if (el.type === 'range' || path === 'resolution' || path === 'speed') value = Number(value);
        setSpec(path, value);
        if (path === 'transition.duration') $('#tdLabel').textContent = `${value}s`;
        if (path === 'music.volume') $('#mvLabel').textContent = `${Math.round(value * 100)}%`;
        if (path === 'voice.rate') $('#vrLabel').textContent = `${value}×`;
        if (path === 'subtitles.enabled') renderPanel();
      });
    });
    const musicInput = panel.querySelector('#musicInput');
    musicInput.addEventListener('change', async () => {
      const file = musicInput.files[0];
      if (!file) return;
      toast(`Uploading ${file.name}…`);
      try {
        const up = await api.upload(file);
        spec.music = { uploadId: up.id, name: up.originalName, volume: 0.35 };
        saveSpec();
        renderPanel();
      } catch (err) { toastError(err, 'Music upload failed'); }
    });
    const voiceInput = panel.querySelector('#voiceInput');
    voiceInput.addEventListener('change', async () => {
      const file = voiceInput.files[0];
      if (!file) return;
      try {
        const up = await api.upload(file);
        spec.voice.uploadId = up.id;
        spec.voice.uploadName = up.originalName;
        saveSpec();
        renderPanel();
      } catch (err) { toastError(err, 'Voice upload failed'); }
    });
  }

  function detailsPanel() {
    const item = currentItem();
    const rec = item.rec;
    if (!rec) return '<p class="muted">Nothing selected.</p>';
    const rows = [];
    const add = (k, v) => { if (v !== undefined && v !== null && v !== '') rows.push(`<dt>${esc(k)}</dt><dd>${v}</dd>`); };
    if (item.kind === 'take') {
      const s = item.scene;
      add('Scene', `${s.index} · version ${s.takes.findIndex(t => t.id === rec.id) + 1} of ${s.takes.length}`);
      add('Mode', esc((rec.modeUsed || s.mode) === 'i2v' ? 'Image to Video' : 'Text to Video'));
      add('Status', esc(rec.status));
      add('Engine', esc([rec.provider, rec.engine].filter(Boolean).join(' · ')));
      add('Model', esc(rec.model));
      add('Device', esc(rec.device));
      add('Seed', esc(rec.seed));
      if (rec.plan) add('Generated at', esc(`${rec.plan.width}×${rec.plan.height}, ${rec.plan.segments.join('+')} frames, ${rec.plan.steps} steps (${rec.plan.quality})`));
    } else {
      add('Status', esc(rec.status));
      if (rec.spec) add('Settings', esc(`${rec.spec.aspectRatio} · ${rec.spec.fit} · ${rec.spec.transition.type} · ${rec.spec.speed}×`));
      if (rec.voice) add('Voice', esc(`${rec.voice.engine} / ${rec.voice.voice} (${fmtDuration(rec.voice.durationSec)})`));
      if (rec.subtitles) add('Subtitles', `<a href="${esc(rec.subtitles.srt)}" download>SRT file</a>`);
    }
    add('Output', rec.width ? esc(`${rec.width}×${rec.height} @ ${rec.fps}fps · ${fmtDuration(rec.durationSec)} · ${fmtBytes(rec.sizeBytes)}`) : '');
    if (rec.timings) add('Time', esc(`${fmtTime(rec.timings.totalSec)} total · generate ${rec.timings.generateSec}s · encode ${rec.timings.encodeSec}s`));
    add('Encoder', esc(rec.encoder));
    add('Created', esc(new Date(rec.createdAt).toLocaleString()));
    const logs = (rec.logs || []).map(l => `${new Date(l.t).toLocaleTimeString()}  ${l.message}`).join('\n');
    return `<div class="panel-section"><h3>${icon('info')} ${item.kind === 'take' ? 'Scene details' : 'Export details'}</h3><dl class="kv">${rows.join('')}</dl>
      ${item.kind === 'take' && rec.provider === 'comfyui' ? `<a class="btn sm" href="/media/${project.id}/scenes/${rec.id}/workflow-0.json" download>${icon('download')} ComfyUI workflow JSON</a>` : ''}</div>
      <div class="panel-section"><details class="devlog" ${rec.status === 'failed' ? 'open' : ''}><summary>Developer log</summary><pre>${esc(logs || 'No log entries.')}${rec.error && rec.error.details ? `\n\n${esc(rec.error.details)}` : ''}</pre></details></div>`;
  }

  // ── Events ─────────────────────────────────────────────────────────────────────
  main.addEventListener('click', async e => {
    const el = e.target.closest('button, [data-scene]');
    if (!el) return;
    const act = el.dataset.action;
    const item = currentItem();
    try {
      if (el.dataset.tab) { ui.tab = el.dataset.tab; renderPanel(); return; }
      if (el.dataset.take) {
        e.stopPropagation();
        await api.patch(`/api/projects/${project.id}/scenes/${el.dataset.sceneOf}`, { activeTakeId: el.dataset.take });
        ui.sceneId = el.dataset.sceneOf;
        ui.view = 'scene';
        await refetch();
        return;
      }
      if (el.dataset.move) {
        e.stopPropagation();
        const order = project.scenes.map(s => s.id);
        const i = order.indexOf(el.dataset.sceneOf);
        const j = i + Number(el.dataset.move);
        [order[i], order[j]] = [order[j], order[i]];
        await api.post(`/api/projects/${project.id}/scenes/reorder`, { order });
        await refetch();
        return;
      }
      if (el.dataset.delscene) {
        e.stopPropagation();
        const s = project.scenes.find(x => x.id === el.dataset.delscene);
        if (!(await confirmDialog({ title: `Delete scene ${s.index}?`, message: 'All versions of this scene will be deleted. This cannot be undone.', confirm: 'Delete', danger: true }))) return;
        await api.del(`/api/projects/${project.id}/scenes/${s.id}`);
        if (ui.sceneId === s.id) ui.sceneId = null;
        await refetch();
        return;
      }
      if (el.dataset.viewrender) { ui.view = 'final'; ui.renderId = el.dataset.viewrender; renderAll(); return; }
      if (el.dataset.faspect) { spec.aspectRatio = el.dataset.faspect; saveSpec(); renderPanel(); return; }
      if (el.dataset.extdur) { el.parentElement.querySelectorAll('[data-extdur]').forEach(b => b.setAttribute('aria-pressed', String(b === el))); return; }
      if (el.dataset.scene && !act) { ui.sceneId = el.dataset.scene; ui.view = 'scene'; renderAll(); return; }
      switch (act) {
        case 'cancel': {
          const rec = item.rec;
          if (!rec || !rec.jobId) return;
          el.disabled = true;
          await api.cancel(rec.jobId);
          toast('Cancelling…');
          break;
        }
        case 'regenerate':
        case 'retry':
          if (item.kind === 'render') { await startRender(); break; }
          if (!item.scene) return;
          await api.regenerate({ projectId: project.id, sceneId: item.scene.id });
          toast('Generating another version…');
          await refetch();
          break;
        case 'regenprompt': {
          const s = selectedScene();
          const prompt = $('#scenePrompt').value.trim();
          if (!prompt) return toast('The prompt cannot be empty.', { type: 'warn' });
          await api.regenerate({ projectId: project.id, sceneId: s.id, prompt });
          delete ui.promptDrafts[s.id];
          ui.view = 'scene';
          await refetch();
          break;
        }
        case 'extend':
          ui.extendOpen = true;
          renderExtendBox();
          break;
        case 'closeextend':
          ui.extendOpen = false;
          renderExtendBox();
          break;
        case 'savetrim': {
          const s = selectedScene();
          await api.patch(`/api/projects/${project.id}/scenes/${s.id}`, {
            trimStart: Number($('#trimStart').value) || 0, trimEnd: $('#trimEnd').value === '' ? null : Number($('#trimEnd').value), speed: Number($('#sceneSpeed').value),
          });
          toast('Trim & speed saved', { type: 'ok' });
          await refetch();
          break;
        }
        case 'gofinal':
          ui.tab = 'final';
          renderPanel();
          $('#panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
          break;
        case 'viewfinal':
          ui.view = 'final';
          ui.renderId = null;
          renderAll();
          break;
        case 'scenes':
          ui.view = 'scene';
          renderAll();
          break;
        case 'render':
        case 'rerender':
          await startRender();
          break;
        case 'addmusic': $('#musicInput').click(); break;
        case 'rmmusic': spec.music = null; saveSpec(); renderPanel(); break;
        case 'addvoicefile': $('#voiceInput').click(); break;
        case 'rmvoicefile': spec.voice.uploadId = null; spec.voice.uploadName = null; saveSpec(); renderPanel(); break;
        case 'previewvoice': {
          const text = spec.voice.text.trim();
          if (!text) return toast('Type the voice-over text first.', { type: 'warn' });
          el.disabled = true;
          el.innerHTML = '<span class="spinner"></span> Generating…';
          const [engine, voice] = (spec.voice.voiceKey || '').split('::');
          try {
            const r = await api.post('/api/tts/preview', { text: text.slice(0, 600), engine: engine || undefined, voice: voice || undefined, rate: spec.voice.rate });
            const audio = $('#voicePreview');
            audio.hidden = false;
            audio.src = r.url;
            audio.play().catch(() => {});
          } finally {
            el.disabled = false;
            el.innerHTML = `${icon('volume')} Preview voice`;
          }
          break;
        }
        default:
      }
    } catch (err) {
      toastError(err);
    }
  });
  main.addEventListener('keydown', e => {
    const card = e.target.closest('[data-scene]');
    if (card && (e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); card.click(); }
  });
  main.addEventListener('input', e => {
    if (e.target.id === 'scenePrompt') ui.promptDrafts[(selectedScene() || {}).id] = e.target.value;
  });

  async function startRender() {
    const [engine, voice] = (spec.voice.voiceKey || '').split('::');
    const body = {
      projectId: project.id,
      spec: {
        aspectRatio: spec.aspectRatio, fit: spec.fit, resolution: spec.resolution, speed: spec.speed, fadeInOut: spec.fadeInOut,
        transition: spec.transition,
        music: spec.music ? { uploadId: spec.music.uploadId, volume: spec.music.volume } : null,
        voice: spec.voice.uploadId ? { uploadId: spec.voice.uploadId, volume: spec.voice.volume, fitVideo: spec.voice.fitVideo }
          : spec.voice.text.trim() ? { text: spec.voice.text.trim(), engine: engine || undefined, voice: voice || undefined, rate: spec.voice.rate, volume: spec.voice.volume, fitVideo: spec.voice.fitVideo } : null,
        subtitles: { enabled: spec.subtitles.enabled, text: spec.subtitles.text, position: spec.subtitles.position },
      },
    };
    if (body.spec.subtitles.enabled && !body.spec.subtitles.text.trim() && !(body.spec.voice && body.spec.voice.text)) {
      return toast('Add subtitle text or a voice-over text to burn in subtitles.', { type: 'warn' });
    }
    const res = await api.render(body);
    ui.view = 'final';
    ui.renderId = res.renderId;
    // Show the render immediately; live job events may arrive before the project is re-fetched.
    if (!project.renders.some(r => r.id === res.renderId)) {
      project.renders.push({ id: res.renderId, jobId: res.jobId, status: 'queued', stage: 'queued', progress: 0, createdAt: new Date().toISOString() });
    }
    renderAll();
    toast('Rendering final video…');
    await refetch();
  }

  function renderAll() {
    renderHead();
    renderPlayer();
    renderActions();
    renderExtendBox();
    renderTimeline();
    renderPanel();
  }

  let refetchTimer = null;
  let refetching = false;
  async function refetch() {
    if (refetching) { scheduleRefetch(); return; }
    refetching = true;
    try {
      const fresh = await api.project(project.id);
      Object.assign(jobs, fresh.jobs || {});
      project = fresh;
      if (ui.sceneId && !project.scenes.some(s => s.id === ui.sceneId)) ui.sceneId = null;
      const panelFocused = $('#panel').contains(document.activeElement);
      renderHead();
      renderPlayer();
      renderActions();
      renderTimeline();
      if (!panelFocused || ui.tab === 'details') renderPanel();
      else if (ui.tab === 'final') { const list = $('#rendersList'); if (list) { const tmp = document.createElement('div'); tmp.innerHTML = finalPanel(); list.replaceWith(tmp.querySelector('#rendersList')); } }
    } catch (err) {
      if (err.status === 404) { location.hash = '#/projects'; return; }
    } finally {
      refetching = false;
    }
  }
  function scheduleRefetch(delay = 250) {
    clearTimeout(refetchTimer);
    refetchTimer = setTimeout(refetch, delay);
  }

  let tlTimer = null;
  const offJob = on('job', snap => {
    if (!snap.meta || snap.meta.projectId !== project.id) return;
    jobs[snap.id] = snap;
    snapAt[snap.id] = Date.now();
    renderPlayer();
    if (!tlTimer) tlTimer = setTimeout(() => { tlTimer = null; renderTimeline(); renderHead(); if (ui.tab === 'final') { const l = $('#rendersList'); if (l && !$('#panel').contains(document.activeElement)) renderPanel(); } }, 400);
    if (['completed', 'failed', 'cancelled'].includes(snap.status)) {
      scheduleRefetch(100);
      if (snap.status === 'completed') toast(snap.type === 'render' ? 'Final video is ready!' : 'Your video is ready!', { type: 'ok' });
    }
  });
  const offProject = on('project', e => {
    if (e.id !== project.id) return;
    if (e.deleted) { location.hash = '#/projects'; return; }
    scheduleRefetch(400);
  });
  // Elapsed/remaining counters tick locally; polling is the fallback when live events are unavailable.
  const ticker = setInterval(() => {
    updateProgress();
    if (!liveConnected && anyRunning()) refetch();
  }, 1000);

  api.get('/api/tts/voices').then(v => {
    voices = v;
    if (!spec.voice.voiceKey && v.length && v[0].voices.length) { spec.voice.voiceKey = `${v[0].id}::${v[0].voices[0].id}`; saveSpec(); }
    if (ui.tab === 'final' && !$('#panel').contains(document.activeElement)) renderPanel();
  }).catch(() => { voices = []; });

  renderAll();
  return () => {
    offJob();
    offProject();
    clearInterval(ticker);
    clearTimeout(refetchTimer);
    clearTimeout(tlTimer);
  };
}
