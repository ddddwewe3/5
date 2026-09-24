'use strict';
const settings = require('../store/settings');
const log = require('../logger').createLogger('prompt');

/**
 * Prompt engine. Turns a short idea ("A man talking in a room") into a structured cinematic
 * prompt (subject, environment, action, camera movement, camera angle, lighting, style, motion,
 * duration, aspect ratio) and a flowing paragraph that open video models respond well to.
 * Rule-based and fully offline; a local Ollama model is used instead when configured.
 */

const CATEGORY_PATTERNS = [
  ['product', /\b(product|bottle|perfume|fragrance|watch|phone|smartphone|shoes?|sneakers?|bag|handbag|cosmetics?|lipstick|cream|serum|packaging|package|box|can|jar|headphones?|earbuds|laptop|gadget|device|jewel(?:ry|lery)|ring|necklace|sunglasses|mug|drink|soda|skincare|candle|toy|brand|logo|app|bottle)\b/i],
  ['food', /\b(food|burger|pizza|pasta|sushi|cake|dessert|salad|steak|dish|meal|fries|sandwich|noodles|chocolate|ice cream|cocktail|coffee|tea|breakfast|smoothie|juice)\b/i],
  ['person', /\b(man|woman|men|women|person|people|guy|girl|boy|lady|presenter|influencer|model|chef|doctor|businessman|businesswoman|athlete|dancer|kid|child|children|couple|speaker|host|actor|actress|someone|customer|student|teacher|worker|he|she|they|family|friends)\b/i],
  ['animal', /\b(dog|cat|bird|horse|lion|tiger|fox|wolf|bear|fish|whale|dolphin|eagle|butterfly|puppy|kitten|animal|deer|owl|rabbit|elephant)\b/i],
  ['vehicle', /\b(car|truck|motorcycle|motorbike|bicycle|train|plane|airplane|boat|ship|rocket|bus|jeep|supercar|yacht)\b/i],
  ['nature', /\b(forest|mountains?|ocean|sea|beach|river|lake|waterfall|desert|sky|sunset|sunrise|field|meadow|jungle|snow|landscape|island|clouds?|nature|valley|canyon|garden|flowers?)\b/i],
  ['city', /\b(city|street|downtown|skyline|buildings?|skyscrapers?|traffic|alley|market|urban|metro|subway|town)\b/i],
  ['abstract', /\b(abstract|particles|liquid|smoke|ink|fluid|geometric|shapes|hologram|glitch|fractal|energy)\b/i],
];

const TALKING = /\b(talk(?:s|ing)?|speak(?:s|ing)?|say(?:s|ing)?|explain(?:s|ing)?|present(?:s|ing)?|interview(?:ed|ing)?|vlog(?:ging)?|podcast|review(?:s|ing)?|introduc(?:es|ing)|telling|addresses)\b/i;
const CAMERA_TERMS = /\b(close-?up|wide shot|medium shot|drone|aerial|pan(?:s|ning)?|dolly|zoom(?:s|ing)?|tracking|orbit(?:s|ing)?|handheld|pov|static shot|crane|tilt(?:s|ing)?|push-?in|pull-?back|overhead|top-?down|low angle|high angle|macro)\b/i;
// Lighting keywords the user may mention → a full lighting description.
const LIGHT_MAP = [
  [/\b(sunset|sunrise|golden hour|dusk)\b/i, 'warm golden-hour sunlight with long soft shadows and a glowing sky'],
  [/\bneon\b/i, 'vibrant neon lighting with colorful reflections'],
  [/\b(moonlight|moonlit)\b/i, 'cool blue moonlight with soft highlights'],
  [/\b(candle ?light|candlelit|fireplace)\b/i, 'warm flickering candlelight'],
  [/\b(night|midnight)\b/i, 'night-time lighting with pools of warm street light and deep shadows'],
  [/\b(moody|dark|low-key|noir)\b/i, 'moody low-key lighting with deep shadows and a single strong key light'],
  [/\b(backlit|backlight)\b/i, 'strong backlight creating a glowing rim around the subject'],
  [/\b(bright|sunny|daylight)\b/i, 'bright, even natural daylight'],
  [/\bstudio light(?:ing)?\b/i, 'clean studio lighting with large softboxes'],
];
const STYLE_TERMS = /\b(anime|cartoon|3d render|3d animation|pixar|claymation|watercolor|oil painting|noir|black and white|vintage|retro|cyberpunk|steampunk|documentary|ugc|film grain|vhs|8mm|16mm|35mm|surreal|fantasy|sci-fi|minimalist|stop motion|pixel art|illustration|comic)\b/i;
const INDOOR = /\b(room|office|kitchen|studio|bedroom|living room|home|house|apartment|café|cafe|restaurant|shop|store|gym|hall|classroom|bar|lobby|indoors|inside)\b/i;
const NIGHT = /\b(night|neon|dark|moonlight|midnight|evening)\b/i;
// A location phrase ("in a room"), but not one that points at a pronoun ("light glides across it").
const PREPOSITION = /\s(?:,\s*)?\b(in|inside|at|on|near|by|under|through|across|over|within|against|beside|along|surrounded by|in front of)\b\s+(?!(?:it|him|her|them|me|us|you|itself|themselves)\b)/i;

