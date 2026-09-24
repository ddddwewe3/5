# OpenReel Studio

**Free, self-hosted AI video generation.** Type a prompt (or upload a product photo), pick an aspect
ratio and duration, and generate a real MP4 with open-source video models running on your own GPU.
No subscriptions and no per-video credits.

The workflow is prompt → optional image → cinematic prompt → scene 1 → preview → extend → scene 2
→ combine scenes → music/voice/subtitles → FFmpeg → final MP4.

The code, UI and branding are independent. The app only uses open-source components: ComfyUI,
LTX-Video, Wan 2.x, Hugging Face diffusers, FFmpeg, Piper and eSpeak NG.

---

## Features

| | |
|---|---|
| **Create** | Text-to-Video and Image-to-Video, 16:9 / 9:16 / 1:1, 3–10 s, Fast / Balanced / High quality |
| **Prompt engine** | Expands short ideas into a structured cinematic prompt (subject, environment, action, camera movement and angle, lighting, style, motion, duration, aspect ratio). Runs offline, or uses a local Ollama LLM if you have one (which also translates non-English prompts). |
| **Real progress** | Real stages (`QUEUED → LOADING MODEL → GENERATING → PROCESSING → ENCODING → COMPLETE`), sampler steps, elapsed time and an ETA measured from real step timings. Nothing is simulated. |
| **Iterate** | *Regenerate* makes a new version (take) of a scene. *Extend* adds the next scene, starting from the last frame of the previous one and reusing its subject, location, lighting and style. |
| **Edit** | Trim, per-scene and global playback speed, merge scenes, 11 transitions, change aspect ratio (crop / blurred background / black bars), background music, voice-over (local TTS or your own recording), burned-in subtitles (+ SRT), fade in/out. |
| **Projects** | Every generation is saved as a project: prompt, uploads, scenes and their versions, status, timestamps, final renders and metadata. Reopen any project at any time. |
| **Engines** | ComfyUI (default), a local Python/diffusers worker, and an optional paid external API, all behind one `VideoProvider` interface |
| **Errors** | Every failure names the likely cause (*ComfyUI is offline, model is missing, GPU memory is insufficient, invalid input, FFmpeg processing error…*) and how to fix it, with the actual backend error under **Developer logs**. Failures that are safe to retry are retried automatically. |

## Quick start (Windows)

1. Double-click **`setup.bat`**. It checks and installs whatever is missing:
   Node.js, FFmpeg, Python 3.10–3.13, PyTorch (the CUDA build when an NVIDIA GPU is found), the
   local video worker, optional ComfyUI, the **LTX-Video** model (~11.5 GB, one-time download) and
   Piper voices. You can re-run it at any time; finished steps are skipped.
2. Double-click **`start.bat`**. It starts ComfyUI if it's installed and not already running,
   starts the web server and opens <http://localhost:3000>.

| Script | What it does |
|---|---|
| `setup.bat` / `setup.ps1` | Installer + environment check (`setup.ps1 -Yes` for unattended) |
| `start.bat` | Starts ComfyUI (if installed) + server + browser |
| `start-server.bat` | Starts only the web server in the current window |
| `download-models.bat` | Downloads/resumes ComfyUI models (`--model ltxv-2b` (default), `wan22-5b`, `wan21-1.3b`) |

**Already have ComfyUI (for example the portable build)?** Set `COMFYUI_PATH` in `.env` to its
`ComfyUI` folder. `start.bat` then launches it with its own embedded Python, and
`download-models.bat` puts models in the right sub-folders.

### Linux / macOS

```bash
./setup.sh          # add --yes for unattended
./start.sh          # starts ComfyUI (if COMFYUI_PATH is set) + server
```

### Check your setup

```bash
npm run doctor      # Node, FFmpeg, GPU/CUDA, Python/torch, ComfyUI + models, TTS
npm run test:e2e    # generates, extends and renders real videos against the running server
```

## Speed

Generation is set up to be as fast as your hardware allows:

- **Fast preset by default.** The video is generated at reduced resolution (e.g. 512×288 for
  16:9) and FFmpeg upscales it to 720p with lanczos.
- **LTX-Video** is the default model. It is the fastest open video model, and distilled
  checkpoints are preferred automatically (8 steps, CFG 1).
- **Models stay loaded.** ComfyUI keeps them in VRAM, and the Python worker is a persistent
  process that is preloaded when the server starts.
- **BF16/FP16** on CUDA, TF32 matmuls, and automatic CPU offload / VAE tiling on smaller GPUs.
- **NVENC / QuickSync / AMF** hardware H.264 encoding when it's usable (tested at startup), otherwise
  x264 `veryfast`.

LTX-Video was built for near-real-time generation on high-end GPUs. The Fast preset is designed to
keep a 5-second clip under 2 minutes on typical 8–12 GB NVIDIA GPUs, but actual speed depends on
your hardware. The UI always shows the time really measured on your machine. If the ETA goes over
2 minutes, it says so and suggests the Fast preset or a shorter duration. **On CPU-only machines generation works but
takes many minutes.** An NVIDIA GPU with 8 GB+ VRAM is strongly recommended.

## Models (free, open source)

