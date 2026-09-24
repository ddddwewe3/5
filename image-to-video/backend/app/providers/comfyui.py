"""Local ComfyUI provider (Wan 2.2, LTX-Video, Wan 2.1 ...) via ComfyUI's HTTP + WebSocket API.

Workflows are API-format JSON files in /workflows. String values that are exactly a
placeholder such as "{{WIDTH}}" are replaced with typed values; placeholders embedded in
longer strings are substituted as text. Supported placeholders:

  IMAGE_1, IMAGE_2, PROMPT, NEGATIVE_PROMPT, WIDTH, HEIGHT, FRAMES, FPS, SEED, STEPS,
  DURATION, MOTION (0.3 / 0.6 / 0.9), FILENAME_PREFIX
"""

from __future__ import annotations

import ipaddress
import json
import re
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx

from ..ffmpeg_utils import FFmpegError, convert_to_mp4, frames_to_mp4
from .base import (
    CancelCheck,
    GenerationCancelled,
    GenerationError,
    GenerationRequest,
    ModelAvailability,
    ProgressCallback,
    ProviderStatus,
    ProviderUnavailable,
    VideoProvider,
)

PLACEHOLDER_RE = re.compile(r"\{\{([A-Z0-9_]+)\}\}")

MOTION_VALUES = {"low": 0.3, "medium": 0.6, "high": 0.9}
MOTION_PROMPTS = {
    "low": "subtle gentle motion, mostly static camera",
    "medium": "natural smooth motion, smooth cinematic camera movement",
    "high": "dynamic lively motion, energetic cinematic camera movement",
}
DEFAULT_NEGATIVE_PROMPT = (
    "blurry, low quality, worst quality, distorted face, deformed, disfigured, extra fingers, "
    "bad hands, watermark, text, subtitles, static image, jpeg artifacts, motion artifacts"
)

VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".gif", ".webp", ".avi"}
LOCAL_HOSTNAMES = {"localhost", "host.docker.internal", "comfyui"}
LOADER_FOLDERS = {
    "UNETLoader": "diffusion_models",
    "CLIPLoader": "text_encoders",
    "DualCLIPLoader": "text_encoders",
    "VAELoader": "vae",
    "CLIPVisionLoader": "clip_vision",
    "CheckpointLoaderSimple": "checkpoints",
    "LoraLoader": "loras",
    "LoraLoaderModelOnly": "loras",
    "UnetLoaderGGUF": "diffusion_models",
}


def setup_steps(settings) -> list[str]:
    return [
        "ثبّت ComfyUI (مجاني ومفتوح المصدر) على جهاز فيه كرت شاشة NVIDIA: شغّل scripts/setup-comfyui.sh (أو .ps1 على ويندوز).",
        "السكربت ينزّل ملفات نموذج Wan 2.2 (5B) تلقائيًا إلى مجلدات ComfyUI/models.",
        "شغّل ComfyUI: python main.py --listen 127.0.0.1 --port 8188",
        f"تأكد أن COMFYUI_URL في ملف .env يساوي عنوان ComfyUI (الحالي: {settings.comfyui_url})",
        "أعد تحميل الصفحة. ستظهر النماذج المثبتة جاهزة للتوليد.",
    ]


