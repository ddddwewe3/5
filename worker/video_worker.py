#!/usr/bin/env python3
"""
OpenReel Studio — local video generation worker.

Runs open-source video diffusion models (LTX-Video, Wan 2.x) directly with Hugging Face
diffusers. The Node server starts this once and talks to it over stdin/stdout using one JSON
object per line, so the loaded model stays cached in (GPU) memory between generations.

Commands (stdin):
  {"cmd": "generate", "id": ..., "model": ..., "mode": "t2v"|"i2v", "prompt": ..., ...}
  {"cmd": "cancel", "id": ...}
  {"cmd": "probe"} | {"cmd": "unload"} | {"cmd": "shutdown"}
Events (stdout):
  {"event": "ready"|"stage"|"download"|"step"|"frames"|"done"|"error"|"cancelled"|"probe"|"log", ...}

Standalone:  python video_worker.py --probe [--model ID] [--models-dir DIR]
"""
import argparse
import gc
import json
import os
import platform
import queue
import subprocess
import sys
import threading
import time
import traceback

_PROTO = sys.stdout.buffer if hasattr(sys.stdout, "buffer") else sys.stdout
# Libraries print progress bars/warnings to stdout; keep stdout clean for the protocol.
sys.stdout = sys.stderr
_emit_lock = threading.Lock()


def emit(obj):
    line = (json.dumps(obj, ensure_ascii=True) + "\n").encode("ascii")
    with _emit_lock:
        _PROTO.write(line)
        _PROTO.flush()


class Cancelled(Exception):
    pass


class WorkerError(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details


STATE = {"model": None, "path": None, "pipe": None, "family": None, "i2v": None, "placed": None,
         "device": None, "dtype": None, "offload": None}
CANCEL = {}


# ─────────────────────────────── environment ───────────────────────────────

def probe(model=None, models_dir=None):
    info = {"ok": True, "python": sys.version.split()[0], "platform": platform.platform(), "executable": sys.executable}
    try:
        import torch  # noqa: F401
        info["torch"] = torch.__version__
        info["cuda"] = bool(torch.cuda.is_available())
        info["cuda_version"] = torch.version.cuda
        info["mps"] = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
        info["gpus"] = []
        if info["cuda"]:
            for i in range(torch.cuda.device_count()):
                p = torch.cuda.get_device_properties(i)
                info["gpus"].append({"name": p.name, "vram_gb": round(p.total_memory / 1024 ** 3, 1),
                                     "bf16": bool(torch.cuda.is_bf16_supported())})
        info["device"] = "cuda" if info["cuda"] else ("mps" if info["mps"] else "cpu")
    except Exception as e:  # torch missing or broken
        info["ok"] = False
        info["error"] = "PyTorch is not installed: %s" % e
        return info
    try:
        import diffusers
        info["diffusers"] = diffusers.__version__
    except Exception as e:
        info["ok"] = False
        info["error"] = "diffusers is not installed: %s" % e
    if model:
        info["model"] = model
        info["model_cached"] = is_cached(model, models_dir)
    if STATE["model"]:
        info["loaded_model"] = STATE["model"]
    return info


def is_cached(model, models_dir):
    if os.path.isdir(model):
        return True
    try:
        from huggingface_hub import snapshot_download
        snapshot_download(repo_id=model, cache_dir=hf_cache(models_dir), local_files_only=True,
                          allow_patterns=["model_index.json"])
        return True
    except Exception:
        return False


def hf_cache(models_dir):
    return os.path.join(models_dir, "huggingface") if models_dir else None


# ─────────────────────────────── model loading ───────────────────────────────

def download(model, models_dir, job_id):
    """Returns a local folder for `model` (HF repo id or local path), downloading on first use."""
    if os.path.isdir(model):
        return model
    from huggingface_hub import snapshot_download
    cache = hf_cache(models_dir)
    try:
        return snapshot_download(repo_id=model, cache_dir=cache, local_files_only=True)
    except Exception:
        pass
    emit({"id": job_id, "event": "stage", "stage": "loading_model",
          "message": "Downloading %s (first run only — this can take a while)" % model})
    try:
        from huggingface_hub import HfApi
        files = HfApi().list_repo_files(model)
        # Diffusers layout only (sub-folders); skip .bin weights where safetensors exist.
        folders_with_st = {f.split("/")[0] for f in files if f.endswith(".safetensors") and "/" in f}
        allow = [f for f in files if "/" in f or f == "model_index.json"]
        allow = [f for f in allow if not (f.endswith(".bin") and f.split("/")[0] in folders_with_st)]
        allow = [f for f in allow if not f.endswith((".msgpack", ".h5", ".onnx", ".ckpt", ".md", ".png", ".jpg", ".mp4", ".gif"))]
        from tqdm.auto import tqdm

        class Progress(tqdm):
            def update(self, n=1):
                r = super().update(n)
                if self.total:
                    emit({"id": job_id, "event": "download", "done": int(self.n), "total": int(self.total),
                          "message": "Downloading model files %d/%d" % (self.n, self.total)})
                return r

        return snapshot_download(repo_id=model, cache_dir=cache, allow_patterns=allow, tqdm_class=Progress)
    except Exception as e:
        raise WorkerError("MODEL_MISSING", "Could not download model '%s': %s" % (model, str(e).splitlines()[0][:300]),
                          traceback.format_exc())


def pick_device(dtype_pref):
    import torch
    if torch.cuda.is_available():
        device = "cuda"
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        device, dtype = "mps", torch.bfloat16
    else:
        device, dtype = "cpu", torch.float32
    dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}.get(dtype_pref, dtype)
    return device, dtype