const ENRICH_ENV = [
  [/^(in|inside) (a|an|the) room$/i, 'in a cozy modern room with warm tones, tasteful decor and a softly blurred background'],
  [/^(in|inside) (a|an|the) office$/i, 'in a bright modern office with glass walls and plants softly blurred in the background'],
  [/^(in|inside) (a|an|the) kitchen$/i, 'in a clean, sunlit modern kitchen with marble countertops'],
  [/^(in|inside) (a|an|the) studio$/i, 'in a professional studio with a seamless backdrop'],
  [/^(on|at) (a|an|the) beach$/i, 'on a wide sandy beach with gentle turquoise waves'],
  [/^(in|on|at) (a|an|the) (city )?street$/i, 'on a lively city street with shops and passers-by'],
  [/^(in|inside) (a|an|the) forest$/i, 'in a lush green forest with tall trees and drifting mist'],
];

const DEFAULTS = {
  talking: {
    action: 'speaking naturally to the camera with expressive facial expressions and small hand gestures',
    camera_movement: 'a slow, subtle push-in', camera_angle: 'eye-level medium close-up',
    lighting_indoor: 'soft key light from a window, warm practical lights in the background and a gentle rim light',
    lighting_outdoor: 'soft natural daylight with a gentle rim light', environment: 'in a cozy modern room with warm tones and a softly blurred background',
    motion: 'natural lip, head and hand movement with stable framing',
  },
  person: {
    action: 'moving naturally and confidently', camera_movement: 'a smooth tracking shot following the subject', camera_angle: 'eye-level medium shot',
    lighting_indoor: 'soft cinematic key light with warm ambient fill', lighting_outdoor: 'warm golden-hour sunlight with soft long shadows',
    environment: 'in a stylish, softly blurred environment', motion: 'natural body movement with realistic physics',
  },
  product: {
    action: 'rotating slowly as light glides across its surface', camera_movement: 'a slow 180-degree orbit around the product', camera_angle: 'low three-quarter hero angle',
    lighting_indoor: 'clean studio lighting with large softboxes, soft reflections and a subtle rim light', lighting_outdoor: 'bright natural light with crisp soft shadows',
    environment: 'on a minimal pedestal against a smooth gradient backdrop', motion: 'slow, smooth and elegant motion', style_extra: 'premium commercial look, crisp product details, clean composition',
  },
  food: {
    action: 'with gentle steam rising and fresh ingredients glistening', camera_movement: 'a slow macro slider shot', camera_angle: '45-degree close-up',
    lighting_indoor: 'warm natural window light with soft shadows', lighting_outdoor: 'warm natural daylight', environment: 'on a rustic wooden table',
    motion: 'slow, appetizing motion', style_extra: 'mouth-watering food commercial look',
  },
  animal: {
    action: 'moving naturally in its habitat', camera_movement: 'a slow tracking shot', camera_angle: "low eye-level shot at the animal's height",
    lighting_indoor: 'soft warm light', lighting_outdoor: 'soft natural daylight', environment: 'in its natural surroundings', motion: 'natural, lifelike animal movement',
  },
  vehicle: {
    action: 'driving smoothly', camera_movement: 'a dynamic tracking shot alongside the vehicle', camera_angle: 'low-angle three-quarter view',
    lighting_indoor: 'dramatic studio lighting with reflections on the bodywork', lighting_outdoor: 'dramatic golden-hour sunlight with reflections on the bodywork',
    environment: 'on an open scenic road', motion: 'fast, smooth movement with motion blur in the background',
  },
  nature: {
    action: 'with wind gently moving through the scene', camera_movement: 'a slow aerial drone glide forward', camera_angle: 'high wide establishing shot',
    lighting_indoor: 'soft light', lighting_outdoor: 'golden-hour sunlight with long soft shadows and atmospheric haze', environment: '',
    motion: 'gentle natural motion of wind, water and clouds',
  },
  city: {
    action: 'bustling with life', camera_movement: 'a smooth tracking shot along the street', camera_angle: 'eye-level wide shot',
    lighting_indoor: 'warm interior lighting', lighting_outdoor: 'soft overcast daylight', lighting_night: 'evening city lights with neon reflections on wet pavement',
    environment: '', motion: 'people and traffic moving naturally',
  },
  abstract: {
    action: 'flowing and transforming continuously', camera_movement: 'a slow orbiting camera', camera_angle: 'centered close-up',
    lighting_indoor: 'glowing volumetric light', lighting_outdoor: 'glowing volumetric light', environment: 'in a dark, infinite space', motion: 'fluid, continuous, mesmerizing motion',
  },
  generic: {
    action: 'in natural motion', camera_movement: 'a slow cinematic dolly-in', camera_angle: 'eye-level medium shot',
    lighting_indoor: 'soft natural cinematic lighting', lighting_outdoor: 'soft natural cinematic daylight', environment: '', motion: 'smooth, natural motion',
  },
};

