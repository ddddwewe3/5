'use strict';
const fs = require('fs');
const path = require('path');
const { PROJECTS_DIR } = require('../config');
const { newId, isId, writeJsonAtomic, readJson } = require('../util');
const { AppError, toClient } = require('../errors');
const events = require('../events');
const log = require('../logger').createLogger('projects');

/**
 * Project persistence. Each project lives in data/projects/<id>/ with a project.json plus its
 * uploads, scene takes and renders as real files. Data model:
 *
 * project { id, name, createdAt, updatedAt, prompt, mode, aspectRatio, duration, quality,
 *           styleBible, uploads[], scenes[], renders[], finalRenderId, metadata }
 * scene   { id, index, prompt, enhanced, mode, sourceImage, duration, activeTakeId, takes[], trim, speed }
 * take    { id, jobId, seed, status, stage, progress, message, video, thumbnail, lastFrame,
 *           width, height, fps, frames, durationSec, provider, model, timings, error, createdAt }
 * render  { id, jobId, status, stage, progress, spec, video, thumbnail, durationSec, error, createdAt }
 */
const cache = new Map();
const saveTimers = new Map();

function dirOf(id) {
  if (!isId(id)) throw new AppError('NOT_FOUND', 'Invalid project id');
  return path.join(PROJECTS_DIR, id);
}

function fileOf(id) {
  return path.join(dirOf(id), 'project.json');
}

function mediaUrl(projectId, relPath) {
  return `/media/${projectId}/${relPath.split(path.sep).join('/')}`;
}

function mediaPath(projectId, url) {
  // Inverse of mediaUrl: resolve a /media URL back to a file inside the project directory.
  const prefix = `/media/${projectId}/`;
  if (!url || !url.startsWith(prefix)) return null;
  const rel = decodeURIComponent(url.slice(prefix.length));
  const full = path.resolve(dirOf(projectId), rel);
  if (!full.startsWith(dirOf(projectId) + path.sep)) return null;
  return full;
}

function loadAll() {
  for (const entry of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isId(entry.name)) continue;
    const project = readJson(path.join(PROJECTS_DIR, entry.name, 'project.json'), null);
    if (!project) continue;
    // Anything that was running when the server stopped can never finish now.
    let dirty = false;
    const interrupted = toClient(new AppError('INTERRUPTED'));
    for (const scene of project.scenes || []) {
      for (const take of scene.takes || []) {
        if (['queued', 'running'].includes(take.status)) {
          Object.assign(take, { status: 'failed', stage: 'failed', error: interrupted });
          dirty = true;
        }
      }
    }
    for (const render of project.renders || []) {
      if (['queued', 'running'].includes(render.status)) {
        Object.assign(render, { status: 'failed', stage: 'failed', error: interrupted });
        dirty = true;
      }
    }
    cache.set(project.id, project);
    if (dirty) persist(project.id);
  }
  log.info(`Loaded ${cache.size} project(s)`);
}

function persist(id) {
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  const project = cache.get(id);
  if (!project) return;
  try {
    writeJsonAtomic(fileOf(id), project);
  } catch (err) {
    log.error(`Failed to save project ${id}:`, err);
  }
}

function scheduleSave(id, immediate) {
  if (immediate) return persist(id);
  if (saveTimers.has(id)) return;
  saveTimers.set(id, setTimeout(() => persist(id), 750));
}

function flushAll() {
  for (const id of [...saveTimers.keys()]) persist(id);
}

function summary(p) {
  const scenes = p.scenes || [];
  const firstTake = scenes.map(s => activeTake(s)).find(t => t && t.thumbnail);
  const finalRender = (p.renders || []).find(r => r.id === p.finalRenderId && r.status === 'complete');
  const running = scenes.some(s => (s.takes || []).some(t => ['queued', 'running'].includes(t.status))) ||
    (p.renders || []).some(r => ['queued', 'running'].includes(r.status));
  const allTakes = scenes.flatMap(s => s.takes || []);
  const failed = !running && allTakes.length > 0 && allTakes.every(t => t.status === 'failed' || t.status === 'cancelled');
  const cancelled = failed && allTakes.every(t => t.status === 'cancelled');
  return {
    id: p.id,
    name: p.name,
    prompt: p.prompt,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    aspectRatio: p.aspectRatio,
    mode: p.mode,
    sceneCount: scenes.length,
    thumbnail: (finalRender && finalRender.thumbnail) || (firstTake && firstTake.thumbnail) || null,
    finalVideo: finalRender ? finalRender.video : null,
    status: running ? 'running' : cancelled ? 'cancelled' : failed ? 'failed' : 'ready',
  };
}

