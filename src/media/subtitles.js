'use strict';

/**
 * Splits narration text into subtitle cues and times them across [start, end], proportionally to
 * text length (speech duration scales roughly with characters), with sensible min/max lengths.
 */
function buildCues(text, start, end, { maxChars = 42 } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?。！？]+[.!?。！？]*\s*/g) || [clean];
  const chunks = [];
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (sentence.length <= maxChars) {
      chunks.push(sentence);
      continue;
    }
    // Break long sentences at word boundaries into ~maxChars pieces (prefer commas).
    let current = '';
    for (const word of sentence.split(' ')) {
      if ((current + ' ' + word).trim().length > maxChars && current) {
        chunks.push(current.trim());
        current = word;
      } else {
        current = `${current} ${word}`;
        if (/[,;:]$/.test(word) && current.length > maxChars * 0.6) {
          chunks.push(current.trim());
          current = '';
        }
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }
  const total = Math.max(0.5, end - start);
  const weights = chunks.map(c => Math.max(8, c.length));
  const sum = weights.reduce((a, b) => a + b, 0);
  let t = start;
  return chunks.map((chunk, i) => {
    const dur = (weights[i] / sum) * total;
    const cue = { start: t, end: t + dur, text: chunk };
    t += dur;
    return cue;
  });
}

function assTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const cs = Math.round((s - Math.floor(s)) * 100);
  const whole = Math.floor(s % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(Math.min(99, cs)).padStart(2, '0')}`;
}

function srtTime(sec) {
  const ms = Math.round(Math.max(0, sec) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

function escapeAss(text) {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')').replace(/\n/g, '\\N');
}

/** ASS subtitle file sized to the video; style: bold white text, dark outline, lower third. */
function toAss(cues, { width, height, position = 'bottom', fontScale = 1 }) {
  const fontSize = Math.round(Math.min(width, height) * 0.058 * fontScale);
  const margin = Math.round(height * (position === 'middle' ? 0.45 : position === 'top' ? 0.06 : 0.08));
  const align = position === 'top' ? 8 : position === 'middle' ? 5 : 2;
  const outline = Math.max(2, Math.round(fontSize * 0.08));
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Arial,${fontSize},&H00FFFFFF,&H00FFFFFF,&H00101010,&H64000000,-1,0,0,0,100,100,0,0,1,${outline},1,${align},${Math.round(width * 0.06)},${Math.round(width * 0.06)},${margin},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines = cues.map(c => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${escapeAss(c.text)}`);
  return `${header.join('\n')}\n${lines.join('\n')}\n`;
}

function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

module.exports = { buildCues, toAss, toSrt };
