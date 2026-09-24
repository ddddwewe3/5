'use strict';
const { EventEmitter } = require('events');
const { newId, sleep } = require('../util');
const { AppError, classify, toClient } = require('../errors');
const log = require('../logger').createLogger('queue');

/**
 * In-process background job queue. Heavy work never runs on the web server's event loop — it runs
 * in ComfyUI, the Python worker or FFmpeg child processes — but this queue serializes access to
 * the GPU (lane "gpu", concurrency 1) and bounds concurrent FFmpeg renders (lane "cpu").
 *
 * A job's `run(ctx)` receives { job, signal, update(patch), log(msg) } and must honour `signal`.
 */
const STAGES = ['queued', 'loading_model', 'generating', 'processing', 'encoding', 'complete'];
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

class JobQueue extends EventEmitter {
  constructor(lanes = { gpu: 1, cpu: 2 }) {
    super();
    this.lanes = {};
    for (const [name, concurrency] of Object.entries(lanes)) {
      this.lanes[name] = { concurrency, running: new Set(), waiting: [] };
    }
    this.jobs = new Map();
    this.lastEmit = new Map();
    setInterval(() => this.prune(), 10 * 60 * 1000).unref();
  }

  enqueue({ type, lane = 'gpu', meta = {}, run, retry = {} }) {
    if (!this.lanes[lane]) throw new Error(`Unknown lane ${lane}`);
    const job = {
      id: newId('job'),
      type,
      lane,
      meta,
      status: 'queued',
      stage: 'queued',
      progress: 0,
      message: 'Waiting in queue',
      step: null,
      totalSteps: null,
      etaSec: null,
      attempts: 0,
      maxAttempts: 1 + (retry.max || 0),
      error: null,
      result: null,
      logs: [],
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    Object.defineProperty(job, '_run', { value: run, enumerable: false });
    Object.defineProperty(job, '_retry', { value: retry, enumerable: false });
    Object.defineProperty(job, '_controller', { value: new AbortController(), enumerable: false });
    this.jobs.set(job.id, job);
    this.lanes[lane].waiting.push(job);
    this.addLog(job, `Queued (${type})`);
    this.emitUpdate(job, true);
    this.refreshPositions(lane);
    setImmediate(() => this.pump(lane));
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  snapshot(job) {
    if (!job) return null;
    const now = job.finishedAt || Date.now();
    return {
      id: job.id,
      type: job.type,
      lane: job.lane,
      meta: job.meta,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      message: job.message,
      step: job.step,
      totalSteps: job.totalSteps,
      etaSec: job.etaSec,
      genElapsedSec: job.genElapsedSec ?? null,
      loadSec: job.loadSec ?? null,
      queuePosition: job.queuePosition ?? null,
      attempts: job.attempts,
      elapsedSec: job.startedAt ? Math.round((now - job.startedAt) / 100) / 10 : 0,
      error: job.error,
      result: job.result,
      logs: job.logs.slice(-40),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  list() {
    return [...this.jobs.values()].map(j => this.snapshot(j));
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) throw new AppError('NOT_FOUND', 'Job not found');
    if (TERMINAL.has(job.status)) return this.snapshot(job);
    const lane = this.lanes[job.lane];
    const idx = lane.waiting.indexOf(job);
    if (idx >= 0) {
      lane.waiting.splice(idx, 1);
      this.finish(job, 'cancelled', { error: toClient(new AppError('CANCELLED')) });
      this.refreshPositions(job.lane);
    } else {
      job.message = 'Cancelling…';
      this.addLog(job, 'Cancel requested');
      this.emitUpdate(job, true);
      job._controller.abort();
    }
    return this.snapshot(job);
  }

  addLog(job, message) {
    job.logs.push({ t: Date.now(), message });
    if (job.logs.length > 200) job.logs.shift();
  }

  refreshPositions(laneName) {
    const lane = this.lanes[laneName];
    const busy = lane.running.size >= lane.concurrency;
    lane.waiting.forEach((job, i) => {
      const message = busy ? `Waiting in queue (position ${i + 1})` : 'Starting…';
      if (job.queuePosition !== i + 1 || job.message !== message) {
        job.queuePosition = i + 1;
        job.message = message;
        this.emitUpdate(job, true);
      }
    });
  }

  pump(laneName) {
    const lane = this.lanes[laneName];
    while (lane.running.size < lane.concurrency && lane.waiting.length) {
      const job = lane.waiting.shift();
      lane.running.add(job);
      job.queuePosition = null;
      this.execute(job).finally(() => {
        lane.running.delete(job);
        this.refreshPositions(laneName);
        this.pump(laneName);
      });
    }
    this.refreshPositions(laneName);
  }

  async execute(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    const signal = job._controller.signal;
    const ctx = {
      job,
      signal,
      update: patch => this.applyUpdate(job, patch),
      log: message => { this.addLog(job, message); log.info(`[${job.id}] ${message}`); this.emitUpdate(job); },
    };
    for (;;) {
      job.attempts += 1;
      try {
        if (signal.aborted) throw new AppError('CANCELLED');
        const result = await job._run(ctx);
        this.finish(job, 'completed', { result });
        return;
      } catch (rawErr) {
        const err = signal.aborted ? new AppError('CANCELLED') : classify(rawErr);
        if (err.code === 'CANCELLED') {
          this.finish(job, 'cancelled', { error: toClient(err) });
          return;
        }
        log.error(`[${job.id}] attempt ${job.attempts} failed: [${err.code}] ${err.message}${err.details ? `\n${err.details}` : ''}`);
        const retry = job._retry;
        const canRetry = err.retryable && job.attempts < job.maxAttempts &&
          (!retry.shouldRetry || retry.shouldRetry(err, job.attempts, job));
        if (!canRetry) {
          this.finish(job, 'failed', { error: toClient(err) });
          return;
        }
        const delay = Math.min(15000, 2000 * 2 ** (job.attempts - 1));
        const note = retry.onRetry ? retry.onRetry(err, job.attempts, job) : null;
        this.addLog(job, `Attempt ${job.attempts} failed (${err.code}: ${err.message}). Retrying in ${delay / 1000}s${note ? ` — ${note}` : ''}`);
        this.applyUpdate(job, { stage: 'queued', progress: 0, step: null, totalSteps: null, etaSec: null,
          message: `Retrying automatically (attempt ${job.attempts + 1} of ${job.maxAttempts})…` });
        try {
          await sleep(delay, signal);
        } catch {
          this.finish(job, 'cancelled', { error: toClient(new AppError('CANCELLED')) });
          return;
        }
      }
    }
  }

  applyUpdate(job, patch) {
    if (TERMINAL.has(job.status)) return;
    const stageChanged = patch.stage && patch.stage !== job.stage;
    for (const key of ['stage', 'progress', 'message', 'step', 'totalSteps', 'etaSec', 'genElapsedSec', 'loadSec']) {
      if (patch[key] !== undefined) job[key] = patch[key];
    }
    if (patch.log) this.addLog(job, patch.log);
    if (stageChanged) this.addLog(job, `Stage: ${job.stage.replace('_', ' ').toUpperCase()}${job.message ? ` — ${job.message}` : ''}`);
    this.emitUpdate(job, stageChanged);
  }

  finish(job, status, { result = null, error = null } = {}) {
    job.status = status;
    job.finishedAt = Date.now();
    job.progress = status === 'completed' ? 1 : job.progress;
    job.stage = status === 'completed' ? 'complete' : status;
    job.etaSec = null;
    job.result = result;
    job.error = error;
    job.message = status === 'completed' ? 'Complete' : status === 'cancelled' ? 'Cancelled' : (error && error.title) || 'Failed';
    this.addLog(job, status === 'failed' ? `Failed: [${error.code}] ${error.message}` : `Job ${status}`);
    if (!job.startedAt) job.startedAt = job.finishedAt;
    this.emitUpdate(job, true);
  }

  /** Emits 'update'. Progress-only updates are throttled to ~5/s per job. */
  emitUpdate(job, force = false) {
    const now = Date.now();
    const last = this.lastEmit.get(job.id) || 0;
    if (!force && now - last < 200) {
      if (!job._pendingEmit) {
        Object.defineProperty(job, '_pendingEmit', { value: true, writable: true, configurable: true });
        setTimeout(() => { job._pendingEmit = false; this.emitUpdate(job, true); }, 200 - (now - last));
      }
      return;
    }
    this.lastEmit.set(job.id, now);
    this.emit('update', this.snapshot(job));
  }

  prune() {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      if (TERMINAL.has(job.status) && job.finishedAt < cutoff) {
        this.jobs.delete(id);
        this.lastEmit.delete(id);
      }
    }
  }
}

module.exports = { JobQueue, STAGES };
