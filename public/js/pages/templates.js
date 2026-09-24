import { api } from '../api.js';
import { icon, esc, toastError } from '../ui.js';

export async function render(main) {
  let templates = [];
  let category = 'All';
  main.innerHTML = `
  <div class="page">
    <div class="page-head">
      <div><h1>Templates</h1><p>Proven starting points for ads and social videos. Pick one, tweak the prompt, generate.</p></div>
      <div class="filters" id="cats"></div>
    </div>
    <div id="grid"></div>
  </div>`;

  function draw() {
    const cats = ['All', ...new Set(templates.map(t => t.category))];
    main.querySelector('#cats').innerHTML = cats.map(c => `<button class="chip" data-cat="${esc(c)}" aria-pressed="${c === category}">${esc(c)}</button>`).join('');
    const list = templates.filter(t => category === 'All' || t.category === category);
    main.querySelector('#grid').innerHTML = `<div class="grid">${list.map(t => `
      <article class="tpl-card">
        <div class="spread"><div class="tpl-icon">${icon(t.icon)}</div><span class="badge">${esc(t.category)}</span></div>
        <h3>${esc(t.title)}</h3>
        <p>${esc(t.description)}</p>
        <p class="small" style="color:var(--text-2)">“${esc(t.prompt)}”</p>
        <div class="tpl-meta">
          <span class="badge">${t.mode === 'i2v' ? 'Image → Video' : 'Text → Video'}</span>
          <span class="badge">${esc(t.aspectRatio)}</span><span class="badge">${t.duration}s</span>
          ${t.voiceover ? `<span class="badge accent">${icon('mic')} Voice-over</span>` : ''}
        </div>
        <button class="btn primary" data-use="${esc(t.id)}">${icon('sparkles')} Use template</button>
      </article>`).join('')}</div>`;
  }

  main.addEventListener('click', e => {
    const c = e.target.closest('[data-cat]');
    if (c) { category = c.dataset.cat; draw(); return; }
    const u = e.target.closest('[data-use]');
    if (u) {
      const t = templates.find(x => x.id === u.dataset.use);
      sessionStorage.setItem('openreel.template', JSON.stringify(t));
      location.hash = '#/create';
    }
  });

  try {
    templates = await api.templates();
    draw();
  } catch (err) {
    toastError(err);
  }
}