| Model | Use | VRAM | Set up with |
|---|---|---|---|
| **LTX-Video 2B** (default) | text + image → video, fastest | ~8 GB | `download-models.bat` |
| Wan 2.2 TI2V 5B | text + image → video, higher quality | ~12 GB | `download-models.bat --model wan22-5b` |
| Wan 2.1 T2V 1.3B | text → video, small | ~8 GB | `download-models.bat --model wan21-1.3b` |

ComfyUI models are detected automatically from ComfyUI's model folders. The local Python worker
downloads its diffusers model (`LOCAL_MODEL`, default `Lightricks/LTX-Video`) on first use into
`models/`.

Other models (LTX-2, HunyuanVideo, LoRA setups…) can be added as **custom ComfyUI workflows**.
Export them in API format into `workflows/`, as described in [`workflows/README.md`](workflows/README.md).

## Voice-over (local TTS)

The TTS engines are tried in this order: **Piper** (neural, installed by setup with English and
Arabic voices), **Windows voices** (SAPI, always available on Windows), **macOS voices**, and
**eSpeak NG**. The voice is loudness-normalised and synced to the video. If the narration is
longer than the video, the video is extended by holding its last frame, and subtitles are timed to
the speech.

## Architecture

```
server.js                     Express app: API, media (HTTP range), SSE
src/
  providers/
    VideoProvider.js          engine interface
    LocalComfyUIProvider.js   ComfyUI: detection, model discovery, workflow submit, WebSocket progress, cancel
    comfy/workflows.js        auto-generated workflow JSON (LTX-Video, Wan 2.1/2.2) + custom templates
    LocalVideoModelProvider.js  persistent Python worker bridge (model cache, preload, crash recovery)
    OptionalExternalProvider.js Replicate-compatible API (off unless a token is set)
    families.js               per-model resolution / frame / step presets and segment planning
  services/generation.js      scenes, takes, extend, regenerate, render; ETA; safe auto-retry
  queue/jobQueue.js           background queue: GPU lane (1 at a time) + CPU lane for FFmpeg
  media/ffmpeg.js, render.js  encoding, hardware encoder detection, the editing pipeline
  prompt/enhancer.js          cinematic prompt engine (+ optional Ollama)
  tts/index.js                Piper / SAPI / say / eSpeak
worker/video_worker.py        diffusers worker (LTX-Video, Wan), JSON-lines protocol
public/                       web UI (vanilla JS, no build step)
data/projects/<id>/           project.json + uploads, scene takes, renders (real MP4 files)
```

Heavy work never runs on the web server's event loop. It runs in ComfyUI, the Python worker or
FFmpeg child processes, coordinated by the job queue.

### API

| Method | Path | |
|---|---|---|
| POST | `/api/video/generate` | `{prompt, mode: t2v\|i2v, imageId?, aspectRatio, duration, quality?, seed?}` → `{projectId, sceneId, takeId, jobId}` |
| POST | `/api/video/extend` | `{projectId, sceneId?, prompt, duration?}` next scene from the last frame |
| POST | `/api/video/regenerate` | `{projectId, sceneId, prompt?}` new version of a scene |
| GET | `/api/video/status/:id` | job status (`?stream` for Server-Sent Events) |
| POST | `/api/video/cancel/:id` | cancel a job (job, take or render id) |
| GET | `/api/video/:id` | video metadata; `/api/video/:id/download` returns the MP4 |
| POST | `/api/video/upload` | multipart `file` (image or audio) |
| POST | `/api/video/render` | `{projectId, spec}` final edit (trim/speed/transitions/aspect/music/voice/subtitles) |
| GET | `/api/projects`, `/api/projects/:id` | list / open projects (`PATCH`, `DELETE` supported) |
| GET | `/api/events` | live updates (SSE) |
| GET | `/api/system/status` | engines, GPU, FFmpeg, TTS |

## Configuration

Copy `.env.example` to `.env` (setup does this). Everything is optional, and most options can also
be changed on the **Settings** page:

- `COMFYUI_URL`: default `http://127.0.0.1:8188`
- `COMFYUI_PATH`: lets `start.bat` launch ComfyUI
- `COMFYUI_ARGS`: extra ComfyUI flags such as `--lowvram`, or `--directml` for AMD on Windows
- `VIDEO_PROVIDER`: `auto` | `comfyui` | `local` | `external`
- `LOCAL_MODEL`: the Python worker's model
- `OLLAMA_URL`: optional local LLM for prompts
- `EXTERNAL_API_TOKEN`: the optional paid provider, **off by default**

## Troubleshooting

- **"ComfyUI is not running. Start ComfyUI to enable local AI video generation."** Start ComfyUI,
  or set `COMFYUI_PATH` so `start.bat` does it for you. Meanwhile the local Python worker is used
  if it's installed.
- **"Model is missing"** Run `download-models.bat`. Downloads resume if they were interrupted.
- **"GPU memory is insufficient"** Use the Fast preset or a shorter duration, or set
  *GPU memory mode → CPU offload* in Settings. The app already retries once at a lower resolution
  with tiled decoding.
- **"FFmpeg processing error"** The exact FFmpeg command and output are in *Developer logs*
  (Settings page, or the error card).
- Logs are in `logs/app.log`.

## Legacy

The previous project in this repository (the *Vesion Store* Stripe webshop) was moved, unchanged,
to [`legacy/vesion-store/`](legacy/vesion-store/).
