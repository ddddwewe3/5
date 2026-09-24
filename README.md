# Vesion — استوديو فيديو مجاني بالذكاء الاصطناعي · Free AI Video Studio

**العربية:** موقع Vesion أصبح منصة لتوليد الفيديو بالذكاء الاصطناعي **مجانًا بالكامل**: نص إلى فيديو، وصورة إلى فيديو، والانتقال من إطار أول إلى إطار أخير — بنماذج **مفتوحة المصدر** (Wan 2.2، LTX-Video، Wan 2.1) تعمل عبر **ComfyUI** على جهاز فيه كرت شاشة. لا توجد واجهات مدفوعة، ولا رصيد، ولا اشتراكات، ولا نتائج وهمية: إذا لم يكن المحرك مشغّلًا يقول الموقع ذلك بوضوح ويعرض خطوات التشغيل.

**English:** Vesion is now a free AI video-generation platform: text-to-video, image-to-video and first→last-frame video with **open-source models** (Wan 2.2, LTX-Video, Wan 2.1) running in **ComfyUI** on a GPU you control. No paid APIs, credits or subscriptions, and no fake results — if the engine isn't running, the site says so and shows how to start it. The original storefront (Stripe test mode) is still included below.

---

## Architecture

```
Browser ──► Express site (server.js, port 3000)            public/index.html, public/studio.html
              │  /api/studio/*  (lib/studio-proxy.js: anonymous per-browser cookie, token, streaming)
              ▼
            Video engine (FastAPI, image-to-video/backend, port 8000)
              │  model registry (image-to-video/workflows/models.json)
              │  SQLite history · job queue · uploads/outputs · FFmpeg → MP4 + thumbnails
              ▼
            ComfyUI (port 8188, on a machine with an NVIDIA GPU)
              └─ Wan 2.2 5B · LTX-Video 2B · Wan 2.1 14B  (open weights, downloaded once)
```

