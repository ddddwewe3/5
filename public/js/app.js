import { connectEvents } from './api.js';
import { refreshStatus } from './state.js';
import { hydrateIcons } from './ui.js';
import * as createPage from './pages/create.js';
import * as projectPage from './pages/project.js';
import * as videosPage from './pages/videos.js';
import * as projectsPage from './pages/projects.js';
import * as templatesPage from './pages/templates.js';
import * as settingsPage from './pages/settings.js';

const routes = {
  create: createPage,
  project: projectPage,
  videos: videosPage,
  projects: projectsPage,
  templates: templatesPage,
  settings: settingsPage,
};

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [pathPart, query = ''] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const route = routes[parts[0]] ? parts[0] : 'create';
  return { route, id: parts[1] || null, query: new URLSearchParams(query) };
}

let cleanup = null;
let navToken = 0;

async function navigate() {
  const { route, id, query } = parseHash();
  const token = ++navToken;
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  const main = document.getElementById('main');
  main.innerHTML = '';
  document.querySelectorAll('#nav a').forEach(a => {
    const r = a.dataset.route;
    a.classList.toggle('active', r === route || (route === 'project' && r === 'projects'));
    if (r === route) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const result = await routes[route].render(main, { id, query });
  if (token !== navToken) {
    if (typeof result === 'function') result();
    return;
  }
  cleanup = result;
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

hydrateIcons();
connectEvents();
window.addEventListener('hashchange', navigate);
refreshStatus(true);
setInterval(() => refreshStatus(true), 30000);
navigate();
