import { api, on } from '../api.js';
import { icon, esc, timeAgo, confirmDialog, toast, toastError } from '../ui.js';

const STATUS_BADGE = {
  running: '<span class="badge info">Generating</span>',
  failed: '<span class="badge err">Failed</span>',
  cancelled: '<span class="badge warn">Cancelled</span>',
  ready: '<span class="badge ok">Ready</span>',
};

export async function render(main) {
  let list = [];
  let query = '';
  main.innerHTML = `
  <div class="page">
    <div class="page-head">
      <div><h1>Projects</h1><p>Each generation is saved as a project with its prompt, images, scenes, versions and exports.</p></div>
      <div class="row">
        <input class="input" id="search" type="search" placeholder="Search projects…" style="width:220px" aria-label="Search projects">
        <a class="btn primary" href="#/create">${icon('plus')} New project</a>
      </div>
    </div>
    <div id="list"></div>
  </div>`;
  const box = main.querySelector('#list');

  function draw() {
    const q = query.toLowerCase();
    const items = list.filter(p => !q || p.name.toLowerCase().includes(q) || (p.prompt || '').toLowerCase().includes(q));
    if (!items.length) {
      box.innerHTML = list.length
        ? `<div class="empty">${icon('folder')}<h3>No matching projects</h3></div>`
        : `<div class="empty">${icon('folder')}<h3>No projects yet</h3><p>Start by describing a video.</p><a class="btn primary" href="#/create">${icon('sparkles')} Create a video</a></div>`;
      return;
    }
    box.innerHTML = `<div class="grid">${items.map(p => `
      <article class="media-card">
        <a class="media-thumb" href="#/project/${p.id}" aria-label="Open ${esc(p.name)}">
          ${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="" loading="lazy">` : `<div class="placeholder">${p.status === 'running' ? '<span class="spinner"></span>' : icon('film')}</div>`}
          <div class="corner">${STATUS_BADGE[p.status] || ''}${p.finalVideo ? '<span class="badge accent">Exported</span>' : ''}</div>
        </a>
        <div class="media-body">
          <div class="media-title">${esc(p.name)}</div>
          <div class="media-sub">${esc(p.prompt || '')}</div>
          <div class="small muted">${esc(p.aspectRatio)} · ${p.sceneCount} scene${p.sceneCount === 1 ? '' : 's'} · ${timeAgo(p.updatedAt)}</div>
          <div class="media-actions">
            <a class="btn sm" href="#/project/${p.id}">${icon('external')} Open</a>
            ${p.finalVideo ? `<a class="btn ghost sm" href="${esc(p.finalVideo)}" download>${icon('download')}</a>` : ''}
            <span class="grow"></span>
            <button class="btn ghost sm icon-only" data-del="${p.id}" data-name="${esc(p.name)}" aria-label="Delete project">${icon('trash')}</button>
          </div>
        </div>
      </article>`).join('')}</div>`;
  }

  async function load() {
    try {
      list = await api.projects();
      draw();
    } catch (err) {
      toastError(err);
    }
  }

  main.querySelector('#search').addEventListener('input', e => { query = e.target.value; draw(); });
  main.addEventListener('click', async e => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    const ok = await confirmDialog({ title: `Delete "${del.dataset.name}"?`, message: 'The project and all of its videos will be permanently deleted from disk.', confirm: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.del(`/api/projects/${del.dataset.del}`);
      toast('Project deleted', { type: 'ok' });
      await load();
    } catch (err) {
      toastError(err);
    }
  });

  let timer = null;
  const off = on('project', () => { clearTimeout(timer); timer = setTimeout(load, 500); });
  box.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  await load();
  return () => { off(); clearTimeout(timer); };
}