def is_local_url(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return False
    if host in LOCAL_HOSTNAMES:
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


def fill_workflow(node, values: dict):
    """Return a copy of the workflow with {{PLACEHOLDER}} values substituted."""
    if isinstance(node, dict):
        return {key: fill_workflow(value, values) for key, value in node.items()}
    if isinstance(node, list):
        return [fill_workflow(value, values) for value in node]
    if isinstance(node, str):
        whole = PLACEHOLDER_RE.fullmatch(node)
        if whole and whole.group(1) in values:
            return values[whole.group(1)]
        return PLACEHOLDER_RE.sub(
            lambda m: str(values[m.group(1)]) if m.group(1) in values else m.group(0), node
        )
    return node


# Known ComfyUI failure causes -> Arabic explanation with the fix.
FAILURE_HINTS = [
    (("outofmemory", "out of memory", "allocation on device"),
     "نفدت ذاكرة كرت الشاشة (VRAM). جرّب دقة 480p ومدة 3 ثوانٍ، أو أغلق البرامج الأخرى، أو استخدم نموذجًا أصغر."),
    (("header too small", "safetensorerror", "incomplete metadata", "invalid load key", "unexpected eof", "deserializing header"),
     "أحد ملفات النموذج تالف أو لم يكتمل تنزيله. احذف الملف الناقص من مجلد ComfyUI/models ثم أعد التنزيل "
     "(install-windows.bat أو scripts/download_models.py)."),
    (("torch not compiled with cuda", "no cuda gpus are available", "cuda driver version is insufficient",
      "found no nvidia driver"),
     "PyTorch لا يرى كرت الشاشة. حدّث تعريف NVIDIA، ثم أعد تثبيت PyTorch بدعم CUDA داخل بيئة ComfyUI: "
     "pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128"),
    (("no module named",),
     "مكتبة ناقصة في بيئة ComfyUI. نفّذ داخل مجلد ComfyUI: pip install -r requirements.txt"),
    (("expected all tensors to be on the same device", "cudnn", "cublas"),
     "خطأ في كرت الشاشة أثناء الحساب. حدّث تعريف NVIDIA وأعد تشغيل ComfyUI."),
]


def explain_failure(raw: str) -> str:
    """Arabic, user-facing reason for a ComfyUI execution error, including the technical cause."""
    lowered = raw.lower()
    for needles, message in FAILURE_HINTS:
        if any(n in lowered.replace(" ", "") if " " not in n else n in lowered for n in needles):
            return message
    cause = ""
    match = re.search(r'"exception_message":\s*"((?:[^"\\]|\\.)*)"', raw)
    if match:
        cause = match.group(1).encode().decode("unicode_escape", errors="ignore").strip().splitlines()[0][:200]
    node = re.search(r'"node_type":\s*"([^"]+)"', raw)
    if cause:
        where = f" (العقدة {node.group(1)})" if node else ""
        return f"فشل محرك الذكاء الاصطناعي أثناء التوليد{where}. السبب: {cause}"
    return "فشل محرك الذكاء الاصطناعي أثناء التوليد. راجع نافذة ComfyUI لمعرفة السبب."


def combo_options(spec) -> list | None:
    """Options of a COMBO input from /object_info, supporting old and new schema formats."""
    if not isinstance(spec, (list, tuple)) or not spec:
        return None
    if isinstance(spec[0], list):
        return spec[0]
    if spec[0] == "COMBO" and len(spec) > 1 and isinstance(spec[1], dict):
        return spec[1].get("options")
    return None


def find_missing(workflow: dict, object_info: dict) -> list[dict]:
    """Nodes that ComfyUI does not know, and model files that are not installed."""
    missing: list[dict] = []
    for node in workflow.values():
        if not isinstance(node, dict) or "class_type" not in node:
            continue
        class_type = node["class_type"]
        info = object_info.get(class_type)
        if info is None:
            missing.append({"kind": "node", "name": class_type})
            continue
        specs = {**info.get("input", {}).get("required", {}), **info.get("input", {}).get("optional", {})}
        for key, value in node.get("inputs", {}).items():
            if not isinstance(value, str) or PLACEHOLDER_RE.search(value):
                continue
            options = combo_options(specs.get(key))
            if options is not None and value not in options:
                folder = LOADER_FOLDERS.get(class_type)
                missing.append({"kind": "file" if folder else "value", "name": value,
                                "folder": folder, "node": class_type, "input": key})
    return missing


class ComfyUIProvider(VideoProvider):
    name = "comfyui"
    is_mock = False

    def __init__(self, settings, ffmpeg_path: str | None, transport: httpx.BaseTransport | None = None,
                 poll_interval: float = 2.0, use_websocket: bool = True):
        self.settings = settings
        self.ffmpeg_path = ffmpeg_path
        self.transport = transport
        self.poll_interval = poll_interval
        self.use_websocket = use_websocket
        self._cache: dict[str, tuple[float, object]] = {}
        self._cache_lock = threading.Lock()

    # -- helpers ---------------------------------------------------------
    def _client(self, timeout: float = 30) -> httpx.Client:
        return httpx.Client(base_url=self.settings.comfyui_url, timeout=timeout, transport=self.transport)

    def _cached(self, key: str, ttl: float, loader):
        now = time.monotonic()
        with self._cache_lock:
            hit = self._cache.get(key)
            if hit and now - hit[0] < ttl:
                return hit[1]
        value = loader()
        with self._cache_lock:
            self._cache[key] = (now, value)
        return value

    def invalidate_cache(self) -> None:
        with self._cache_lock:
            self._cache.clear()

    def _system_stats(self) -> dict | None:
        def load():
            try:
                with self._client(timeout=3) as client:
                    response = client.get("/system_stats")
                    response.raise_for_status()
                    return response.json()
            except (httpx.HTTPError, ValueError):
                return None
        return self._cached("system_stats", 5, load)

    def _object_info(self) -> dict | None:
        def load():
            try:
                with self._client(timeout=20) as client:
                    response = client.get("/object_info")
                    response.raise_for_status()
                    return response.json()
            except (httpx.HTTPError, ValueError):
                return None
        return self._cached("object_info", 20, load)

    def workflow_path(self, filename: str) -> Path:
        return self.settings.workflows_dir / Path(filename).name

    def load_workflow(self, path: Path) -> dict:
        try:
            workflow = json.loads(path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise GenerationError(f"ملف سير العمل {path.name} غير موجود في مجلد workflows.") from exc
        except json.JSONDecodeError as exc:
            raise GenerationError(f"تعذّرت قراءة ملف سير العمل {path.name}: الملف ليس JSON صالحًا.") from exc
        if not isinstance(workflow, dict) or "nodes" in workflow or "links" in workflow:
            raise GenerationError(
                f"ملف سير العمل {path.name} محفوظ بصيغة الواجهة وليس بصيغة API. "
                "في ComfyUI فعّل Dev mode ثم استخدم Export (API)."
            )
        workflow.pop("_comment", None)
        return workflow

    @staticmethod
    def gpu_info(stats: dict | None) -> dict:
        devices = (stats or {}).get("devices") or []
        gpus = [d for d in devices if str(d.get("type", "")).lower() not in {"cpu", ""}]
        best = max(gpus, key=lambda d: d.get("vram_total") or 0) if gpus else None
        return {
            "has_gpu": bool(gpus),
            "name": (best or {}).get("name") or (devices[0].get("name") if devices else None),
            "type": (best or {}).get("type") or (devices[0].get("type") if devices else None),
            "vram_gb": round((best or {}).get("vram_total", 0) / 1024**3, 1) if best else 0,
        }

    # -- VideoProvider ---------------------------------------------------
    def status(self) -> ProviderStatus:
        s = self.settings
        details = {"url": s.comfyui_url}
        if not s.allow_remote_comfyui and not is_local_url(s.comfyui_url):
            return ProviderStatus(
                self.name, False,
                "عنوان ComfyUI ليس محليًا. لحماية خصوصيتك لا تُرسل الصور إلى خوادم خارجية "
                "إلا إذا فعّلت ALLOW_REMOTE_COMFYUI=true.",
                setup_steps=setup_steps(s), details=details,
            )
        stats = self._system_stats()
        if stats is None:
            return ProviderStatus(
                self.name, False,
                "محرك الذكاء الاصطناعي (ComfyUI) غير متصل. لم يتم تثبيته أو تشغيله بعد على جهاز فيه كرت شاشة.",
                setup_steps=setup_steps(s), details=details,
            )
        gpu = self.gpu_info(stats)
        details.update({"comfyui_version": stats.get("system", {}).get("comfyui_version"), "gpu": gpu})
        if not gpu["has_gpu"] and not s.allow_cpu_generation:
            return ProviderStatus(
                self.name, False,
                "ComfyUI يعمل على المعالج (CPU) فقط بدون كرت شاشة. توليد الفيديو هكذا يستغرق ساعات، "
                "لذلك تم إيقافه. شغّل ComfyUI على جهاز فيه كرت شاشة NVIDIA.",
                setup_steps=setup_steps(s), details=details,
            )
        if not self.ffmpeg_path:
            return ProviderStatus(self.name, False, "FFmpeg غير متوفر لتحويل الناتج إلى MP4.",
                                  setup_steps=["pip install imageio-ffmpeg أو ثبّت FFmpeg"], details=details)
        return ProviderStatus(self.name, True, "محرك الذكاء الاصطناعي متصل وجاهز.", details=details)

    def model_status(self, model) -> ModelAvailability:
        engine = self.status()
        if not engine.available:
            modes = {mode: {"available": False, "missing": []} for mode in model.modes}
            return ModelAvailability(False, engine.message, modes, engine.setup_steps)
        info = self._object_info()
        if info is None:
            modes = {mode: {"available": False, "missing": []} for mode in model.modes}
            return ModelAvailability(False, "تعذّرت قراءة قائمة العُقد من ComfyUI.", modes, engine.setup_steps)

        modes: dict[str, dict] = {}
        for mode in model.modes:
            path = self.workflow_path(model.workflows[mode])
            try:
                missing = find_missing(self.load_workflow(path), info)
            except GenerationError as exc:
                missing = [{"kind": "workflow", "name": path.name, "error": exc.message}]
            modes[mode] = {"available": not missing, "missing": missing}

        if any(m["available"] for m in modes.values()):
            return ModelAvailability(True, "النموذج مثبت وجاهز.", modes)
        missing_files = sorted({m["name"] for mode in modes.values() for m in mode["missing"] if m["kind"] == "file"})
        missing_nodes = sorted({m["name"] for mode in modes.values() for m in mode["missing"] if m["kind"] == "node"})
        if missing_nodes:
            message = "ComfyUI يحتاج تحديثًا: العُقد التالية غير موجودة: " + "، ".join(missing_nodes)
        else:
            message = "ملفات النموذج غير مثبتة: " + "، ".join(missing_files)
        steps = [
            f"نزّل ملفات النموذج بالأمر: python scripts/download_models.py --model {model.id} --comfyui <مسار ComfyUI>",
            "أو نزّلها يدويًا من الروابط الظاهرة وضعها في مجلدات ComfyUI/models المذكورة.",
            "أعد تشغيل ComfyUI ثم أعد تحميل الصفحة.",
        ]
        if missing_nodes:
            steps.insert(0, "حدّث ComfyUI إلى أحدث إصدار (git pull ثم pip install -r requirements.txt).")
        return ModelAvailability(False, message, modes, steps)

    def generate(self, request: GenerationRequest, progress: ProgressCallback,
                 should_cancel: CancelCheck = lambda: False) -> None:
        status = self.status()
        if not status.available:
            raise ProviderUnavailable(status.message, status.setup_steps)
        workflow_file = request.model.workflows.get(request.mode)
        if not workflow_file:
            raise GenerationError("هذا النموذج لا يدعم وضع التوليد المطلوب.")
        workflow = self.load_workflow(self.workflow_path(workflow_file))

        progress(0.02, "جارٍ تجهيز الطلب لمحرك الذكاء الاصطناعي...")
        with self._client(timeout=60) as client:
            names = [self._upload_image(client, path) for path in request.image_paths]
            values = {
                "IMAGE_1": names[0] if names else "",
                "IMAGE_2": names[-1] if names else "",
                "PROMPT": f"{request.prompt.strip()}. {MOTION_PROMPTS.get(request.motion, '')}".strip(),
                "NEGATIVE_PROMPT": request.negative_prompt.strip() or DEFAULT_NEGATIVE_PROMPT,
                "WIDTH": request.width,
                "HEIGHT": request.height,
                "FRAMES": request.frames,
                "FPS": request.model.fps,
                "SEED": request.seed,
                "STEPS": request.model.steps,
                "DURATION": request.duration,
                "MOTION": MOTION_VALUES.get(request.motion, 0.6),
                "FILENAME_PREFIX": f"vesion/{request.job_id}",
            }
            client_id = uuid.uuid4().hex
            watcher = _ProgressWatcher(self.settings.comfyui_url, client_id) if self.use_websocket else None
            if watcher:
                watcher.start()
            try:
                prompt_id = self._queue_prompt(client, fill_workflow(workflow, values), client_id)
                progress(0.05, "الطلب في قائمة انتظار محرك الذكاء الاصطناعي...")
                outputs = self._wait_for_outputs(client, prompt_id, request, progress, should_cancel, watcher)
            finally:
                if watcher:
                    watcher.stop()
            progress(0.95, "جارٍ تجهيز ملف الفيديو MP4...")
            self._download_and_convert(client, outputs, request)
        progress(1.0, "اكتمل توليد الفيديو.")

    # -- ComfyUI API calls ----------------------------------------------
    def _upload_image(self, client: httpx.Client, path: Path) -> str:
        name = f"vesion_{uuid.uuid4().hex}.png"
        try:
            with path.open("rb") as fh:
                response = client.post("/upload/image", files={"image": (name, fh, "image/png")},
                                       data={"overwrite": "true", "type": "input"})
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError, OSError) as exc:
            raise GenerationError("تعذّر إرسال الصورة إلى محرك الذكاء الاصطناعي.", str(exc)) from exc
        subfolder = data.get("subfolder") or ""
        return f"{subfolder}/{data['name']}" if subfolder else data["name"]

    def _queue_prompt(self, client: httpx.Client, workflow: dict, client_id: str) -> str:
        try:
            response = client.post("/prompt", json={"prompt": workflow, "client_id": client_id})
        except httpx.HTTPError as exc:
            raise GenerationError("تعذّر الاتصال بمحرك الذكاء الاصطناعي لإرسال الطلب.", str(exc)) from exc
        if response.status_code >= 400:
            details = response.text[:3000]
            hint = ""
            if "value_not_in_list" in details or "not found" in details.lower():
                hint = " تأكد من تنزيل ملفات النموذج بالأسماء المطلوبة ومن تحديث ComfyUI."
            raise GenerationError("رفض ComfyUI سير العمل." + hint, details)
        data = response.json()
        if data.get("node_errors"):
            raise GenerationError("سير العمل يحتوي على أخطاء في العُقد.", json.dumps(data["node_errors"])[:3000])
        return data["prompt_id"]

    def cancel_prompt(self, client: httpx.Client, prompt_id: str) -> None:
        try:
            client.post("/queue", json={"delete": [prompt_id]})
            queue = client.get("/queue").json()
            running = [item[1] for item in queue.get("queue_running", []) if len(item) > 1]
            if prompt_id in running:
                client.post("/interrupt", json={"prompt_id": prompt_id})
        except (httpx.HTTPError, ValueError):
            pass

    def _queue_position(self, client: httpx.Client, prompt_id: str) -> int | None:
        try:
            queue = client.get("/queue").json()
        except (httpx.HTTPError, ValueError):
            return None
        pending = [item[1] for item in queue.get("queue_pending", []) if len(item) > 1]
        if prompt_id in pending:
            return pending.index(prompt_id) + 1
        return 0

    def _wait_for_outputs(self, client, prompt_id, request, progress, should_cancel, watcher) -> dict:
        started = time.monotonic()
        expected = max(30, request.model.expected_seconds * (request.duration / 5))
        last_history_check = 0.0
        while True:
            elapsed = time.monotonic() - started
            if should_cancel():
                self.cancel_prompt(client, prompt_id)
                raise GenerationCancelled()
            if elapsed > self.settings.comfyui_timeout_seconds:
                self.cancel_prompt(client, prompt_id)
                raise GenerationError("انتهت مهلة انتظار محرك الذكاء الاصطناعي. جرّب مدة أقصر أو دقة أقل.")

            if watcher and watcher.error:
                self._check_history(client, prompt_id)  # raises with the full history message if available
                raise GenerationError(explain_failure(watcher.error), watcher.error)
            if watcher and watcher.interrupted:
                raise GenerationCancelled()

            now = time.monotonic()
            done = watcher is not None and watcher.finished
            if done or now - last_history_check >= (5 if watcher and watcher.connected else self.poll_interval):
                last_history_check = now
                outputs = self._check_history(client, prompt_id)
                if outputs is not None:
                    return outputs

            if watcher and watcher.connected and watcher.started:
                fraction, message = watcher.progress()
                progress(fraction, message)
            elif watcher and watcher.connected:
                position = self._queue_position(client, prompt_id) if int(elapsed) % 5 == 0 else None
                if position:
                    progress(0.05, f"في قائمة الانتظار (الترتيب {position})...")
            else:
                # No WebSocket: time-based estimate, ComfyUI's HTTP API has no per-step progress.
                fraction = 0.05 + 0.85 * (1 - 1 / (1 + elapsed / expected))
                progress(fraction, f"يتم توليد الفيديو بالذكاء الاصطناعي... ({int(elapsed)} ثانية)")
            time.sleep(0.5 if watcher and watcher.connected else self.poll_interval)

    def _check_history(self, client, prompt_id) -> dict | None:
        try:
            response = client.get(f"/history/{prompt_id}")
            response.raise_for_status()
            history = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise GenerationError("انقطع الاتصال بمحرك الذكاء الاصطناعي أثناء التوليد.", str(exc)) from exc
        entry = history.get(prompt_id)
        if not entry:
            return None
        status = entry.get("status", {})
        if status.get("status_str") == "error":
            messages = json.dumps(status.get("messages", []), ensure_ascii=False)[:3000]
            raise GenerationError(explain_failure(messages), messages)
        if status.get("completed", True) and entry.get("outputs"):
            return entry["outputs"]
        if status.get("completed") and not entry.get("outputs"):
            raise GenerationError("انتهى التوليد بدون ناتج. تأكد أن سير العمل يحتوي على عقدة حفظ (Save).")
        return None

    def _download(self, client: httpx.Client, item: dict, dst: Path) -> Path:
        params = {"filename": item["filename"], "subfolder": item.get("subfolder", ""), "type": item.get("type", "output")}
        try:
            response = client.get("/view", params=params)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise GenerationError("تعذّر تنزيل الناتج من محرك الذكاء الاصطناعي.", str(exc)) from exc
        dst.write_bytes(response.content)
        return dst

    def _download_and_convert(self, client: httpx.Client, outputs: dict, request: GenerationRequest) -> None:
        videos: list[dict] = []
        frames: list[dict] = []
        for node_output in outputs.values():
            for key in ("videos", "gifs", "video", "animated_images"):
                videos += [i for i in node_output.get(key, []) if isinstance(i, dict) and "filename" in i]
            for item in node_output.get("images", []):
                if not isinstance(item, dict) or "filename" not in item:
                    continue
                suffix = Path(item["filename"]).suffix.lower()
                (videos if suffix in VIDEO_EXTENSIONS else frames).append(item)
        request.work_dir.mkdir(parents=True, exist_ok=True)
        try:
            if videos:
                item = videos[0]
                src = self._download(client, item, request.work_dir / f"comfy_output{Path(item['filename']).suffix.lower()}")
                convert_to_mp4(self.ffmpeg_path, src, request.output_path, request.model.fps)
            elif frames:
                paths = [
                    self._download(client, item, request.work_dir / f"frame_{i:05d}{Path(item['filename']).suffix.lower()}")
                    for i, item in enumerate(frames)
                ]
                frames_to_mp4(self.ffmpeg_path, paths, request.model.fps, request.output_path)
            else:
                raise GenerationError("لم يُرجع محرك الذكاء الاصطناعي أي فيديو. تأكد أن سير العمل يحتوي على عقدة حفظ.")
        except FFmpegError as exc:
            raise GenerationError("فشل تحويل الناتج إلى MP4.", str(exc)) from exc


class _ProgressWatcher:
    """Listens to ComfyUI's WebSocket for real per-step sampler progress."""

    def __init__(self, base_url: str, client_id: str):
        parsed = urlparse(base_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        self.url = f"{scheme}://{parsed.netloc}{parsed.path.rstrip('/')}/ws?clientId={client_id}"
        self.connected = False
        self.started = False
        self.finished = False
        self.interrupted = False
        self.error: str | None = None
        self._value = 0
        self._max = 0
        self._decoding = False
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name="comfy-ws")
        self._lock = threading.Lock()

    def start(self) -> None:
        self._thread.start()
        # Give the socket a moment to connect before the prompt is queued.
        for _ in range(20):
            if self.connected or not self._thread.is_alive():
                break
            time.sleep(0.05)

    def stop(self) -> None:
        self._stop.set()

    def progress(self) -> tuple[float, str]:
        with self._lock:
            if self._max:
                fraction = 0.1 + 0.8 * (self._value / self._max)
                if self._decoding and self._value >= self._max:
                    return 0.92, "جارٍ تحويل الإطارات إلى فيديو..."
                return fraction, f"يتم توليد الفيديو بالذكاء الاصطناعي: الخطوة {self._value} من {self._max}"
            return 0.08, "جارٍ تحميل النموذج في ذاكرة كرت الشاشة..."

    def _run(self) -> None:
        try:
            from websockets.sync.client import connect
        except ImportError:
            return
        try:
            with connect(self.url, open_timeout=3, max_size=None) as ws:
                self.connected = True
                while not self._stop.is_set():
                    try:
                        message = ws.recv(timeout=0.5)
                    except TimeoutError:
                        continue
                    if isinstance(message, bytes):
                        continue  # preview images
                    self._handle(json.loads(message))
        except Exception:  # noqa: BLE001 - fall back to HTTP polling
            self.connected = False

    def _handle(self, event: dict) -> None:
        kind = event.get("type")
        data = event.get("data") or {}
        with self._lock:
            if kind == "execution_start":
                self.started = True
            elif kind == "progress":
                self.started = True
                value, maximum = int(data.get("value", 0)), int(data.get("max", 0))
                # Several nodes report progress; keep the largest step-based loop (the sampler).
                if maximum >= self._max or value > self._value:
                    self._value, self._max = value, maximum
            elif kind == "executing":
                if data.get("node") is None and self.started:
                    self.finished = True
                elif self._max and self._value >= self._max:
                    self._decoding = True
            elif kind == "execution_success":
                self.finished = True
            elif kind == "execution_error":
                self.error = json.dumps(
                    {k: data.get(k) for k in ("node_type", "exception_type", "exception_message")}
                )[:3000]
            elif kind == "execution_interrupted":
                self.interrupted = True