def family_of(pipe):
    name = type(pipe).__name__
    if name.startswith("LTX"):
        return "ltxv"
    if name.startswith("Wan"):
        return "wan"
    raise WorkerError("MODEL_MISSING", "Unsupported pipeline type %s (supported: LTX-Video, Wan 2.x)" % name)


def place(pipe, offload):
    """Moves a pipeline to the device (or enables CPU offload) — re-applied when switching pipelines."""
    if STATE["placed"] is pipe:
        return
    device = STATE["device"]
    if device == "cuda" and offload in ("model", "sequential"):
        if offload == "sequential":
            pipe.enable_sequential_cpu_offload()
        else:
            pipe.enable_model_cpu_offload()
    else:
        pipe.to(device)
    STATE["placed"] = pipe


def load(req):
    import torch
    from diffusers import DiffusionPipeline
    model = req["model"]
    if STATE["pipe"] is not None and STATE["model"] == model:
        return STATE["pipe"]
    unload()
    job_id = req["id"]
    emit({"id": job_id, "event": "stage", "stage": "loading_model", "message": "Loading %s" % model})
    path = download(model, req.get("models_dir"), job_id)
    device, dtype = pick_device(req.get("dtype", "auto"))
    emit({"id": job_id, "event": "stage", "stage": "loading_model",
          "message": "Loading %s on %s (%s)" % (os.path.basename(model.rstrip("/\\")), device.upper(), str(dtype).replace("torch.", ""))})
    t0 = time.time()
    try:
        index = json.load(open(os.path.join(path, "model_index.json")))
        is_wan = str(index.get("_class_name", "")).startswith("Wan")
        # Wan's VAE is numerically sensitive — keep it in fp32 as recommended by the authors.
        torch_dtype = {"vae": torch.float32, "default": dtype} if is_wan and device != "cpu" else dtype
        pipe = DiffusionPipeline.from_pretrained(path, torch_dtype=torch_dtype)
    except WorkerError:
        raise
    except Exception as e:
        raise WorkerError("MODEL_MISSING", "Could not load model '%s': %s" % (model, str(e).splitlines()[0][:300]), traceback.format_exc())
    family = family_of(pipe)
    offload = req.get("offload", "auto")
    if offload == "auto":
        offload = "none"
        if device == "cuda":
            vram = torch.cuda.get_device_properties(0).total_memory / 1024 ** 3
            offload = "none" if vram >= 20 else ("model" if vram >= 7 else "sequential")
    STATE.update(model=model, path=path, pipe=pipe, family=family, i2v=None, placed=None, device=device, dtype=dtype, offload=offload)
    place(pipe, offload)
    if hasattr(pipe, "vae") and hasattr(pipe.vae, "enable_tiling") and (device != "cuda" or offload != "none"):
        pipe.vae.enable_tiling()
    emit({"event": "log", "message": "Loaded %s (%s) in %.1fs on %s, offload=%s" % (model, family, time.time() - t0, device, offload)})
    return pipe


