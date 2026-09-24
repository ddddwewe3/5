// Proxies the video studio's /api/studio/* calls to the self-hosted video engine
// (image-to-video/backend). The engine can run on this machine or on any machine with a GPU;
// the browser only ever talks to this site, so no engine address or token reaches the client.
const crypto = require('crypto');
const { Readable } = require('stream');

const OWNER_COOKIE = 'vs_uid';
const OWNER_RE = /^[a-f0-9]{32}$/;
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const MAX_UPLOAD_BYTES = 21 * 1024 * 1024; // engine enforces 20 MB per image

// Only the studio API is exposed; everything else on the engine stays private.
const ALLOWED_PATHS = [
  /^\/health$/,
  /^\/models$/,
  /^\/upload$/,
  /^\/files\/[a-f0-9]{32}$/,
  /^\/generations$/,
  /^\/generations\/[a-f0-9]{32}$/,
  /^\/generations\/[a-f0-9]{32}\/(video|thumbnail|cancel|regenerate)$/,
];

const FORWARD_REQUEST_HEADERS = ['content-type', 'content-length', 'range', 'accept', 'if-none-match', 'if-modified-since'];
const FORWARD_RESPONSE_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition',
  'etag', 'last-modified', 'cache-control',
];

const ENGINE_DOWN = {
  detail: {
    message: 'خادم توليد الفيديو غير متصل حاليًا.',
    setup_steps: [
      'شغّل محرك الفيديو: cd image-to-video/backend ثم uvicorn app.main:app --port 8000',
      'تأكد أن ENGINE_URL في ملف .env يشير إلى عنوان المحرك (الافتراضي http://127.0.0.1:8000).',
      'للتوليد بالذكاء الاصطناعي يجب أيضًا تشغيل ComfyUI على جهاز فيه كرت شاشة (راجع README).',
    ],
  },
};

function parseCookies(header) {
  const cookies = {};
  for (const part of (header || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

// Anonymous per-browser id so every visitor gets a private generation history without accounts.
function ownerCookie(req, res, next) {
  let owner = parseCookies(req.headers.cookie)[OWNER_COOKIE];
  if (!owner || !OWNER_RE.test(owner)) {
    owner = crypto.randomBytes(16).toString('hex');
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.append('Set-Cookie',
      `${OWNER_COOKIE}=${owner}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`);
  }
  req.ownerId = owner;
  next();
}

function createStudioProxy({ engineUrl, engineToken = '', timeoutMs = 60_000 }) {
  const base = engineUrl.replace(/\/$/, '');

  return async function studioProxy(req, res) {
    const url = new URL(req.url, 'http://placeholder');
    if (!ALLOWED_PATHS.some(re => re.test(url.pathname))) {
      return res.status(404).json({ detail: { message: 'المسار غير موجود.' } });
    }
    const length = Number(req.headers['content-length'] || 0);
    if (length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ detail: { message: 'حجم الملف أكبر من الحد المسموح (20 ميغابايت).' } });
    }

    const headers = { 'x-owner-id': req.ownerId };
    for (const name of FORWARD_REQUEST_HEADERS) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    if (engineToken) headers.authorization = `Bearer ${engineToken}`;

    const hasBody = !['GET', 'HEAD'].includes(req.method) && (length > 0 || req.headers['transfer-encoding']);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    res.on('close', () => controller.abort());

    let upstream;
    try {
      upstream = await fetch(`${base}/api${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: hasBody ? req : undefined,
        duplex: hasBody ? 'half' : undefined,
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (err) {
      clearTimeout(timer);
      if (res.headersSent || res.destroyed) return;
      console.error(`[studio] engine unreachable at ${base}: ${err.cause?.code || err.message}`);
      return res.status(502).json(ENGINE_DOWN);
    }
    clearTimeout(timer);

    res.status(upstream.status);
    for (const name of FORWARD_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (upstream.status === 401) {
      console.error('[studio] engine rejected ENGINE_API_TOKEN — check that both sides use the same token');
    }
    if (!upstream.body || req.method === 'HEAD') return res.end();
    Readable.fromWeb(upstream.body)
      .on('error', () => res.destroy())
      .pipe(res);
  };
}

module.exports = { createStudioProxy, ownerCookie, parseCookies, OWNER_COOKIE };