const ASPECT_PHRASE = {
  '9:16': 'vertical 9:16 framing with the subject centered',
  '1:1': 'square 1:1 framing with a centered composition',
  '16:9': 'widescreen 16:9 cinematic framing',
};

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '').trim();
}

function detectCategory(text) {
  if (TALKING.test(text) && CATEGORY_PATTERNS[2][1].test(text)) return 'talking';
  for (const [name, re] of CATEGORY_PATTERNS) if (re.test(text)) return name;
  return 'generic';
}

/** Splits "A man talking in a room" into subject / action / environment. */
function parse(text) {
  let rest = clean(text);
  let environment = '';
  const m = rest.match(PREPOSITION);
  if (m && m.index > 0) {
    environment = clean(rest.slice(m.index));
    rest = clean(rest.slice(0, m.index));
  }
  let subject = rest;
  let action = '';
  const gerund = rest.match(/^(.*?)\s+(?:(?:is|are|was|were)\s+)?(\w+ing\b.*)$/i);
  const verb = rest.match(/^(.*?)\s+((?:walks|runs|holds|shows|talks|speaks|smiles|dances|drinks|eats|opens|pours|jumps|flies|drives|rides|looks|turns|sits|stands|waves|points|picks|puts|reveals|rotates|spins|floats|falls|rises|explains|presents|says)\b.*)$/i);
  if (gerund && gerund[1]) {
    subject = clean(gerund[1]);
    action = clean(gerund[2]);
  } else if (verb && verb[1]) {
    subject = clean(verb[1]);
    action = clean(verb[2]);
  }
  return { subject, action, environment };
}

