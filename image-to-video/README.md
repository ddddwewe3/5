# تحويل الصور إلى فيديو — Local Image-to-Video

تطبيق ويب **مجاني ومفتوح المصدر ويعمل محليًا بالكامل**: ارفع صورة أو صورتين، واكتب وصفًا (برومبت)، ثم ولّد فيديو قصيرًا بالذكاء الاصطناعي عبر **ComfyUI** ونموذج **Wan2.1** على جهازك، وشاهده ونزّله.

A **free, open-source, fully local** web app: upload one or two images, write a prompt, generate a short AI video with **ComfyUI + Wan2.1** on your own GPU, preview it and download it.

- لا توجد واجهات برمجة مدفوعة ولا مفاتيح API. / No paid APIs, no API keys.
- الصور لا تُرسل إلى أي خدمة خارجية افتراضيًا. / Images never leave your machine by default.
- الصور المرفوعة تُحذف بعد 24 ساعة، والفيديوهات بعد 7 أيام. / Uploads are deleted after 24 h, videos after 7 days.
- لا توجد نتائج وهمية: إذا لم يكن ComfyUI مشغّلًا تُرفض الطلبات مع خطوات التشغيل. / No fake results: without ComfyUI, requests are refused with setup steps.
- **العرض التجريبي** (`ENABLE_DEMO_MODE=true`، معطّل افتراضيًا) عرض شرائح Ken Burns لاختبار الواجهة فقط، **وليس ذكاءً اصطناعيًا**.
  **Demo mode** (off by default) is a Ken Burns slideshow for UI testing only. **It is not AI video.**

> **This folder is also the video engine behind the main website's `/studio` page** (text-to-video,
> image-to-video, history, variations). See the [root README](../README.md) for the full platform setup.
> The engine's models are defined in [`workflows/models.json`](workflows/models.json).

> استخدم صور الأشخاص الحقيقيين بعد الحصول على موافقتهم.
> Only use photos of real people with their consent.

---

## المحتويات / Contents