function list() {
  return [...cache.values()]
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .map(summary);
}

function get(id) {
  const p = cache.get(id);
  if (!p) throw new AppError('NOT_FOUND', 'Project not found');
  return p;
}

function create(fields) {
  const id = newId('prj');
  const now = new Date().toISOString();
  const dir = dirOf(id);
  for (const sub of ['uploads', 'scenes', 'renders']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const project = {
    id,
    name: fields.name || 'Untitled project',
    createdAt: now,
    updatedAt: now,
    prompt: fields.prompt || '',
    mode: fields.mode || 't2v',
    aspectRatio: fields.aspectRatio || '16:9',
    duration: fields.duration || 5,
    quality: fields.quality || 'balanced',
    styleBible: fields.styleBible || null,
    uploads: [],
    scenes: [],
    renders: [],
    finalRenderId: null,
    metadata: {},
  };
  cache.set(id, project);
  persist(id);
  events.broadcast('project', { id, summary: summary(project) });
  return project;
}

/** Mutate a project and schedule a save + live update. `mutator` may return a value. */
function update(id, mutator, { immediate = false, silent = false } = {}) {
  const project = get(id);
  const result = mutator(project);
  project.updatedAt = new Date().toISOString();
  scheduleSave(id, immediate);
  if (!silent) events.broadcast('project', { id, summary: summary(project) });
  return result;
}

function remove(id) {
  get(id);
  cache.delete(id);
  clearTimeout(saveTimers.get(id));
  saveTimers.delete(id);
  fs.rmSync(dirOf(id), { recursive: true, force: true });
  events.broadcast('project', { id, deleted: true });
}

function activeTake(scene) {
  if (!scene || !scene.takes || !scene.takes.length) return null;
  return scene.takes.find(t => t.id === scene.activeTakeId) || scene.takes[scene.takes.length - 1];
}

function findScene(project, sceneId) {
  const scene = project.scenes.find(s => s.id === sceneId);
  if (!scene) throw new AppError('NOT_FOUND', 'Scene not found');
  return scene;
}

/** Locate a take or render anywhere by id → { project, scene?, take?, render? } */
function findMedia(id) {
  for (const project of cache.values()) {
    for (const scene of project.scenes) {
      const take = scene.takes.find(t => t.id === id);
      if (take) return { project, scene, take };
    }
    const render = (project.renders || []).find(r => r.id === id);
    if (render) return { project, render };
  }
  return null;
}

function allVideos() {
  const out = [];
  for (const project of cache.values()) {
    for (const scene of project.scenes) {
      for (const take of scene.takes) {
        if (take.status === 'complete' && take.video) {
          out.push({
            id: take.id, kind: 'scene', projectId: project.id, projectName: project.name,
            sceneIndex: scene.index, prompt: scene.prompt, video: take.video, thumbnail: take.thumbnail,
            durationSec: take.durationSec, width: take.width, height: take.height, createdAt: take.completedAt || take.createdAt,
          });
        }
      }
    }
    for (const render of project.renders || []) {
      if (render.status === 'complete' && render.video) {
        out.push({
          id: render.id, kind: 'final', projectId: project.id, projectName: project.name,
          prompt: project.prompt, video: render.video, thumbnail: render.thumbnail,
          durationSec: render.durationSec, width: render.width, height: render.height, createdAt: render.completedAt || render.createdAt,
        });
      }
    }
  }
  return out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

module.exports = {
  loadAll, list, get, create, update, remove, persist, flushAll,
  dirOf, mediaUrl, mediaPath, activeTake, findScene, findMedia, allVideos, summary,
};
