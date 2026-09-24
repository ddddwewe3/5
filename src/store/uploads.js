'use strict';
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../config');
const { newId, isId, readJson, writeJsonAtomic, safeFileName } = require('../util');
const ffmpeg = require('../media/ffmpeg');
const { AppError } = require('../errors');

const DIR = path.join(DATA_DIR, 'uploads');
const INDEX = path.join(DIR, 'index.json');
fs.mkdirSync(DIR, { recursive: true });

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff'];
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus'];

let index = readJson(INDEX, {});

function save() {
  writeJsonAtomic(INDEX, index);
}

function kindOf(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return null;
}

/**
 * Stores an uploaded temp file. Images are converted to PNG (handles any format FFmpeg reads and
 * strips odd colour profiles); audio is validated with ffprobe.
 */
async function add(tempPath, originalName) {
  const kind = kindOf(originalName);
  if (!kind) {
    fs.rmSync(tempPath, { force: true });
    throw new AppError('INVALID_INPUT', `Unsupported file type. Images: ${IMAGE_EXT.join(' ')} · Audio: ${AUDIO_EXT.join(' ')}`);
  }
  const id = newId('upl');
  let file;
  let meta = {};
  try {
    if (kind === 'image') {
      file = `${id}.png`;
      await ffmpeg.run(['-i', tempPath, '-frames:v', '1', '-vf', "scale='min(2048,iw)':-2", path.join(DIR, file)]);
      const info = await ffmpeg.probe(path.join(DIR, file));
      meta = { width: info.width, height: info.height };
    } else {
      file = `${id}${path.extname(originalName).toLowerCase()}`;
      fs.copyFileSync(tempPath, path.join(DIR, file));
      const info = await ffmpeg.probe(path.join(DIR, file));
      if (!info.hasAudio) throw new AppError('INVALID_INPUT', 'The uploaded file contains no audio track');
      meta = { durationSec: info.durationSec };
    }
  } catch (err) {
    if (file) fs.rmSync(path.join(DIR, file), { force: true });
    if (err instanceof AppError && err.code === 'FFMPEG_ERROR') {
      throw new AppError('INVALID_INPUT', `Could not read "${originalName}" — the file may be damaged or in an unsupported format.`, { details: err.details });
    }
    throw err;
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  const entry = {
    id, kind, file, originalName: safeFileName(originalName), url: `/uploads/${file}`,
    size: fs.statSync(path.join(DIR, file)).size, createdAt: new Date().toISOString(), ...meta,
  };
  index[id] = entry;
  save();
  return entry;
}

function get(id) {
  if (!isId(id) || !index[id]) return null;
  return index[id];
}

function filePath(id) {
  const entry = get(id);
  return entry ? path.join(DIR, entry.file) : null;
}

module.exports = { add, get, filePath, DIR, kindOf };