| Question | Answer |
|---|---|
| Frontend | Existing static site (HTML/CSS/JS, Arabic RTL) + new `/studio` page in the same design |
| Backend | Existing Express server + new Python video engine |
| Storage | Engine: SQLite (`image-to-video/data/engine.db`) + files in `image-to-video/outputs/<id>/` (7-day history). Store orders: `data/orders.json` (unchanged) |
| Authentication | The site has no accounts, so each browser gets an anonymous `vs_uid` cookie; everyone only sees their own history. Engine ↔ site use a shared `ENGINE_API_TOKEN` |
| Deployment | Site: Render free tier (no GPU). Engine + ComfyUI: your GPU machine (see [Deploying](#deploying)) |
| Swapping models | Add workflows + an entry in `models.json` (no code change), or a new provider class in `image-to-video/backend/app/providers/` |

## Which free model? (research, Sept 2026)

| Model | Modes | VRAM | License | Notes |
|---|---|---|---|---|
| **Wan 2.2 TI2V 5B** (default) | text→video, image→video, 720p/24fps | ~8 GB with ComfyUI offloading, 24 GB comfortable | Apache-2.0 | Best quality/speed balance on consumer GPUs; ~9 min for 5 s 720p on an RTX 4090 |
| **LTX-Video 2B v0.9.5** | text→video, image→video | ~12 GB | LTX open weights (free, see model card) | Fastest; English prompts only |
| **Wan 2.1 I2V 14B** (+ FLF2V) | image→video, first→last frame | 16 GB+ (fp8) | Apache-2.0 | Highest image-animation quality |

HunyuanVideo, CogVideoX and Mochi were considered; Wan 2.2 5B was chosen as the default because it is Apache-licensed, covers both text- and image-to-video in one model, and runs on the widest range of consumer GPUs. Sources: [ComfyUI Wan 2.2 guide](https://docs.comfy.org/tutorials/video/wan/wan2_2), [Wan 2.2 VRAM guide](https://willitrunai.com/blog/wan-2-2-vram-requirements), [Local AI video comparison](https://localaimaster.com/blog/local-ai-video-generation), [Open-source video models 2026](https://www.hyperstack.cloud/blog/case-study/best-open-source-video-generation-models).

> **This needs a GPU.** A 5-second AI video on a CPU takes hours, so the engine detects CPU-only ComfyUI and refuses (override: `ALLOW_CPU_GENERATION=true`). Free hosting such as Render has no GPU — run the engine on your own PC/server with an NVIDIA card.

---

## Quick start (all on one machine)

Requirements: Node.js 18+, Python 3.10–3.12, Git, an NVIDIA GPU (8 GB+ VRAM) with a current driver.

### 1. Install ComfyUI + the free model (once, ~18 GB download)

```bash
# Linux / macOS
bash scripts/setup-comfyui.sh               # → ~/ComfyUI, Wan 2.2 5B
# Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File scripts\setup-comfyui.ps1
```
Other models: `python scripts/download_models.py --list`, then `--model ltxv-2b` or `--model wan2.1-i2v-14b`.
Already have ComfyUI (e.g. the Windows portable build)? Only run
`python scripts/download_models.py --comfyui <path-to-ComfyUI>`.

### 2. Start the three processes (three terminals)

```bash
# Terminal 1 — ComfyUI
cd ~/ComfyUI && source venv/bin/activate          # Windows: .\venv\Scripts\activate
python main.py --listen 127.0.0.1 --port 8188

# Terminal 2 — video engine
cd image-to-video/backend
python -m venv .venv && source .venv/bin/activate # Windows: py -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000

# Terminal 3 — website
npm install
npm start
```

Open **http://localhost:3000/studio**. The status pill turns green when ComfyUI and the model files are detected; click it any time to see exactly which files are missing and where they go.

`.env` files are optional for a local setup (defaults work). Templates: `.env.example` (site) and `image-to-video/.env.example` (engine).

---

## Studio features

- Text-to-video, image-to-video (animate one image), first→last-frame (two images)
- Prompt, negative prompt, seed, motion strength
- Duration 3 / 5 / 8 s · aspect ratio 16:9, 9:16, 1:1 · resolution per model (480p / 720p)
- 1–4 variations per request (different seeds), queue with position, real step-by-step progress from ComfyUI's WebSocket
- Cancel, preview, download MP4, regenerate (new seed), reuse settings, delete
- Private history per browser (7 days), thumbnails, hover previews
- Clear Arabic errors: engine offline, CPU-only, missing model files (with download links), out of VRAM
- Optional `ENABLE_DEMO_MODE=true` adds a Ken Burns slideshow “model” for UI testing — clearly labeled *not AI*, off by default

## Deploying

**Everything on one GPU machine:** run the three processes above and put the site behind any reverse proxy.

**Site on Render (free) + engine at home:**
1. On the GPU machine run ComfyUI and the engine as above, with a secret in `image-to-video/.env`:
   `ENGINE_API_TOKEN=<long random string>`
2. Expose only the engine with a free [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/):
   `cloudflared tunnel --url http://127.0.0.1:8000` → prints `https://<name>.trycloudflare.com`
3. In Render → Environment set `ENGINE_URL=https://<name>.trycloudflare.com` and the same `ENGINE_API_TOKEN`.

ComfyUI itself stays on `127.0.0.1` and is never exposed. Videos are stored on the engine machine; the site streams them through.

## Tests

```bash
npm test                                             # site: studio proxy (node:test)
cd image-to-video/backend && pip install -r requirements-dev.txt && python -m pytest -q   # engine (fake ComfyUI)
cd image-to-video/frontend && npm install && npm test # standalone React client
```

## Project layout (new parts)

```
public/studio.html, public/js/studio.js, public/css/studio.css   the studio UI
lib/studio-proxy.js                    /api/studio → engine proxy, anonymous owner cookie
image-to-video/backend/app/            engine: main.py (API), worker.py (queue), store.py (SQLite),
                                       models_registry.py, providers/{comfyui,mock}.py, ffmpeg_utils.py
image-to-video/workflows/              models.json + ComfyUI API-format workflows per model/mode
scripts/                               setup-comfyui.sh / .ps1, download_models.py
image-to-video/frontend/               earlier standalone React image-to-video client (still works)
```

---

# Winkel · Vesion Store (clone) — leerproject

Werkende webshop-clone (front-end + Express-backend) met een echte checkout-flow via
[Stripe Checkout](https://stripe.com/docs/payments/checkout) in **test-mode**. Er wordt geen
echt geld afgeschreven en er is geen echt product achter — dit is puur om een volledige
order-flow (betaling → webhook → order opslaan → bevestigingsmail) end-to-end te zien werken.

## Setup

1. **Dependencies installeren**
   ```
   npm install
   ```

2. **Stripe test keys**
   Maak gratis een Stripe-account (of gebruik een bestaand account) en pak je **test**
   API-keys op https://dashboard.stripe.com/test/apikeys — verificatie van een echt
   bedrijf is niet nodig om test-mode te gebruiken.

   Kopieer `.env.example` naar `.env` en vul `STRIPE_SECRET_KEY` en
   `STRIPE_PUBLISHABLE_KEY` in (beide beginnen met `sk_test_...` / `pk_test_...`).

3. **Server starten**
   ```
   npm start
   ```
   De site draait op http://localhost:3000

4. **Webhook lokaal doorsturen**
   Stripe stuurt betalingsbevestigingen naar een webhook-endpoint. Lokaal test je dat met de
   [Stripe CLI](https://stripe.com/docs/stripe-cli):
   ```
   stripe login
   stripe listen --forward-to localhost:3000/api/webhook
   ```
   De CLI print een `whsec_...` signing secret — zet die in `.env` als `STRIPE_WEBHOOK_SECRET`
   en herstart de server.

5. **Testbetaling doen**
   Klik "شراء" (kopen) op de site → je komt op de Stripe-hosted checkoutpagina. Gebruik een
   [Stripe testkaart](https://stripe.com/docs/testing), bv.:
   - Kaartnummer: `4242 4242 4242 4242`
   - Vervaldatum: elke datum in de toekomst
   - CVC: elke 3 cijfers

   Na een geslaagde betaling:
   - komt de bestelling in `data/orders.json` te staan (via de webhook)
   - print de server in de console een preview-link van een bevestigingsmail
     (via [Ethereal](https://ethereal.email/) — een test-postbus, er wordt geen echte
     mail verstuurd)

## Structuur

```
server.js              Express-server, Stripe checkout + webhook
lib/orders.js          Orders opslaan/lezen (data/orders.json)
lib/mailer.js          Bevestigingsmail via Ethereal test-inbox
public/index.html      De winkel
public/success.html    Na geslaagde betaling
public/cancel.html     Bij geannuleerde betaling
public/css/style.css   Styling
public/js/main.js      FAQ-accordion, mobiel menu, checkout-call
```

## Van test naar echt

Dit project is bewust een leeromgeving: geen live Stripe-keys, geen echte productlevering.
Wil je dit ooit echt live zetten om een bestaand product te verkopen, dan komt daar meer bij
kijken dan keys omwisselen — o.a. een echte manier om het product te leveren na betaling,
bedrijfsgegevens bij Stripe, facturatie/btw, en een privacy-/retourbeleid.

`lib/orders.js` and `lib/mailer.js` were missing from the GitHub upload (the server could not start) and have been restored from the original archive.