function composeParagraph(p, { mode, continuation }) {
  const parts = [];
  const lead = continuation ? 'Continuing seamlessly from the previous shot, ' : '';
  const subject = mode === 'i2v' && !continuation
    ? `${p.subject ? `The ${p.subject.replace(/^(a|an|the)\s+/i, '')}` : 'The main subject'} from the reference image`
    : capitalize(p.subject || 'The scene');
  parts.push(`${lead}${continuation ? subject.charAt(0).toLowerCase() + subject.slice(1) : subject}${p.action ? ` ${p.action}` : ''}${p.environment ? ` ${p.environment}` : ''}.`);
  parts.push(`The camera moves in ${p.camera_movement}, framed as ${/^[aeiou]/i.test(p.camera_angle) ? 'an' : 'a'} ${p.camera_angle}.`);
  parts.push(`Lighting: ${p.lighting}.`);
  parts.push(`${capitalize(p.motion)}.`);
  parts.push(`${capitalize(p.style)}.`);
  if (mode === 'i2v') parts.push('Keep the exact appearance, colors, shapes and details of the reference image.');
  if (continuation) parts.push('Same character, same outfit, same location, same lighting and same visual style as the previous shot.');
  parts.push(`${capitalize(p.aspect_ratio_phrase)}, one continuous ${p.duration}-second shot.`);
  return parts.join(' ').replace(/\s+/g, ' ').replace(/\.\./g, '.');
}

function ruleBased({ prompt, mode, aspectRatio, duration, styleBible, hasImage }) {
  const text = clean(prompt);
  const continuation = Boolean(styleBible);
  const category = detectCategory(`${text} ${continuation ? styleBible.subject : ''}`);
  const d = DEFAULTS[category] || DEFAULTS.generic;
  const parsed = parse(text);
  let { subject, action, environment } = parsed;

  // Pronouns or an empty subject in a follow-up scene refer to the established subject.
  if (continuation && (!subject || /^(he|she|they|it|the (man|woman|person|product)|him|her)$/i.test(subject))) {
    subject = styleBible.subject;
  }
  if (continuation && !environment) environment = styleBible.environment;
  if (!subject && !action) {
    subject = continuation ? styleBible.subject : 'the subject';
    action = continuation ? 'continues the action naturally' : d.action;
  }
  if (!action) action = category === 'talking' ? d.action : (text.split(' ').length <= 3 ? d.action : '');
  if (category === 'talking' && TALKING.test(action) && action.split(' ').length <= 3) action = d.action;
  for (const [re, rich] of ENRICH_ENV) if (re.test(environment)) environment = rich;
  if (!environment && !continuation && d.environment && !(mode === 'i2v' || hasImage)) environment = d.environment;

  const all = `${text} ${environment}`;
  const indoor = INDOOR.test(all) || category === 'product' || category === 'talking';
  let lighting;
  const userLight = LIGHT_MAP.find(([re]) => re.test(text));
  if (userLight) lighting = userLight[1];
  else if (continuation) lighting = styleBible.lighting;
  else if (NIGHT.test(all) && d.lighting_night) lighting = d.lighting_night;
  else lighting = indoor ? d.lighting_indoor : d.lighting_outdoor;

  const userStyle = (text.match(new RegExp(STYLE_TERMS.source, 'gi')) || []).join(', ');
  let style;
  if (continuation && !userStyle) style = styleBible.style;
  else if (userStyle) style = `${userStyle} style, high detail, coherent motion`;
  else style = `cinematic, photorealistic, high detail, natural colors, shallow depth of field, 35mm film look${d.style_extra ? `, ${d.style_extra}` : ''}`;

  const userCamera = text.match(new RegExp(`[^,.]*${CAMERA_TERMS.source}[^,.]*`, 'i'));
  let cameraMovement = userCamera ? clean(userCamera[0]) : d.camera_movement;
  if (!userCamera && (mode === 'i2v' || hasImage) && category === 'product') cameraMovement = 'a slow push-in with gentle parallax';
  if (!userCamera && continuation) cameraMovement = 'a smooth continuation of the previous camera movement';

  const structured = {
    subject: subject || 'the subject',
    environment,
    action,
    camera_movement: cameraMovement,
    camera_angle: continuation ? styleBible.camera_angle || d.camera_angle : d.camera_angle,
    lighting,
    style,
    motion: d.motion,
    duration: Number(duration) || 5,
    aspect_ratio: aspectRatio,
    aspect_ratio_phrase: ASPECT_PHRASE[aspectRatio] || ASPECT_PHRASE['16:9'],
    category,
  };
  return structured;
}

