#!/usr/bin/env node
'use strict';
// Installs a portable FFmpeg into tools/ffmpeg (used by setup.ps1 / setup.sh). Same code as the in-app button.
const installer = require('../src/media/ffmpegInstaller');
const ffmpeg = require('../src/media/ffmpeg');

(async () => {
  const existing = await ffmpeg.detect(true);
  if (existing.available && !process.argv.includes('--force')) {
    console.log(`FFmpeg already available: ${existing.version} (${existing.path})`);
    return;
  }
  const timer = setInterval(() => {
    const s = installer.status();
    if (s.status === 'downloading' && s.total) process.stdout.write(`\r  Downloading FFmpeg ${Math.round(s.progress * 100)}% (${(s.downloaded / 1e6).toFixed(0)}/${(s.total / 1e6).toFixed(0)} MB)   `);
    if (s.status === 'extracting') process.stdout.write('\r  Unpacking…                                        ');
  }, 500);
  try {
    await installer.install();
    clearInterval(timer);
    const info = await ffmpeg.detect(true);
    console.log(`\n  FFmpeg ${info.version} installed at ${info.path}`);
  } catch (err) {
    clearInterval(timer);
    console.error(`\n  FFmpeg install failed: ${err.message}`);
    process.exit(1);
  }
})();
