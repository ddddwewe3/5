// Vesion Studio — free AI video generation UI.
// Talks only to this site's /api/studio proxy; the proxy forwards to the self-hosted engine.
(() => {
  'use strict';

  const API = '/api/studio';
  const MAX_UPLOAD_MB = 20;
  const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
  const MODE_IMAGES = { t2v: 0, i2v: 1, flf2v: 2 };
  const MODE_NAMES = { t2v: 'نص إلى فيديو', i2v: 'صورة إلى فيديو', flf2v: 'أول وآخر إطار' };
  const RATIOS = ['16:9', '9:16', '1:1'];
  const MOTION = [['low', 'هادئة'], ['medium', 'متوسطة'], ['high', 'قوية']];
  const ACTIVE = new Set(['queued', 'running']);
  const STORAGE_KEY = 'vesion-studio-form';
  const IDEAS = {
    t2v: [
      'لقطة سينمائية لمنارة وسط عاصفة ليلية، أمواج ضخمة تتكسر، الكاميرا تقترب ببطء',
      'شارع في مدينة مستقبلية تحت المطر، أضواء نيون تنعكس على الأرض، حركة كاميرا ناعمة',
      'قطة صغيرة تلعب بكرة صوف في غرفة دافئة، إضاءة شمس الغروب، لقطة قريبة',
      'A drone shot flying over snowy mountains at sunrise, golden light, cinematic',
      'Slow motion coffee being poured into a glass cup, steam rising, macro shot',
    ],
    i2v: [
      'الشخص يبتسم ويلتفت ببطء نحو الكاميرا، إضاءة طبيعية، حركة ناعمة',
      'الغيوم تتحرك في السماء والماء يتموج بهدوء، الكاميرا تتحرك للأمام',
      'Gentle wind moves the hair and clothes, subtle camera push-in, cinematic',
    ],
    flf2v: [
      'انتقال سلس ومتدرج بين المشهدين مع حركة كاميرا سينمائية',
      'Smooth cinematic transition from the first frame to the last frame',
    ],
  };

  // ---------------------------------------------------------------- state
  const state = {
    engineReachable: true,
    engineDetail: null,
    health: null,
    models: [],
    defaultModel: null,
    mode: 't2v',
    modelId: null,
    images: [null, null],
    duration: 5,
    resolution: null,
    ratio: '16:9',
    variations: 1,
    motion: 'medium',
    generations: [],
    currentIds: [],
    submitting: false,
    loaded: false,
  };

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    svg.setAttribute('aria-hidden', 'true');
    return svg;
  }

  class ApiError extends Error {
    constructor(message, status = 0, steps = []) {
      super(message);
      this.status = status;
      this.steps = steps;
    }
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(API + path, { credentials: 'same-origin', ...options });
    } catch {
      throw new ApiError('تعذّر الاتصال بالموقع. تحقق من اتصالك بالإنترنت.');
    }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const detail = body && body.detail;
      if (detail && typeof detail === 'object' && detail.message) {
        throw new ApiError(detail.message, response.status, detail.setup_steps || []);
      }
      throw new ApiError(`حدث خطأ غير متوقع (${response.status}).`, response.status);
    }
    return body;
  }

  const videoUrl = (id, download) => `${API}/generations/${id}/video${download ? '?download=1' : ''}`;
  const thumbUrl = id => `${API}/generations/${id}/thumbnail`;

  let toastTimer;
  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2800);
  }

  function saveForm() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: state.mode, modelId: state.modelId, duration: state.duration, resolution: state.resolution,
        ratio: state.ratio, variations: state.variations, motion: state.motion,
        prompt: $('#prompt').value, negative: $('#negative').value,
      }));
    } catch { /* storage unavailable */ }
  }

  function restoreForm() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!saved) return;
      Object.assign(state, {
        mode: MODE_IMAGES[saved.mode] !== undefined ? saved.mode : state.mode,
        modelId: saved.modelId || null, duration: saved.duration || state.duration,
        resolution: saved.resolution || null, ratio: RATIOS.includes(saved.ratio) ? saved.ratio : state.ratio,
        variations: saved.variations || 1, motion: saved.motion || 'medium',
      });
      $('#prompt').value = saved.prompt || '';
      $('#negative').value = saved.negative || '';
    } catch { /* ignore */ }
  }

  const currentModel = () => state.models.find(m => m.id === state.modelId) || null;

  function modeAvailable(model, mode) {
    return Boolean(model && model.availability && model.availability.modes[mode] && model.availability.modes[mode].available);
  }

  // ---------------------------------------------------------------- engine
  async function loadEngine() {
    try {
      const [health, models] = await Promise.all([api('/health'), api('/models')]);
      state.engineReachable = true;
      state.engineDetail = null;
      state.health = health;
      state.models = models.models;
      state.defaultModel = models.default_model;
    } catch (err) {
      state.engineReachable = false;
      state.engineDetail = { message: err.message, steps: err.steps || [] };
      state.health = null;
    }
    state.loaded = true;
    pickModel();
    renderAll();
  }

  function pickModel() {
    const supports = m => m.modes.includes(state.mode);
    const current = currentModel();
    if (current && supports(current) && (modeAvailable(current, state.mode) || !state.models.some(m => supports(m) && modeAvailable(m, state.mode)))) return;
    const ready = state.models.find(m => supports(m) && modeAvailable(m, state.mode) && !m.is_demo);
    const fallback = state.models.find(m => m.id === state.defaultModel && supports(m)) || state.models.find(supports);
    state.modelId = (ready || fallback || {}).id || null;
  }

  function engineSummary() {
    if (!state.loaded) return { state: '', text: 'جارٍ فحص محرك الذكاء الاصطناعي...' };
    if (!state.engineReachable) return { state: 'down', text: 'خادم توليد الفيديو غير متصل — اضغط لمعرفة طريقة التشغيل' };
    const engine = state.health.engine;
    if (!engine.available) return { state: 'off', text: 'محرك الذكاء الاصطناعي غير مشغّل — اضغط للإعداد' };
    const gpu = engine.details && engine.details.gpu;
    const ready = state.models.filter(m => m.availability.available && !m.is_demo).length;
    const gpuText = gpu && gpu.has_gpu ? ` · ${gpu.name.replace(/^cuda:\d+\s*/, '')}${gpu.vram_gb ? ` ${gpu.vram_gb}GB` : ''}` : '';
    return { state: ready ? 'ok' : 'off', text: ready ? `المحرك متصل${gpuText} · ${ready} نموذج جاهز` : 'المحرك متصل لكن لا يوجد نموذج مثبت — اضغط للإعداد' };
  }

  function renderEngine() {
    const pill = $('#enginePill');
    const summary = engineSummary();
    pill.dataset.state = summary.state;
    $('.engine-text', pill).textContent = summary.text;
  }

  // ---------------------------------------------------------------- form rendering
  function renderModes() {
    document.querySelectorAll('.mode-tabs button').forEach(button => {
      button.setAttribute('aria-selected', String(button.dataset.mode === state.mode));
      button.tabIndex = button.dataset.mode === state.mode ? 0 : -1;
    });
  }

  function renderModels() {
    const list = $('#modelList');
    list.replaceChildren();
    const models = state.models.filter(m => m.modes.includes(state.mode));
    if (!state.loaded) {
      list.append(el('p', { class: 'hint', text: 'جارٍ تحميل النماذج...' }));
      return;
    }
    if (!models.length) {
      list.append(el('p', { class: 'hint', text: state.engineReachable ? 'لا يوجد نموذج يدعم هذا الوضع.' : 'تعذّر تحميل قائمة النماذج لأن خادم التوليد غير متصل.' }));
      return;
    }
    for (const model of models) {
      const ready = modeAvailable(model, state.mode);
      const input = el('input', {
        type: 'radio', name: 'model', value: model.id, checked: model.id === state.modelId,
        onchange: () => { state.modelId = model.id; state.resolution = null; renderForm(); saveForm(); },
      });
      const statusTag = model.is_demo
        ? el('span', { class: 'tag demo', text: 'ليس ذكاءً اصطناعيًا' })
        : el('span', { class: `tag ${ready ? 'ok' : 'off'}`, text: ready ? 'جاهز' : 'غير مثبت' });
      list.append(el('label', { class: 'model-card' },
        input,
        el('span', { class: 'model-name' }, model.name, statusTag),
        el('span', { class: 'model-tagline', text: model.tagline }),
        el('span', { class: 'model-meta' },
          model.is_demo ? null : el('span', { class: 'tag free', text: 'مجاني · مفتوح المصدر' }),
          model.min_vram_gb ? el('span', { class: 'tag', text: `VRAM ${model.min_vram_gb}GB+` }) : null,
          el('span', { class: 'tag', text: `${model.fps} fps` }),
          model.license && model.license !== '—' ? el('span', { class: 'tag', text: model.license.split(' (')[0] }) : null,
        ),
      ));
    }
  }

  function radioGroup(container, name, options, value, onChange) {
    container.replaceChildren(...options.map(opt => el('label', { title: opt.title },
      el('input', {
        type: 'radio', name, value: String(opt.value), checked: String(opt.value) === String(value), disabled: opt.disabled,
        onchange: () => { onChange(opt.value); saveForm(); },
      }),
      opt.icon || null,
      opt.label,
    )));
  }

  function ratioIcon(ratio) {
    const [w, h] = ratio.split(':').map(Number);
    const scale = 14 / Math.max(w, h);
    return el('span', { class: 'ratio-icon', style: `width:${Math.round(w * scale)}px;height:${Math.round(h * scale)}px` });
  }

  function renderOptions() {
    const model = currentModel();
    const durations = model ? model.durations : [3, 5, 8];
    if (!durations.includes(state.duration)) state.duration = durations.includes(5) ? 5 : durations[0];
    radioGroup($('#durations'), 'duration', durations.map(d => ({ value: d, label: `${d} ث` })), state.duration,
      v => { state.duration = Number(v); renderDims(); });

    const resolutions = model ? Object.keys(model.resolutions) : ['480p', '720p'];
    if (!resolutions.includes(state.resolution)) state.resolution = (model && model.default_resolution) || resolutions[0];
    radioGroup($('#resolutions'), 'resolution', resolutions.map(r => ({ value: r, label: r })), state.resolution,
      v => { state.resolution = v; renderDims(); });

    radioGroup($('#ratios'), 'ratio', RATIOS.map(r => ({ value: r, label: r, icon: ratioIcon(r) })), state.ratio,
      v => { state.ratio = v; renderDims(); });

    const max = (state.health && state.health.max_variations) || 4;
    if (state.variations > max) state.variations = max;
    radioGroup($('#variations'), 'variations', Array.from({ length: max }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
      state.variations, v => { state.variations = Number(v); renderGenerate(); });

    radioGroup($('#motion'), 'motion', MOTION.map(([value, label]) => ({ value, label })), state.motion, v => { state.motion = v; });
    renderDims();
    $('#langHint').hidden = !(model && model.prompt_language === 'english');
  }

  function renderDims() {
    const model = currentModel();
    const dims = model && model.resolutions[state.resolution] && model.resolutions[state.resolution][state.ratio];
    $('#dimsHint').textContent = dims ? `${dims[0]}×${dims[1]} · ${state.duration} ثوانٍ · ${model.fps} fps` : '';
  }

  function renderImages() {
    const count = MODE_IMAGES[state.mode];
    $('#imagesField').hidden = count === 0;
    $('#imagesLabel').textContent = count === 2 ? 'الإطار الأول والإطار الأخير' : 'الصورة المراد تحريكها';
    const drops = $('#drops');
    drops.className = `drops${count === 2 ? ' two' : ''}`;
    drops.replaceChildren();
    for (let slot = 0; slot < count; slot++) drops.append(dropZone(slot, count));
  }

  function dropZone(slot, count) {
    const image = state.images[slot];
    const label = count === 2 ? (slot === 0 ? 'الإطار الأول' : 'الإطار الأخير') : 'الصورة';
    const input = el('input', {
      type: 'file', accept: ACCEPTED.join(','), 'aria-label': `اختر ${label}`, dataset: { slot: String(slot) },
      onchange: e => { if (e.target.files[0]) setImage(slot, e.target.files[0]); },
    });
    const zone = el('label', { class: 'drop' }, input);
    if (image) {
      zone.append(el('img', { src: image.previewUrl, alt: `معاينة ${label}` }), el('span', { class: 'drop-label', text: label }));
      if (image.uploading) zone.append(el('span', { class: 'uploading', text: 'جارٍ الرفع...' }));
      zone.append(el('button', {
        type: 'button', class: 'icon-btn danger remove', 'aria-label': `حذف ${label}`,
        onclick: e => { e.preventDefault(); removeImage(slot); },
      }, icon('x')));
    } else {
      zone.append(icon('upload'), el('strong', { text: `اختر ${label}` }), el('span', { text: 'أو اسحبها وأفلتها هنا' }));
    }
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('dragover');
      if (e.dataTransfer.files[0]) setImage(slot, e.dataTransfer.files[0]);
    });
    return zone;
  }

  async function setImage(slot, file) {
    hideError();
    if (!ACCEPTED.includes(file.type)) return showError('الملف ليس صورة مدعومة. الأنواع المسموح بها: JPG و PNG و WEBP.');
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return showError(`حجم الصورة أكبر من ${MAX_UPLOAD_MB} ميغابايت.`);
    removeImage(slot, false);
    const image = { previewUrl: URL.createObjectURL(file), uploading: true, fileId: null };
    state.images[slot] = image;
    renderImages();
    renderGenerate();
    const form = new FormData();
    form.append('file', file);
    try {
      const result = await api('/upload', { method: 'POST', body: form });
      if (state.images[slot] !== image) {
        api(`/files/${result.file_id}`, { method: 'DELETE' }).catch(() => {});
        return;
      }
      image.fileId = result.file_id;
    } catch (err) {
      if (state.images[slot] === image) {
        URL.revokeObjectURL(image.previewUrl);
        state.images[slot] = null;
      }
      showError(err.message, err.steps);
    }
    image.uploading = false;
    renderImages();
    renderGenerate();
  }

  function removeImage(slot, rerender = true) {
    const image = state.images[slot];
    if (!image) return;
    URL.revokeObjectURL(image.previewUrl);
    if (image.fileId) api(`/files/${image.fileId}`, { method: 'DELETE' }).catch(() => {});
    state.images[slot] = null;
    if (rerender) { renderImages(); renderGenerate(); }
  }

  function renderIdeas() {
    $('#ideas').replaceChildren(...IDEAS[state.mode].map(text => el('button', {
      type: 'button', class: 'chip', text: text.length > 42 ? text.slice(0, 40) + '…' : text, title: text,
      onclick: () => { $('#prompt').value = text; updateCount(); renderGenerate(); saveForm(); },
    })));
  }

  function updateCount() {
    $('#promptCount').textContent = `${$('#prompt').value.length} / 2000`;
  }

  function blockingReason() {
    if (!state.loaded) return 'جارٍ الفحص...';
    if (!state.engineReachable) return 'خادم توليد الفيديو غير متصل. اضغط على حالة المحرك في الأعلى لمعرفة طريقة التشغيل.';
    const model = currentModel();
    if (!model) return 'لا يوجد نموذج يدعم هذا الوضع.';
    if (!modeAvailable(model, state.mode)) {
      return state.health && !state.health.engine.available
        ? 'محرك الذكاء الاصطناعي غير مشغّل. التوليد متوقف حتى يتم تشغيله — لا نعرض نتائج وهمية.'
        : `النموذج ${model.name} غير مثبت على المحرك. اضغط على حالة المحرك لمعرفة الملفات المطلوبة.`;
    }
    const needed = MODE_IMAGES[state.mode];
    const images = state.images.slice(0, needed);
    if (images.some(i => !i)) return needed === 2 ? 'ارفع الإطار الأول والإطار الأخير.' : 'ارفع صورة لتحريكها.';
    if (images.some(i => i.uploading)) return 'انتظر حتى يكتمل رفع الصورة.';
    if (!$('#prompt').value.trim()) return 'اكتب وصفًا للفيديو في خانة البرومبت.';
    return null;
  }

  function renderGenerate() {
    const reason = state.submitting ? 'جارٍ الإرسال...' : blockingReason();
    const button = $('#generateBtn');
    button.disabled = Boolean(reason);
    $('span', button).textContent = state.variations > 1 ? `ولّد ${state.variations} فيديوهات` : 'ولّد الفيديو';
    const note = $('#generateNote');
    note.textContent = reason && state.loaded ? reason : 'بدون رصيد · بدون اشتراك · بدون علامة مائية';
    note.classList.toggle('warn', Boolean(reason && state.loaded && !state.submitting));
  }

  function renderForm() {
    renderModes();
    renderModels();
    renderImages();
    renderOptions();
    renderIdeas();
    renderGenerate();
  }

  function renderAll() {
    renderEngine();
    renderForm();
    renderCurrent();
    renderLibrary();
  }

  function showError(message, steps = []) {
    const box = $('#formError');
    box.replaceChildren(el('strong', { text: message }));
    if (steps.length) box.append(el('ol', {}, steps.map(step => el('li', { text: step }))));
    box.hidden = false;
  }

  function hideError() {
    $('#formError').hidden = true;
  }

  // ---------------------------------------------------------------- generate
  async function generate() {
    hideError();
    const reason = blockingReason();
    if (reason) return showError(reason);
    const seedValue = $('#seed').value.trim();
    const body = {
      model: state.modelId,
      mode: state.mode,
      prompt: $('#prompt').value.trim(),
      negative_prompt: $('#negative').value.trim(),
      image_ids: state.images.slice(0, MODE_IMAGES[state.mode]).map(i => i.fileId),
      duration: state.duration,
      aspect_ratio: state.ratio,
      resolution: state.resolution,
      motion: state.motion,
      variations: state.variations,
      seed: seedValue ? Number(seedValue) : null,
    };
    state.submitting = true;
    renderGenerate();
    try {
      const result = await api('/generations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      addGenerations(result.generations, true);
      toast(result.generations.length > 1 ? `تمت إضافة ${result.generations.length} فيديوهات إلى قائمة التوليد` : 'بدأ توليد الفيديو');
      $('#current').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      showError(err.message, err.steps);
      if (err.status === 503 || err.status === 502) loadEngine();
    } finally {
      state.submitting = false;
      renderGenerate();
    }
  }

  function addGenerations(items, makeCurrent) {
    const ids = new Set(items.map(g => g.id));
    state.generations = [...items, ...state.generations.filter(g => !ids.has(g.id))];
    if (makeCurrent) state.currentIds = items.map(g => g.id);
    renderCurrent();
    renderLibrary();
    schedulePoll(1500);
  }

  // ---------------------------------------------------------------- polling
  let pollTimer;
  function schedulePoll(delay) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(poll, delay);
  }

  async function poll() {
    const hasActive = state.generations.some(g => ACTIVE.has(g.status));
    try {
      const { generations } = await api('/generations?limit=60');
      mergeGenerations(generations);
    } catch { /* keep last state; retry below */ }
    schedulePoll(hasActive || state.generations.some(g => ACTIVE.has(g.status)) ? 2000 : 20000);
  }

  function mergeGenerations(fresh) {
    const before = new Map(state.generations.map(g => [g.id, g.status]));
    state.generations = fresh;
    for (const g of fresh) {
      if (before.get(g.id) && ACTIVE.has(before.get(g.id)) && g.status === 'completed') toast('اكتمل فيديو جديد ✨');
    }
    state.currentIds = state.currentIds.filter(id => fresh.some(g => g.id === id));
    renderCurrent();
    renderLibrary();
  }

  // ---------------------------------------------------------------- output cards
  const cardCache = new Map(); // id -> { key, node }

  function cardKey(g) {
    return ACTIVE.has(g.status) ? `${g.status}:${g.progress}:${g.message}:${g.queue_position}` : g.status;
  }

  function aspectStyle(g) {
    const [w, h] = (g.params.aspect_ratio || '16:9').split(':').map(Number);
    return `aspect-ratio:${w}/${h}`;
  }

  function actionButtons(g, { compact = false } = {}) {
    const buttons = [];
    if (g.status === 'completed') {
      buttons.push(el('a', { class: 'btn btn-primary btn-sm', href: videoUrl(g.id, true), download: `vesion-${g.id.slice(0, 8)}.mp4` },
        icon('download'), compact ? null : 'تنزيل'));
    }
    if (ACTIVE.has(g.status)) {
      buttons.push(el('button', { type: 'button', class: 'btn btn-outline btn-sm', onclick: () => cancel(g) }, icon('x'), 'إلغاء'));
    } else {
      buttons.push(el('button', { type: 'button', class: 'btn btn-outline btn-sm', title: 'إعادة التوليد بنفس الإعدادات وبذرة جديدة', onclick: () => regenerate(g) },
        icon('refresh'), compact ? null : 'إعادة التوليد'));
    }
    buttons.push(el('button', { type: 'button', class: 'icon-btn', title: 'استخدم نفس الإعدادات', 'aria-label': 'استخدم نفس الإعدادات', onclick: () => reuse(g) }, icon('copy')));
    buttons.push(el('button', { type: 'button', class: 'icon-btn danger', title: 'حذف', 'aria-label': 'حذف الفيديو', onclick: () => remove(g) }, icon('trash')));
    return buttons;
  }

  function mediaFor(g) {
    const media = el('div', { class: 'gen-media', style: aspectStyle(g) });
    if (g.status === 'completed') {
      media.append(el('video', {
        src: videoUrl(g.id), poster: g.thumbnail_url ? thumbUrl(g.id) : null, controls: true, playsinline: true,
        loop: true, muted: true, autoplay: true, preload: 'metadata',
      }));
    } else if (ACTIVE.has(g.status)) {
      const pct = Math.max(1, g.progress || 0);
      const msg = g.status === 'queued' && g.queue_position > 1 ? `في قائمة الانتظار — الترتيب ${g.queue_position}` : (g.message || 'جارٍ التوليد...');
      media.append(el('div', { class: 'loading' },
        el('div', { class: 'orb' }),
        el('div', { class: 'pct', text: g.status === 'queued' ? '…' : `${pct}%` }),
        el('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': 'تقدم التوليد' },
          el('i', { style: `width:${pct}%` })),
        el('div', { class: 'msg', text: msg }),
      ));
    } else {
      const failed = g.status === 'failed';
      media.append(el('div', { class: `state-overlay ${failed ? 'failed' : ''}` },
        el('strong', { text: failed ? (g.error || 'فشل التوليد.') : 'تم إلغاء التوليد.' }),
        failed && g.setup_steps && g.setup_steps.length ? el('small', { text: g.setup_steps[0] }) : null,
      ));
    }
    return media;
  }

  function genCard(g) {
    return el('article', { class: 'gen-card', dataset: { id: g.id } },
      mediaFor(g),
      el('div', { class: 'gen-body' },
        g.is_demo ? el('span', { class: 'tag demo', text: 'عرض تجريبي — ليس فيديو ذكاء اصطناعي' }) : null,
        el('p', { class: 'gen-prompt', text: g.params.prompt }),
        el('div', { class: 'gen-meta' },
          el('span', { class: 'tag', text: g.model_name }),
          el('span', { class: 'tag', text: `${g.params.duration}ث · ${g.params.resolution} · ${g.params.aspect_ratio}` }),
          el('span', { class: 'tag', text: `seed ${g.params.seed}` }),
        ),
        el('div', { class: 'gen-actions' }, actionButtons(g)),
      ));
  }

  function renderCurrent() {
    const container = $('#current');
    const items = state.currentIds.map(id => state.generations.find(g => g.id === id)).filter(Boolean);
    const seen = new Set();
    items.forEach((g, index) => {
      seen.add(g.id);
      const key = cardKey(g);
      const cached = cardCache.get(g.id);
      let node = cached && cached.node;
      if (!cached || cached.key !== key) {
        const fresh = genCard(g);
        if (node) node.replaceWith(fresh);
        node = fresh;
        cardCache.set(g.id, { key, node });
      }
      if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
    });
    for (const [id, { node }] of cardCache) {
      if (!seen.has(id)) { node.remove(); cardCache.delete(id); }
    }
    $('#emptyState').hidden = items.length > 0 || state.generations.length > 0;
  }

  function renderLibrary() {
    const grid = $('#libraryGrid');
    const days = state.health ? state.health.history_ttl_days : 7;
    $('#libraryHint').textContent = state.generations.length
      ? `${state.generations.length} فيديو · تُحفظ ${days} أيام، نزّل ما تريد الاحتفاظ به`
      : '';
    if (!state.generations.length) {
      grid.replaceChildren(el('p', { class: 'library-empty', text: 'لا توجد فيديوهات بعد. كل ما تولّده سيظهر هنا.' }));
      return;
    }
    grid.replaceChildren(...state.generations.map(libraryCard));
  }

  function libraryCard(g) {
    const card = el('div', {
      class: 'lib-card', tabindex: '0', role: 'button', 'aria-label': `عرض: ${g.params.prompt}`,
      onclick: () => openViewer(g),
      onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openViewer(g); } },
    });
    if (g.status === 'completed') {
      if (g.thumbnail_url) card.append(el('img', { src: thumbUrl(g.id), alt: '', loading: 'lazy' }));
      else card.append(el('div', { class: 'lib-placeholder' }, icon('play')));
      card.addEventListener('mouseenter', () => {
        if (card.querySelector('video')) return;
        const video = el('video', { src: videoUrl(g.id), muted: true, loop: true, playsinline: true, autoplay: true });
        video.muted = true;
        video.addEventListener('playing', () => card.classList.add('playing'));
        card.append(video);
      });
      card.addEventListener('mouseleave', () => {
        card.classList.remove('playing');
        const video = card.querySelector('video');
        if (video) { video.pause(); video.remove(); }
      });
    } else if (ACTIVE.has(g.status)) {
      card.append(el('div', { class: 'lib-placeholder' }, el('div', { class: 'orb' }),
        g.status === 'queued' ? 'في الانتظار' : `${g.progress}%`));
    } else {
      card.append(el('div', { class: 'lib-placeholder', text: g.status === 'failed' ? 'فشل التوليد' : 'ملغى' }));
    }
    card.append(
      el('span', { class: 'lib-status' },
        g.is_demo ? el('span', { class: 'tag demo', text: 'تجريبي' }) : null,
        g.status === 'failed' ? el('span', { class: 'tag off', text: 'فشل' }) : null),
      el('div', { class: 'lib-info' }, el('p', { text: g.params.prompt }),
        el('span', { class: 'hint', text: `${g.mode_label} · ${g.params.duration}ث · ${g.params.aspect_ratio}` })),
    );
    return card;
  }

  // ---------------------------------------------------------------- actions
  async function cancel(g) {
    try {
      const updated = await api(`/generations/${g.id}/cancel`, { method: 'POST' });
      replaceGeneration(updated);
    } catch (err) { toast(err.message); }
  }

  async function regenerate(g) {
    try {
      const result = await api(`/generations/${g.id}/regenerate`, { method: 'POST' });
      closeDialog($('#viewerDialog'));
      addGenerations(result.generations, true);
      toast('تمت إعادة التوليد ببذرة جديدة');
      $('#current').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      toast(err.message);
      if (err.status === 503) loadEngine();
    }
  }

  async function remove(g) {
    if (!window.confirm('حذف هذا الفيديو نهائيًا؟')) return;
    try {
      await api(`/generations/${g.id}`, { method: 'DELETE' });
      state.generations = state.generations.filter(x => x.id !== g.id);
      state.currentIds = state.currentIds.filter(id => id !== g.id);
      closeDialog($('#viewerDialog'));
      renderCurrent();
      renderLibrary();
      toast('تم حذف الفيديو');
    } catch (err) { toast(err.message); }
  }

  function reuse(g) {
    state.mode = g.mode;
    state.modelId = g.model;
    state.duration = g.params.duration;
    state.resolution = g.params.resolution;
    state.ratio = g.params.aspect_ratio;
    state.motion = g.params.motion || 'medium';
    $('#prompt').value = g.params.prompt;
    $('#negative').value = g.params.negative_prompt || '';
    $('#seed').value = '';
    updateCount();
    closeDialog($('#viewerDialog'));
    renderForm();
    saveForm();
    if (MODE_IMAGES[g.mode]) showError('تم نسخ الإعدادات. ارفع الصورة مرة أخرى، أو استخدم «إعادة التوليد» لاستخدام نفس الصورة.');
    $('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('تم نسخ الإعدادات إلى النموذج');
  }

  function replaceGeneration(updated) {
    state.generations = state.generations.map(g => (g.id === updated.id ? updated : g));
    renderCurrent();
    renderLibrary();
  }

  // ---------------------------------------------------------------- dialogs
  function openDialog(dialog) {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog(dialog) {
    if (!dialog.open) return;
    dialog.querySelectorAll('video').forEach(v => v.pause());
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function openViewer(g) {
    const body = $('#viewerBody');
    const details = el('div', { class: 'viewer-details' },
      g.is_demo ? el('span', { class: 'tag demo', text: 'عرض تجريبي — ليس فيديو ذكاء اصطناعي' }) : null,
      el('div', { class: 'prompt-box', text: g.params.prompt }),
      el('dl', {},
        el('dt', { text: 'النموذج' }), el('dd', { text: g.model_name }),
        el('dt', { text: 'الوضع' }), el('dd', { text: g.mode_label }),
        el('dt', { text: 'المدة' }), el('dd', { text: `${g.params.duration} ثوانٍ (${g.params.frames} إطار · ${g.params.fps} fps)` }),
        el('dt', { text: 'الأبعاد' }), el('dd', { text: `${g.params.width}×${g.params.height} (${g.params.aspect_ratio})` }),
        el('dt', { text: 'البذرة' }), el('dd', { text: String(g.params.seed) }),
        g.params.negative_prompt ? el('dt', { text: 'السلبي' }) : null,
        g.params.negative_prompt ? el('dd', { text: g.params.negative_prompt }) : null,
        el('dt', { text: 'التاريخ' }), el('dd', { text: new Date(g.created_at * 1000).toLocaleString('ar') }),
      ),
      g.status === 'failed' && g.error ? el('div', { class: 'alert', text: g.error }) : null,
      g.status === 'failed' && g.error_details ? el('details', { class: 'error-details' },
        el('summary', { text: 'التفاصيل التقنية (أرسلها إذا طلبت المساعدة)' }),
        el('pre', { class: 'cmd', text: g.error_details })) : null,
      el('div', { class: 'viewer-actions' }, actionButtons(g)),
    );
    const media = g.status === 'completed'
      ? el('div', { class: 'viewer-video' }, el('video', { src: videoUrl(g.id), controls: true, autoplay: true, loop: true, playsinline: true }))
      : el('div', { class: 'viewer-video' }, mediaFor(g));
    body.replaceChildren(el('div', { class: 'viewer-grid' }, media, details));
    openDialog($('#viewerDialog'));
  }

  function openSetup() {
    const summary = $('#setupSummary');
    const body = $('#setupBody');
    body.replaceChildren();
    if (!state.engineReachable) {
      summary.textContent = state.engineDetail ? state.engineDetail.message : 'خادم توليد الفيديو غير متصل.';
      body.append(el('ol', { class: 'steps' }, (state.engineDetail ? state.engineDetail.steps : []).map(s => el('li', { text: s }))));
    } else {
      const engine = state.health.engine;
      summary.textContent = engine.available
        ? 'المحرك متصل. هذه حالة كل نموذج والملفات التي يحتاجها (كلها مجانية ومفتوحة المصدر):'
        : engine.message;
      if (!engine.available && engine.setup_steps.length) {
        body.append(el('ol', { class: 'steps' }, engine.setup_steps.map(s => el('li', { text: s }))));
      }
      for (const model of state.models.filter(m => !m.is_demo)) {
        const missing = new Set(Object.values(model.availability.modes).flatMap(m => m.missing.filter(x => x.kind === 'file').map(x => x.name)));
        body.append(el('section', { class: 'setup-model' },
          el('h3', {}, model.name, ' ', el('span', { class: `tag ${model.availability.available ? 'ok' : 'off'}`, text: model.availability.available ? 'جاهز' : 'غير مثبت' })),
          el('p', { class: 'hint', text: `${model.tagline} · الحد الأدنى ${model.min_vram_gb}GB VRAM · الرخصة: ${model.license}` }),
          el('ul', { class: 'files' }, model.files.map(f => el('li', { class: missing.has(f.name) ? 'missing' : '' },
            el('span', {}, el('code', { text: f.name }), f.optional ? ' (اختياري)' : ''),
            el('span', { class: 'hint' }, `ComfyUI/models/${f.folder}`, f.size_gb ? ` · ${f.size_gb}GB` : ''),
          ))),
          el('pre', { class: 'cmd', text: `python scripts/download_models.py --model ${model.id} --comfyui /path/to/ComfyUI` }),
        ));
      }
    }
    body.append(el('p', { class: 'hint', text: 'التفاصيل الكاملة لكل نظام تشغيل موجودة في ملف README. بعد التثبيت أعد تحميل هذه الصفحة.' }));
    openDialog($('#setupDialog'));
  }

  // ---------------------------------------------------------------- wiring
  function init() {
    restoreForm();
    updateCount();

    document.querySelectorAll('.mode-tabs button').forEach(button => {
      button.addEventListener('click', () => {
        state.mode = button.dataset.mode;
        pickModel();
        hideError();
        renderForm();
        saveForm();
      });
      button.addEventListener('keydown', e => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        const tabs = [...document.querySelectorAll('.mode-tabs button')];
        const index = tabs.indexOf(button);
        const next = tabs[(index + (e.key === 'ArrowLeft' ? 1 : -1) + tabs.length) % tabs.length];
        next.click();
        next.focus();
      });
    });
    $('#prompt').addEventListener('input', () => { updateCount(); renderGenerate(); saveForm(); });
    $('#negative').addEventListener('input', saveForm);
    $('#generateBtn').addEventListener('click', generate);
    $('#enginePill').addEventListener('click', openSetup);
    document.querySelectorAll('.modal').forEach(dialog => {
      dialog.addEventListener('click', e => {
        if (e.target === dialog || e.target.closest('[data-close]')) closeDialog(dialog);
      });
      dialog.addEventListener('close', () => dialog.querySelectorAll('video').forEach(v => v.pause()));
    });
    window.addEventListener('beforeunload', () => state.images.forEach(i => i && URL.revokeObjectURL(i.previewUrl)));

    renderAll();
    loadEngine();
    poll();
    // Re-check the engine periodically so starting ComfyUI or installing a model shows up without a reload.
    setInterval(() => { if (!document.hidden) loadEngine(); }, 30000);
  }

  init();
})();
