'use strict';
const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('./config');

const LOG_FILE = path.join(LOG_DIR, 'app.log');
const MAX_BUFFER = 2000;
const buffer = [];
let stream = null;

function openStream() {
  try {
    // Rotate when the log grows past 10 MB so it never fills the disk.
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 10 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    stream.on('error', () => { stream = null; });
  } catch {
    stream = null;
  }
}
openStream();

function fmt(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function write(level, scope, args) {
  const line = {
    time: new Date().toISOString(),
    level,
    scope,
    message: args.map(fmt).join(' '),
  };
  buffer.push(line);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  const text = `${line.time} [${level.toUpperCase()}] [${scope}] ${line.message}`;
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else if (level !== 'debug' || process.env.DEBUG) console.log(text);
  if (stream) stream.write(text + '\n');
}

function createLogger(scope) {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}

function recent({ limit = 300, level } = {}) {
  const levels = { debug: 0, info: 1, warn: 2, error: 3 };
  const min = levels[level] ?? 0;
  return buffer.filter(l => levels[l.level] >= min).slice(-limit);
}

module.exports = { createLogger, recent, LOG_FILE };