1. [المتطلبات / Requirements](#1-المتطلبات--requirements)
2. [التثبيت والتشغيل / Install & run](#2-التثبيت-والتشغيل--install--run) (Windows · macOS · Linux)
3. [تثبيت ComfyUI و Wan2.1 / Install ComfyUI + Wan2.1](#3-تثبيت-comfyui-و-wan21--install-comfyui--wan21)
4. [مكان ملف سير العمل / Where the workflow JSON goes](#4-مكان-ملف-سير-العمل--where-the-workflow-json-goes)
5. [Docker](#5-docker)
6. [الاختبارات / Tests](#6-الاختبارات--tests)
7. [واجهة API / API](#7-واجهة-api--api)
8. [البنية / Project structure](#8-البنية--project-structure)
9. [حل المشكلات / Troubleshooting](#9-حل-المشكلات--troubleshooting)

---

## 1. المتطلبات / Requirements

| | For the web app | For real AI video (optional) |
|---|---|---|
| Python | 3.10+ | ComfyUI's own Python |
| Node.js | 20+ (22 recommended) | — |
| FFmpeg | **Not required** — bundled via `imageio-ffmpeg` (a system FFmpeg is used if found) | — |
| GPU | Not needed to run the app (AI generation is refused on CPU-only ComfyUI) | NVIDIA GPU, ~12 GB+ VRAM recommended for Wan2.1 14B fp8 (less with GGUF quantized models) |
| Disk | ~1 GB | ~30 GB for Wan2.1 model files |

الواجهة تعمل بدون كرت شاشة، لكن توليد الفيديو بالذكاء الاصطناعي يحتاج كرت شاشة قويًا.
The UI runs without a GPU, but AI generation needs a capable GPU.

---

## 2. التثبيت والتشغيل / Install & run

افتح طرفيتين (Terminal): واحدة للواجهة الخلفية، وواحدة للواجهة الأمامية.
Open two terminals: one for the backend, one for the frontend.

### Windows (PowerShell)

```powershell
# 1) Get the code, then go into the project folder
cd image-to-video
copy .env.example .env

# 2) Backend  (terminal 1)
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000

# 3) Frontend (terminal 2)
cd image-to-video\frontend
npm install
npm run dev
```

If PowerShell blocks `Activate.ps1`, run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
إذا منع PowerShell تشغيل `Activate.ps1` فنفّذ الأمر أعلاه مرة واحدة.

### macOS / Linux

```bash
# 1) Project folder
cd image-to-video
cp .env.example .env

# 2) Backend  (terminal 1)
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 8000

# 3) Frontend (terminal 2)
cd image-to-video/frontend
npm install
npm run dev
```

ثم افتح / Then open: **http://127.0.0.1:5173**

إذا لم يكن ComfyUI مثبتًا، ستظهر رسالة واضحة بخطوات التثبيت ولن يتم عرض أي نتيجة وهمية.
If ComfyUI is not installed, the page shows setup steps; no fake result is ever produced.

Node.js: https://nodejs.org · Python: https://www.python.org/downloads/ (on Windows tick **"Add python.exe to PATH"**).

---

## 3. تثبيت ComfyUI و Wan2.1 / Install ComfyUI + Wan2.1

### 3.1 ComfyUI

**Windows (easiest):** download the free **ComfyUI portable** build for NVIDIA from
https://github.com/comfyanonymous/ComfyUI/releases, extract it, and run `run_nvidia_gpu.bat`.
(ComfyUI Desktop from https://www.comfy.org/download also works.)

**macOS / Linux / manual:**

```bash
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI
python3 -m venv venv
source venv/bin/activate            # Windows: venv\Scripts\activate
# NVIDIA: install PyTorch with CUDA first — see https://pytorch.org/get-started/locally/
pip install -r requirements.txt
python main.py --listen 127.0.0.1 --port 8188
```

تحقق أنه يعمل بفتح / Check it works: http://127.0.0.1:8188

> **Update ComfyUI** to a recent version: the Wan nodes (`WanImageToVideo`, `WanFirstLastFrameToVideo`) are built into current ComfyUI.
> Apple Silicon Macs can run ComfyUI, but Wan2.1 14B is very slow there.

### 3.2 Wan2.1 model files / ملفات النموذج

Download from the free Comfy-Org repackaged repository:
https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/tree/main/split_files

| File | Put it in |
|---|---|
| `diffusion_models/wan2.1_i2v_480p_14B_fp8_e4m3fn.safetensors` (one image) | `ComfyUI/models/diffusion_models/` |
| `diffusion_models/wan2.1_flf2v_720p_14B_fp8_e4m3fn.safetensors` (two images, optional) | `ComfyUI/models/diffusion_models/` |
| `text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `ComfyUI/models/text_encoders/` |
| `vae/wan_2.1_vae.safetensors` | `ComfyUI/models/vae/` |
| `clip_vision/clip_vision_h.safetensors` | `ComfyUI/models/clip_vision/` |

الأسماء يجب أن تطابق تمامًا ما في ملف سير العمل، أو عدّل الأسماء داخل ملف JSON.
File names must match the workflow JSON exactly (or edit the names in the JSON).

If the `flf2v` model is missing, two-image requests automatically fall back to animating the first image.

### 3.3 Connect the app / ربط التطبيق

1. Keep ComfyUI running on `http://127.0.0.1:8188`.
2. In `.env`: `COMFYUI_URL=http://127.0.0.1:8188` (default). Installed models are detected automatically.
3. Restart the backend and reload the page. The status box turns green: **"ComfyUI متصل وجاهز."**

How it works: the backend uploads your images to ComfyUI (`POST /upload/image`), fills the workflow
placeholders, queues it (`POST /prompt`), polls `GET /history/{id}`, downloads the result (`GET /view`)
and converts it to H.264 MP4 with FFmpeg.

**Privacy:** the backend refuses a non-local `COMFYUI_URL` (anything other than localhost / LAN addresses)
unless you explicitly set `ALLOW_REMOTE_COMFYUI=true`.
لحماية الخصوصية يرفض التطبيق إرسال الصور إلى عنوان ComfyUI غير محلي إلا إذا فعّلت ذلك صراحةً.

Generation time: on an RTX 4090 a 5-second 480p clip takes a few minutes; on smaller GPUs much longer.
Start with **3 seconds**. If you run out of VRAM, see the troubleshooting section.

---

## 4. مكان ملف سير العمل / Where the workflow JSON goes

ضع ملفات سير العمل في مجلد **`workflows/`** في جذر المشروع:
Place workflow files in the **`workflows/`** folder at the project root:

```
image-to-video/workflows/wan2.1_i2v_480p_api.json     ← one image (ready to use)
image-to-video/workflows/wan2.1_flf2v_720p_api.json   ← two images: first → last frame (ready to use)
```

Both ship with the project. To use **your own** workflow:

1. Build it in ComfyUI → **Settings → enable Dev mode** → **Workflow → Export (API)**.
   (A normal UI-format save is rejected with a clear message.)
2. Put `{{IMAGE_1}}`, `{{PROMPT}}`, `{{WIDTH}}`, `{{HEIGHT}}`, `{{FRAMES}}`, `{{SEED}}` … where the values should go —
   full list in [`workflows/README.md`](workflows/README.md).
3. Save it in `workflows/` and reference it from a model entry in `workflows/models.json`.

---

## 5. Docker

```bash
cp .env.example .env          # Windows: copy .env.example .env
docker compose up --build
```

Open **http://127.0.0.1:8080**. ComfyUI stays on your host (so it uses your GPU directly);
the container reaches it at `http://host.docker.internal:8188`, so start ComfyUI with
`--listen 0.0.0.0` (or your Docker bridge IP) when using Docker. Uploads and outputs are stored in
`./uploads` and `./outputs`. The port is bound to `127.0.0.1` only.

---

## 6. الاختبارات / Tests

```bash
# Backend
cd backend
pip install -r requirements-dev.txt
python -m pytest -q

# Frontend
cd frontend
npm test
npm run build
```

The backend tests use a **fake ComfyUI server** to exercise the whole ComfyUI path (upload → queue →
poll → download → MP4), model-file detection, CPU detection, history, owners, cancel and upload validation.

---

## 7. واجهة API / API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Engine status + Arabic setup steps |
| `POST` | `/api/upload` | multipart `file` → `{file_id, width, height}`. JPG/PNG/WEBP, ≤ 20 MB, re-encoded to PNG (metadata stripped); executables rejected |
| `GET` | `/api/models` | Models, supported modes/resolutions, installed-file detection |
| `POST` | `/api/generations` | `{mode: t2v\|i2v\|flf2v, model, prompt, negative_prompt, image_ids, duration, aspect_ratio, resolution, motion, variations, seed}` → `202 {batch_id, generations}` |
| `GET` | `/api/generations` | History of the caller (`X-Owner-Id` header) |
| `GET/DELETE` | `/api/generations/{id}` | Status (progress, queue position) / delete |
| `POST` | `/api/generations/{id}/cancel`, `/regenerate` | Cancel / regenerate with a new seed |
| `GET` | `/api/generations/{id}/video`, `/thumbnail` | MP4 (`?download=1`) / JPEG poster |
| `POST` | `/api/generate` (original) | `{image_ids: [1–2], prompt, duration: 3\|5\|8, aspect_ratio: "9:16"\|"16:9"\|"1:1", motion: "low"\|"medium"\|"high", provider: "auto"\|"comfyui"\|"mock"}` → `202 {job_id, is_mock, notice}` |
| `GET` | `/api/status/{job_id}` | `{status, progress, message, error, setup_steps, video_url}` |
| `GET` | `/api/video/{job_id}` | MP4 (`?download=1` for attachment) |
| `DELETE` | `/api/files/{file_id}` | Delete an uploaded image |

Errors are JSON: `{"detail": {"message": "<Arabic message>", "setup_steps": [...]}}`.
Interactive docs: http://127.0.0.1:8000/docs

### Adding another engine / إضافة محرك آخر

Another ComfyUI model: add its API-format workflows and an entry in `workflows/models.json`.
A different engine: implement `VideoProvider` (`backend/app/providers/base.py`: `status()`, `model_status()`,
`generate()`), register it in `backend/app/providers/__init__.py`, and set `"provider"` in `models.json`.

---

## 8. البنية / Project structure

```
image-to-video/
├── backend/
│   ├── app/
│   │   ├── main.py            FastAPI routes, CORS, cleanup loop
│   │   ├── config.py          .env settings
│   │   ├── storage.py         upload validation, safe storage, 24h cleanup
│   │   ├── jobs.py            background jobs
│   │   ├── ffmpeg_utils.py    MP4 conversion, Ken Burns slideshow
│   │   └── providers/         base.py · comfyui.py · mock.py
│   ├── tests/
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/                  React + Vite + TypeScript + Tailwind (RTL Arabic)
│   ├── src/App.tsx, src/api.ts, src/components/
│   ├── nginx.conf, Dockerfile
├── workflows/                 ComfyUI API-format workflows
├── uploads/                   uploaded images (auto-deleted)
├── outputs/                   generated videos (auto-deleted)
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## 9. حل المشكلات / Troubleshooting

| المشكلة / Problem | الحل / Fix |
|---|---|
| "تعذّر الاتصال بالخادم المحلي" | Backend not running — start `uvicorn` on port 8000. |
| "ComfyUI غير متاح" | Start ComfyUI on port 8188, check `COMFYUI_URL`. |
| "رفض ComfyUI سير العمل… ملفات النموذج" | A model file is missing or named differently; see section 3.2. Details are in the backend log. |
| "نفدت ذاكرة كرت الشاشة (VRAM)" | Use 3 seconds, close other GPU apps, or switch to a GGUF quantized Wan2.1 I2V model. |
| Video looks unrelated to the prompt | Wan understands English best; Arabic prompts work partially. Try an English prompt. |
| Two-image request only animates the first image | Download the optional `flf2v` model file. |
| `npm` / `node` not found | Install Node.js 20+ and reopen the terminal. |

---

## License

MIT for this project's code. ComfyUI (GPL-3.0) and Wan2.1 (Apache-2.0) are separate projects with their own licenses.