async function viaOllama({ prompt, mode, aspectRatio, duration, styleBible }) {
  const s = settings.get();
  if (!s.ollamaUrl) return null;
  const system = 'You turn short video ideas into structured prompts for an open-source text-to-video model. ' +
    'Answer ONLY with JSON: {"subject","environment","action","camera_movement","camera_angle","lighting","style","motion"}. ' +
    'Write in English (translate if needed), be concrete and visual, one short phrase per field, keep the user\'s intent, no text overlays. ' +
    (mode === 'i2v' ? 'The subject is shown in a reference image; describe motion, not appearance. ' : '') +
    (styleBible ? `This shot continues a previous one; keep subject "${styleBible.subject}", environment "${styleBible.environment}", lighting "${styleBible.lighting}", style "${styleBible.style}" unless told otherwise.` : '');
  try {
    const res = await fetch(`${s.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: s.ollamaModel, stream: false, format: 'json', options: { temperature: 0.4 },
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt || 'continue the scene' }] }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const obj = JSON.parse(data.message && data.message.content);
    const keys = ['subject', 'environment', 'action', 'camera_movement', 'camera_angle', 'lighting', 'style', 'motion'];
    if (!keys.every(k => typeof obj[k] === 'string' && obj[k].trim())) throw new Error('incomplete JSON');
    const out = Object.fromEntries(keys.map(k => [k, clean(obj[k])]));
    return { ...out, duration: Number(duration) || 5, aspect_ratio: aspectRatio,
      aspect_ratio_phrase: ASPECT_PHRASE[aspectRatio] || ASPECT_PHRASE['16:9'], category: detectCategory(out.subject) };
  } catch (err) {
    log.warn(`Ollama prompt enhancement failed, using built-in rules: ${err.message}`);
    return null;
  }
}

const NON_LATIN = /[؀-ۿЀ-ӿ֐-׿一-鿿぀-ヿ가-힯]/;

/**
 * @returns {Promise<{prompt:string, structured:object, engine:string, styleBible:object, note?:string}>}
 */
async function enhance({ prompt, mode = 't2v', aspectRatio = '16:9', duration = 5, styleBible = null, hasImage = false, enabled = true }) {
  const text = clean(prompt);
  if (!enabled && text) {
    return { prompt: text, structured: null, engine: 'off', styleBible: styleBible || { subject: text.slice(0, 120), environment: '', lighting: '', style: '', camera_angle: '' } };
  }
  let structured = await viaOllama({ prompt: text, mode, aspectRatio, duration, styleBible });
  let engine = 'ollama';
  let note;
  if (!structured) {
    engine = 'rules';
    if (NON_LATIN.test(text)) {
      note = 'Tip: open video models understand English best. Write the prompt in English, or enable a local LLM (Ollama) in Settings for automatic translation.';
      structured = ruleBased({ prompt: '', mode, aspectRatio, duration, styleBible, hasImage });
      structured.subject = text.replace(/[\s.]+$/, '');
      structured.action = '';
    } else {
      structured = ruleBased({ prompt: text, mode, aspectRatio, duration, styleBible, hasImage });
    }
  }
  const paragraph = composeParagraph(structured, { mode, continuation: Boolean(styleBible) });
  const bible = styleBible || {
    subject: structured.subject,
    environment: structured.environment,
    lighting: structured.lighting,
    style: structured.style,
    camera_angle: structured.camera_angle,
  };
  return { prompt: paragraph, structured, engine, styleBible: bible, note };
}

module.exports = { enhance, parse, detectCategory };