def unload():
    if STATE["pipe"] is None:
        return
    STATE.update(model=None, path=None, pipe=None, family=None, i2v=None, placed=None)
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def i2v_pipeline(pipe):
    if STATE["i2v"] is not None:
        return STATE["i2v"]
    name = type(pipe).__name__
    if "ImageToVideo" in name or "Condition" in name:
        STATE["i2v"] = pipe
        return pipe
    if STATE["family"] == "ltxv":
        from diffusers import LTXImageToVideoPipeline
        STATE["i2v"] = LTXImageToVideoPipeline.from_pipe(pipe)
    else:
        expand = bool(getattr(pipe.config, "expand_timesteps", False))
        image_dim = getattr(pipe.transformer.config, "image_dim", None) if getattr(pipe, "transformer", None) else None
        if not expand and image_dim is None:
            raise WorkerError("INVALID_INPUT", "This Wan model is text-to-video only. Use an image-to-video model "
                              "(e.g. Wan-AI/Wan2.2-TI2V-5B-Diffusers) or LTX-Video for image-to-video and scene extension.")
        from diffusers import WanImageToVideoPipeline
        STATE["i2v"] = WanImageToVideoPipeline.from_pipe(pipe)
    return STATE["i2v"]


# ─────────────────────────────── generation ───────────────────────────────

def generate(req):
    import numpy as np
    import torch
    from PIL import Image

    job_id = req["id"]
    cancel = CANCEL.setdefault(job_id, threading.Event())
    timings = {}
    t0 = time.time()
    base = load(req)
    timings["load"] = round(time.time() - t0, 2)
    if cancel.is_set():
        raise Cancelled()
    mode = req.get("mode", "t2v")
    if mode == "i2v":
        pipe = i2v_pipeline(base)
    else:
        if "ImageToVideo" in type(base).__name__:
            raise WorkerError("INVALID_INPUT", "This model is image-to-video only — upload an image or pick a text-to-video model.")
        pipe = base
    place(pipe, STATE["offload"])
    if req.get("tiled_decode") and hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()

    width, height, frames = int(req["width"]), int(req["height"]), int(req["frames"])
    steps = int(req.get("steps", 30))
    seed = int(req.get("seed", 0))
    generator = torch.Generator(device="cpu").manual_seed(seed)
    step_times = []

    def on_step_end(p, step, timestep, kwargs):
        if cancel.is_set():
            raise Cancelled()
        step_times.append(time.time())
        emit({"id": job_id, "event": "step", "step": step + 1, "total": steps})
        if step + 1 >= steps:
            emit({"id": job_id, "event": "stage", "stage": "processing", "message": "Decoding frames (VAE)"})
        return kwargs

    kwargs = dict(prompt=req["prompt"], negative_prompt=req.get("negative_prompt") or None, width=width, height=height,
                  num_frames=frames, num_inference_steps=steps, guidance_scale=float(req.get("cfg", 3.0)),
                  generator=generator, output_type="np", callback_on_step_end=on_step_end)
    if STATE["family"] == "ltxv":
        kwargs.update(frame_rate=int(req.get("fps", 24)), decode_timestep=0.05, decode_noise_scale=0.025, max_sequence_length=256)
    if mode == "i2v":
        img = Image.open(req["image_path"]).convert("RGB")
        if img.size != (width, height):
            img = img.resize((width, height), Image.LANCZOS)
        kwargs["image"] = img

    emit({"id": job_id, "event": "stage", "stage": "generating",
          "message": "Generating %d frames at %dx%d on %s" % (frames, width, height, STATE["device"].upper())})
    t1 = time.time()
    with torch.inference_mode():
        out = pipe(**kwargs)
    timings["generate"] = round(time.time() - t1, 2)
    video = out.frames[0]
    if isinstance(video, list):
        video = np.stack([np.asarray(f) for f in video])
    video = np.asarray(video)
    if video.dtype != np.uint8:
        video = (np.clip(video, 0.0, 1.0) * 255.0).round().astype(np.uint8)
    del out
    n, h, w = video.shape[0], video.shape[1], video.shape[2]

    emit({"id": job_id, "event": "stage", "stage": "processing", "message": "Writing %d frames" % n})
    t2 = time.time()
    cmd = [req["ffmpeg"], "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", "%dx%d" % (w, h), "-r", str(req.get("fps", 24)), "-i", "-"] + list(req["encode_args"]) + ["-an", req["output"]]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for i in range(n):
            if cancel.is_set():
                proc.kill()
                raise Cancelled()
            proc.stdin.write(video[i].tobytes())
            if (i + 1) % 8 == 0 or i + 1 == n:
                emit({"id": job_id, "event": "frames", "done": i + 1, "total": n})
        proc.stdin.close()
    except BrokenPipeError:
        pass
    err = proc.stderr.read().decode("utf-8", "replace")
    if proc.wait() != 0:
        raise WorkerError("FFMPEG_ERROR", "FFmpeg failed to encode the generated frames", " ".join(cmd) + "\n" + err)
    timings["encode"] = round(time.time() - t2, 2)
    per_step = None
    if len(step_times) > 2:
        per_step = round((step_times[-1] - step_times[0]) / (len(step_times) - 1), 3)
    del video
    gc.collect()
    if STATE["device"] == "cuda":
        torch.cuda.empty_cache()
    return {"video": req["output"], "frames": n, "width": w, "height": h, "fps": req.get("fps", 24),
            "model": STATE["model"], "family": STATE["family"], "device": STATE["device"],
            "dtype": str(STATE["dtype"]).replace("torch.", ""), "offload": STATE["offload"],
            "timings": timings, "sec_per_step": per_step}


