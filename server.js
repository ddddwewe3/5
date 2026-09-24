'use strict';
require('dotenv').config();

const path = require('path');
const express = require('express');
const config = require('./src/config');
const logger = require('./src/logger');
const projects = require('./src/store/projects');
const settings = require('./src/store/settings');
const providers = require('./src/providers');
const ffmpeg = require('./src/media/ffmpeg');
const uploads = require('./src/store/uploads');
const { router } = require('./src/routes/api');
const { isId } = require('./src/util');

const log = logger.createLogger('server');

projects.loadAll();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use('/api', router);

// Project media (videos, thumbnails, uploads). express.static supports HTTP Range requests, which
// browsers need for seeking in <video>.
app.use('/media/:projectId', (req, res, next) => {
  if (!isId(req.params.projectId)) return res.status(404).end();
  express.static(projects.dirOf(req.params.projectId), { fallthrough: false, maxAge: '1h', index: false, dotfiles: 'deny' })(req, res, err => {
    if (err) return res.status(err.status || 404).end();
    next();
  });
});
app.use('/uploads', express.static(uploads.DIR, { maxAge: '1h', index: false, dotfiles: 'deny' }));
app.use('/tmp-media', express.static(config.TMP_DIR, { maxAge: 0, index: false, dotfiles: 'deny' }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));
// Single-page app: unknown non-API paths serve the UI.
app.get(/^\/(?!api|media|uploads|tmp-media).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(config.PORT, config.HOST, async () => {
  const url = `http://${config.HOST === '0.0.0.0' ? 'localhost' : config.HOST}:${config.PORT}`;
  log.info(`OpenReel Studio running at ${url}`);
  const ff = await ffmpeg.detect();
  if (!ff.available) log.warn('FFmpeg was NOT found — install it (setup.bat does this) or set FFMPEG_PATH. Videos cannot be encoded without it.');
  const health = await providers.healthAll();
  const comfy = health.comfyui;
  if (comfy.status === 'offline') log.warn(`${comfy.message} (${settings.get().comfyuiUrl})`);
  else log.info(`ComfyUI: ${comfy.message}`);
  log.info(`Local model worker: ${health.local.message}${health.local.warning ? ` — ${health.local.warning}` : ''}`);
  // Speed: if the local worker will be used, load the model now so the first generation starts immediately.
  const s = settings.get();
  const localWillRun = s.provider === 'local' || (s.provider === 'auto' && !comfy.available && health.local.available);
  if (localWillRun && process.env.PRELOAD_MODEL !== '0') {
    log.info('Preloading local model in the background for a fast first generation…');
    providers.get('local').preload();
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') log.error(`Port ${config.PORT} is already in use. Close the other program or set PORT in .env.`);
  else log.error('Server error:', err);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}, shutting down…`);
  projects.flushAll();
  await Promise.all(Object.values(providers.providers).map(p => p.shutdown().catch(() => {})));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', err => log.error('Unhandled rejection:', err));
process.on('uncaughtException', err => log.error('Uncaught exception:', err));
