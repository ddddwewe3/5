'use strict';
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ROOT, MODELS_DIR } = require('../config');
const settings = require('../store/settings');
const ffmpeg = require('../media/ffmpeg');
const { AppError } = require('../errors');
const log = require('../logger').createLogger('tts');

/**
 * Local, free text-to-speech. Engines (in "auto" preference order):
 *   piper  – neural open-source TTS (best quality; github.com/rhasspy/piper)
 *   sapi   – Windows built-in voices via System.Speech (always present on Windows)
 *   say    – macOS built-in voices
 *   espeak – espeak-ng, open-source and available on every platform
 */
const EXE = process.platform === 'win32' ? '.exe' : '';

function run(file, args, { input, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${path.basename(file)} exited with code ${code}`), { stderr }));
    });
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

function which(names) {
  return new Promise(resolve => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const tryNext = i => {
      if (i >= names.length) return resolve(null);
      execFile(cmd, [names[i]], { windowsHide: true }, (err, stdout) => {
        if (!err && stdout.trim()) resolve(stdout.trim().split(/\r?\n/)[0]);
        else tryNext(i + 1);
      });
    };
    tryNext(0);
  });
}

function findPiperVoices() {
  const dirs = [path.join(MODELS_DIR, 'piper'), path.join(ROOT, 'tools', 'piper', 'voices')];
  const voices = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.onnx')) voices.push(path.join(dir, f));
  }
  const configured = settings.get().piperVoice;
  if (configured && fs.existsSync(configured) && !voices.includes(configured)) voices.unshift(configured);
  return voices;
}

async function piperBinary() {
  const s = settings.get();
  if (s.piperPath && fs.existsSync(s.piperPath)) return s.piperPath;
  const local = path.join(ROOT, 'tools', 'piper', `piper${EXE}`);
  if (fs.existsSync(local)) return local;
  const venvPiper = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', `piper${EXE}`);
  if (fs.existsSync(venvPiper)) return venvPiper;
  return which(['piper']);
}

let cachedEngines = null;
let cachedAt = 0;

/** Detects installed engines and their voices. */
async function detectEngines(force = false) {
  if (!force && cachedEngines && Date.now() - cachedAt < 60000) return cachedEngines;
  const engines = [];
  const piper = await piperBinary();
  const piperVoices = findPiperVoices();
  if (piper && piperVoices.length) {
    engines.push({ id: 'piper', label: 'Piper (neural)', binary: piper,
      voices: piperVoices.map(v => ({ id: v, label: path.basename(v, '.onnx') })) });
  }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
        '$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + "|" + $_.VoiceInfo.Culture }'], { timeout: 20000 });
      const voices = stdout.split(/\r?\n/).filter(Boolean).map(l => {
        const [name, culture] = l.split('|');
        return { id: name.trim(), label: `${name.trim()} (${(culture || '').trim()})` };
      });
      if (voices.length) engines.push({ id: 'sapi', label: 'Windows voices (SAPI)', voices });
    } catch (err) {
      log.debug('SAPI unavailable:', err.message);
    }
  }
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run('say', ['-v', '?'], { timeout: 10000 });
      const voices = stdout.split('\n').filter(Boolean).map(l => {
        const m = l.match(/^(.+?)\s{2,}(\S+)/);
        return m ? { id: m[1].trim(), label: `${m[1].trim()} (${m[2]})` } : null;
      }).filter(Boolean);
      engines.push({ id: 'say', label: 'macOS voices', voices });
    } catch (err) {
      log.debug('say unavailable:', err.message);
    }
  }
  const espeak = await which(['espeak-ng', 'espeak']);
  if (espeak) {
    const voices = [
      { id: 'en-us', label: 'English (US)' }, { id: 'en', label: 'English (UK)' }, { id: 'en-us+f3', label: 'English (US) female' },
      { id: 'nl', label: 'Dutch' }, { id: 'de', label: 'German' }, { id: 'fr', label: 'French' }, { id: 'es', label: 'Spanish' },
      { id: 'it', label: 'Italian' }, { id: 'pt', label: 'Portuguese' }, { id: 'ar', label: 'Arabic' }, { id: 'tr', label: 'Turkish' },
    ];
    engines.push({ id: 'espeak', label: 'eSpeak NG', binary: espeak, voices });
  }
  cachedEngines = engines;
  cachedAt = Date.now();
  return engines;
}

/** Synthesizes `text` to a WAV file. Returns { path, durationSec, engine, voice }. */
async function synthesize({ text, output, engine, voice, rate }) {
  const clean = String(text || '').trim();
  if (!clean) throw new AppError('INVALID_INPUT', 'Voice-over text is empty');
  if (clean.length > 5000) throw new AppError('INVALID_INPUT', 'Voice-over text is too long (max 5000 characters)');
  const s = settings.get();
  const engines = await detectEngines();
  if (!engines.length) {
    throw new AppError('TTS_ERROR', 'No local text-to-speech engine is installed.', {
      details: 'Install Piper (recommended), espeak-ng, or use Windows/macOS built-in voices.',
    });
  }
  const wanted = engine || s.ttsEngine || 'auto';
  const chosen = wanted === 'auto' ? engines[0] : engines.find(e => e.id === wanted);
  if (!chosen) throw new AppError('TTS_ERROR', `TTS engine "${wanted}" is not installed.`, { details: `Installed: ${engines.map(e => e.id).join(', ')}` });
  const voiceId = voice || (s.ttsEngine === chosen.id || s.ttsEngine === 'auto' ? s.ttsVoice : '') || '';
  const selectedVoice = chosen.voices.find(v => v.id === voiceId) ? voiceId : (chosen.voices[0] && chosen.voices[0].id);
  const speed = Math.min(2, Math.max(0.5, Number(rate || s.ttsRate || 1)));
  const raw = output.replace(/\.wav$/i, '') + '.raw.wav';
  const textFile = output.replace(/\.wav$/i, '') + '.txt';
  fs.writeFileSync(textFile, clean, 'utf8');
  try {
    switch (chosen.id) {
      case 'piper':
        await run(chosen.binary, ['--model', selectedVoice, '--output_file', raw,
          ...(speed !== 1 ? ['--length_scale', (1 / speed).toFixed(3)] : [])], { input: clean });
        break;
      case 'sapi': {
        const ps = [
          'Add-Type -AssemblyName System.Speech',
          '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
          selectedVoice ? `$s.SelectVoice('${selectedVoice.replace(/'/g, "''")}')` : '',
          `$s.Rate = ${Math.round((speed - 1) * 10)}`,
          `$s.SetOutputToWaveFile('${raw.replace(/'/g, "''")}')`,
          `$s.Speak([IO.File]::ReadAllText('${textFile.replace(/'/g, "''")}', [Text.Encoding]::UTF8))`,
          '$s.Dispose()',
        ].filter(Boolean).join('; ');
        await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
        break;
      }
      case 'say':
        await run('say', ['-v', selectedVoice, '-r', String(Math.round(180 * speed)), '-o', raw,
          '--file-format=WAVE', '--data-format=LEI16@22050', '-f', textFile]);
        break;
      case 'espeak':
        await run(chosen.binary, ['-v', selectedVoice, '-s', String(Math.round(165 * speed)), '-w', raw, '-f', textFile]);
        break;
      default:
        throw new Error(`Unknown engine ${chosen.id}`);
    }
    if (!fs.existsSync(raw) || fs.statSync(raw).size < 100) throw new Error('The TTS engine produced no audio');
    // Normalise to 44.1 kHz stereo with loudness normalisation so it mixes cleanly.
    await ffmpeg.run(['-i', raw, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '44100', '-ac', '2', output]);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('TTS_ERROR', `Voice generation failed (${chosen.label}).`, { details: `${err.message}\n${err.stderr || ''}` });
  } finally {
    fs.rmSync(raw, { force: true });
    fs.rmSync(textFile, { force: true });
  }
  const info = await ffmpeg.probe(output);
  log.info(`Synthesized ${info.durationSec.toFixed(1)}s of speech with ${chosen.id}/${selectedVoice}`);
  return { path: output, durationSec: info.durationSec, engine: chosen.id, voice: selectedVoice };
}

module.exports = { detectEngines, synthesize };