def classify_exception(e):
    text = "%s: %s" % (type(e).__name__, e)
    if "out of memory" in text.lower() or "OutOfMemoryError" in text:
        return "GPU_OOM", "The GPU ran out of memory (%s)" % str(e).splitlines()[0][:200]
    if isinstance(e, (ValueError, TypeError)):
        return "INVALID_INPUT", str(e).splitlines()[0][:300]
    return "PROVIDER_ERROR", "%s: %s" % (type(e).__name__, str(e).splitlines()[0][:300] if str(e) else "")


def handle(msg):
    cmd = msg.get("cmd")
    job_id = msg.get("id")
    if cmd == "probe":
        emit({"id": job_id, "event": "probe", "info": probe(msg.get("model"), msg.get("models_dir"))})
    elif cmd == "unload":
        unload()
        emit({"id": job_id, "event": "unloaded"})
    elif cmd == "load":
        # Warm-up: load the model ahead of the first generation so it starts immediately.
        try:
            load(msg)
            emit({"id": job_id, "event": "loaded", "model": STATE["model"], "device": STATE["device"]})
        except Exception as e:  # noqa: BLE001
            code, message = (e.code, str(e)) if isinstance(e, WorkerError) else classify_exception(e)
            emit({"id": job_id, "event": "error", "code": code, "message": message, "details": traceback.format_exc()})
    elif cmd == "generate":
        try:
            result = generate(msg)
            emit({"id": job_id, "event": "done", "result": result})
        except Cancelled:
            emit({"id": job_id, "event": "cancelled"})
        except WorkerError as e:
            emit({"id": job_id, "event": "error", "code": e.code, "message": str(e), "details": e.details or ""})
        except Exception as e:  # noqa: BLE001 — report everything to the server
            code, message = classify_exception(e)
            emit({"id": job_id, "event": "error", "code": code, "message": message, "details": traceback.format_exc()})
            if code == "GPU_OOM":
                gc.collect()
                try:
                    import torch
                    torch.cuda.empty_cache()
                except Exception:
                    pass
        finally:
            CANCEL.pop(job_id, None)


def serve():
    jobs = queue.Queue()

    def reader():
        stdin = sys.stdin.buffer if hasattr(sys.stdin, "buffer") else sys.stdin
        for raw in stdin:
            line = raw.decode("utf-8", "replace").strip() if isinstance(raw, bytes) else raw.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("cmd") == "cancel":
                CANCEL.setdefault(msg.get("id"), threading.Event()).set()
            elif msg.get("cmd") == "shutdown":
                jobs.put(None)
                return
            else:
                jobs.put(msg)
        jobs.put(None)  # stdin closed → server went away

    threading.Thread(target=reader, daemon=True).start()
    emit({"event": "ready", "pid": os.getpid()})
    while True:
        msg = jobs.get()
        if msg is None:
            break
        handle(msg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--model")
    ap.add_argument("--models-dir")
    args = ap.parse_args()
    if args.probe:
        emit({"event": "probe", "info": probe(args.model, args.models_dir)})
        return
    serve()


if __name__ == "__main__":
    main()
