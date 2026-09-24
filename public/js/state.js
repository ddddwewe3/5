import { api } from './api.js';

// Shared, cached system status (engine availability) used by several pages.
export const appState = { status: null, statusAt: 0, statusListeners: new Set() };

export async function refreshStatus(force = false) {
  if (!force && appState.status && Date.now() - appState.statusAt < 15000) return appState.status;
  try {
    appState.status = await api.status();
    appState.statusAt = Date.now();
  } catch (err) {
    appState.status = null;
  }
  renderEnginePill();
  appState.statusListeners.forEach(fn => fn(appState.status));
  return appState.status;
}

export function onStatus(fn) {
  appState.statusListeners.add(fn);
  return () => appState.statusListeners.delete(fn);
}

function renderEnginePill() {
  const pill = document.getElementById('enginePill');
  const s = appState.status;
  let cls = 'err';
  let label = 'Server offline';
  if (s) {
    const active = s.activeProvider && s.providers[s.activeProvider];
    if (s.activeProvider === 'comfyui') {
      cls = 'ok';
      label = `ComfyUI · ${(active.gpu && active.gpu.name) || 'online'}`;
    } else if (s.activeProvider === 'local') {
      const onGpu = active.device === 'cuda' || active.device === 'mps';
      cls = onGpu && !active.warning ? 'ok' : 'warn';
      label = `Local model · ${onGpu ? (active.gpu && active.gpu.name) || active.device.toUpperCase() : 'CPU only'}`;
    } else if (s.activeProvider === 'external') {
      cls = 'warn';
      label = 'External API (paid)';
    } else {
      label = s.providers.comfyui && s.providers.comfyui.status === 'offline' ? 'ComfyUI offline · no engine' : 'No video engine';
    }
  }
  pill.className = `engine-pill ${cls}`;
  pill.querySelector('.label').textContent = label;
  pill.title = label;
}

