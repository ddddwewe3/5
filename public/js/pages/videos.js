import { api, on } from '../api.js';
import { icon, esc, fmtDuration, timeAgo, videoModal, videoTag, toastError } from '../ui.js';

export async function render(main) {
  let filter = 'all';
  let videos = [];
  main.innerHTML = `
  <div class="page">
    <div class="page-head">
      <div><h1>My Videos</h1><p>Every generated scene and exported final video — all real MP4 files on your disk.</p></div>
      <div class="filters" id="filters">
        <button class="chip" data-f="all">All</button>
        <button class="chip" data-f="final">${icon('layers')} Final videos</button>
        <button class="chip" data-f="scene">${icon('film')} Scenes</button>
      </div>
    </div>
    <div id="grid"></div>
  </div>`;
  const grid = main.querySelector('#grid');

  function draw() {
    main.querySelectorAll('[data-f]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.f === filter)));
    const list = videos.filter(v => filter === 'all' || v.kind === filter);
    if (!list.length) {
      grid.innerHTML = `<div class="empty">${icon('film')}<h3>No videos yet</h3><p>Generate your first video and it will show up here.</p>
        <a class="btn primary" href="#/create">${icon('sparkles')} Create a video</a></div>`;
      return;
    }
    grid.innerHTML = `<div class="grid">${list.map(v => `
      <article class="media-card">
        <div class="media-thumb" data-play="${esc(v.video)}" data-id="${esc(v.id)}" data-title="${esc(v.projectName)}" tabindex="0" role="button" aria-label="Play ${esc(v.projectName)}"
          style="aspect-ratio:${v.width && v.height ? `${v.width}/${v.height}` : '16/9'};max-height:320px">
          ${v.thumbnail ? `<img src="${esc(v.thumbnail)}" alt="" loading="lazy">` : `<div class="placeholder">${icon('film')}</div>`}
          <div class="corner"><span class="badge ${v.kind === 'final' ? 'accent' : ''}">${v.kind === 'final' ? 'Final' : `Scene ${v.sceneIndex}`}</span></div>
          ${v.durationSec ? `<span class="duration">${fmtDuration(v.durationSec)}</span>` : ''}
        </div>
        <div class="media-body">
          <div class="media-title">${esc(v.projectName)}</div>
          <div class="media-sub">${esc(v.prompt || '')}</div>
          <div class="small muted">${v.width}×${v.height} · ${timeAgo(v.createdAt)}</div>
          <div class="media-actions">
            <a class="btn sm" href="/api/video/${v.id}/download" download>${icon('download')} Download</a>
            <a class="btn ghost sm" href="#/project/${v.projectId}${v.kind === 'final' ? '?view=final' : ''}">${icon('external')} Open</a>
          </div>
        </div>
      </article>`).join('')}</div>`;
  }

  async function load() {
    try {
      videos = await api.videos();
      draw();
    } catch (err) {
      toastError(err);
    }
  }

  main.addEventListener('click', e => {
    const f = e.target.closest('[data-f]');
    if (f) { filter = f.dataset.f; draw(); return; }
    const p = e.target.closest('[data-play]');
    if (p) videoModal(p.dataset.play, p.dataset.title, p.dataset.id);
  });
  main.addEventListener('keydown', e => {
    const p = e.target.closest('[data-play]');
    if (p && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); videoModal(p.dataset.play, p.dataset.title, p.dataset.id); }
  });
  // Hover preview: play muted in place.
  main.addEventListener('mouseover', e => {
    const p = e.target.closest('[data-play]');
    if (!p || p.querySelector('video')) return;
    const holder = document.createElement('div');
    holder.innerHTML = videoTag(p.dataset.play, p.dataset.id, 'muted loop playsinline autoplay style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"');
    const v = holder.firstElementChild;
    v.muted = true;
    p.appendChild(v);
    p.addEventListener('mouseleave', () => v.remove(), { once: true });
  });

  let timer = null;
  const off = on('project', () => { clearTimeout(timer); timer = setTimeout(load, 800); });
  grid.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  await load();
  return () => { off(); clearTimeout(timer); };
}
