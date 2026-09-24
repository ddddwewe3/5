"""Local ComfyUI provider (e.g. Wan2.1 image-to-video) via ComfyUI's HTTP API.

The workflow is an API-format JSON file in /workflows. String values that are exactly a
placeholder such as "{{WIDTH}}" are replaced with typed values; placeholders embedded in
longer strings are substituted as text. Supported placeholders:

  IMAGE_1, IMAGE_2, PROMPT, NEGATIVE_PROMPT, WIDTH, HEIGHT, FRAMES, FPS, SEED,
  DURATION, MOTION (0.3 / 0.6 / 0.9), FILENAME_PREFIX
"""

from __future__ import annotations

import ipaddress
import json
import re
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx

from ..ffmpeg_utils import FFmpegError, convert_to_mp4, frames_to_mp4
from .base import (
    GenerationError,
    GenerationRequest,
    ProgressCallback,
    ProviderStatus,
    ProviderUnavailable,
    VideoProvider,
)

PLACEHOLDER_RE = re.compile(r"\{\{([A-Z0-9_]+)\}\}")

# Wan2.1 480p model works best near 832x480; dimensions must be multiples of 16.
COMFY_RESOLUTIONS = {"9:16": (480, 832), "16:9": (832, 480), "1:1": (624, 624)}
COMFY_FPS = 16

MOTION_VALUES = {"low": 0.3, "medium": 0.6, "high": 0.9}
MOTION_PROMPTS = {
    "low": "subtle gentle motion, mostly static camera",
    "medium": "natural smooth motion, smooth cinematic camera movement",
    "high": "dynamic lively motion, energetic cinematic camera movement",
}
DEFAULT_NEGATIVE_PROMPT = (
    "blurry, low quality, distorted face, deformed face, extra fingers, bad hands, "
    "watermark, text, static image, jpeg artifacts, ugly, disfigured, "
    "وجه مشوه، تشويه، جودة منخفضة، ضبابي"
)

VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".gif", ".webp", ".avi"}
LOCAL_HOSTNAMES = {"localhost", "host.docker.internal", "comfyui"}


def setup_steps(settings) -> list[str]:
    return [
        "ثبّت ComfyUI (مجاني ومفتوح المصدر): https://github.com/comfyanonymous/ComfyUI",
        "نزّل ملفات نموذج Wan2.1 لتحويل الصورة إلى فيديو وضعها في مجلدات ComfyUI/models (راجع README).",
        "شغّل ComfyUI: python main.py --listen 127.0.0.1 --port 8188",
        f"ضع ملف سير العمل بصيغة API داخل مجلد workflows باسم: {settings.comfyui_workflow}",
        f"تأكد أن COMFYUI_URL في ملف .env يساوي عنوان ComfyUI (الحالي: {settings.comfyui_url})",
        "أعد تحميل هذه الصفحة. حتى ذلك الحين يمكنك استخدام وضع المعاينة (ليس ذكاءً اصطناعيًا).",
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


def frame_count(duration: int, fps: int = COMFY_FPS) -> int:
    """Wan expects 4n+1 frames."""
    return (round(duration * fps / 4) * 4) + 1


class ComfyUIProvider(VideoProvider):
    name = "comfyui"
    is_mock = False

    def __init__(self, settings, ffmpeg_path: str | None, transport: httpx.BaseTransport | None = None,
                 poll_interval: float = 2.0):
        self.settings = settings
        self.ffmpeg_path = ffmpeg_path
        self.transport = transport
        self.poll_interval = poll_interval

    # -- helpers ---------------------------------------------------------
    def _client(self, timeout: float = 30) -> httpx.Client:
        return httpx.Client(base_url=self.settings.comfyui_url, timeout=timeout, transport=self.transport)

    def _workflow_path(self, two_images: bool) -> Path | None:
        names = []
        if two_images and self.settings.comfyui_workflow_two_images:
            names.append(self.settings.comfyui_workflow_two_images)
        names.append(self.settings.comfyui_workflow)
        for name in names:
            path = (self.settings.workflows_dir / Path(name).name)
            if path.is_file():
                return path
        return None

    def _load_workflow(self, path: Path) -> dict:
        try:
            workflow = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise GenerationError(f"تعذّرت قراءة ملف سير العمل {path.name}: الملف ليس JSON صالحًا.") from exc
        if not isinstance(workflow, dict) or "nodes" in workflow or "links" in workflow:
            raise GenerationError(
                f"ملف سير العمل {path.name} محفوظ بصيغة الواجهة وليس بصيغة API. "
                "في ComfyUI فعّل Dev mode ثم استخدم Save (API Format)."
            )
        workflow.pop("_comment", None)
        return workflow

    # -- VideoProvider ---------------------------------------------------
    def status(self) -> ProviderStatus:
        s = self.settings
        details = {"url": s.comfyui_url, "workflow": s.comfyui_workflow}
        if not s.allow_remote_comfyui and not is_local_url(s.comfyui_url):
            return ProviderStatus(
                self.name, False,
                "عنوان ComfyUI ليس محليًا. لحماية خصوصيتك لا تُرسل الصور إلى خوادم خارجية "
                "إلا إذا فعّلت ALLOW_REMOTE_COMFYUI=true.",
                setup_steps=setup_steps(s), details=details,
            )
        workflow_found = self._workflow_path(False) is not None
        details["workflow_found"] = workflow_found
        details["two_image_workflow_found"] = (s.workflows_dir / Path(s.comfyui_workflow_two_images).name).is_file()
        try:
            with self._client(timeout=3) as client:
                response = client.get("/system_stats")
                response.raise_for_status()
                stats = response.json()
        except (httpx.HTTPError, ValueError):
            return ProviderStatus(
                self.name, False,
                f"ComfyUI غير متاح: النموذج المحلي غير مثبت أو غير مشغّل على العنوان {s.comfyui_url}",
                setup_steps=setup_steps(s), details=details,
            )
        details["comfyui_version"] = stats.get("system", {}).get("comfyui_version")
        if not workflow_found:
            return ProviderStatus(
                self.name, False,
                f"ComfyUI يعمل، لكن ملف سير العمل {s.comfyui_workflow} غير موجود في مجلد workflows.",
                setup_steps=setup_steps(s), details=details,
            )
        if not self.ffmpeg_path:
            return ProviderStatus(
                self.name, False, "FFmpeg غير متوفر لتحويل الناتج إلى MP4.",
                setup_steps=["pip install imageio-ffmpeg أو ثبّت FFmpeg"], details=details,
            )
        return ProviderStatus(self.name, True, "ComfyUI متصل وجاهز.", details=details)

    def generate(self, request: GenerationRequest, progress: ProgressCallback) -> None:
        status = self.status()
        if not status.available:
            raise ProviderUnavailable(status.message, status.setup_steps)

        two_images = len(request.image_paths) > 1
        workflow_path = self._workflow_path(two_images)
        assert workflow_path is not None
        workflow = self._load_workflow(workflow_path)
        width, height = COMFY_RESOLUTIONS[request.aspect_ratio]

        progress(0.02, "جارٍ رفع الصور إلى ComfyUI المحلي...")
        with self._client(timeout=60) as client:
            names = [self._upload_image(client, path) for path in request.image_paths]
            prefix = f"image2video/{request.job_id}"
            values = {
                "IMAGE_1": names[0],
                "IMAGE_2": names[-1],
                "PROMPT": f"{request.prompt.strip()}. {MOTION_PROMPTS[request.motion]}",
                "NEGATIVE_PROMPT": request.negative_prompt or DEFAULT_NEGATIVE_PROMPT,
                "WIDTH": width,
                "HEIGHT": height,
                "FRAMES": frame_count(request.duration),
                "FPS": COMFY_FPS,
                "SEED": request.seed,
                "DURATION": request.duration,
                "MOTION": MOTION_VALUES[request.motion],
                "FILENAME_PREFIX": prefix,
            }
            prompt_id = self._queue_prompt(client, fill_workflow(workflow, values))
            progress(0.05, "تمت إضافة المهمة إلى قائمة ComfyUI...")
            outputs = self._wait_for_outputs(client, prompt_id, progress)
            progress(0.93, "جارٍ تنزيل الناتج وتحويله إلى MP4...")
            self._download_and_convert(client, outputs, request)
        progress(1.0, "اكتمل توليد الفيديو.")

    # -- ComfyUI API calls ----------------------------------------------
    def _upload_image(self, client: httpx.Client, path: Path) -> str:
        name = f"i2v_{uuid.uuid4().hex}.png"
        try:
            with path.open("rb") as fh:
                response = client.post(
                    "/upload/image",
                    files={"image": (name, fh, "image/png")},
                    data={"overwrite": "true", "type": "input"},
                )
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise GenerationError("تعذّر رفع الصورة إلى ComfyUI المحلي.", str(exc)) from exc
        subfolder = data.get("subfolder") or ""
        return f"{subfolder}/{data['name']}" if subfolder else data["name"]

    def _queue_prompt(self, client: httpx.Client, workflow: dict) -> str:
        try:
            response = client.post("/prompt", json={"prompt": workflow, "client_id": uuid.uuid4().hex})
        except httpx.HTTPError as exc:
            raise GenerationError("تعذّر الاتصال بـ ComfyUI لإرسال سير العمل.", str(exc)) from exc
        if response.status_code >= 400:
            details = response.text[:3000]
            hint = ""
            if "not found" in details.lower() or "does not exist" in details.lower() or "value_not_in_list" in details:
                hint = " تأكد من تنزيل ملفات النموذج بالأسماء المطلوبة ومن تثبيت العُقد (nodes) اللازمة."
            raise GenerationError("رفض ComfyUI سير العمل." + hint, details)
        data = response.json()
        if data.get("node_errors"):
            raise GenerationError("سير العمل يحتوي على أخطاء في العُقد.", json.dumps(data["node_errors"])[:3000])
        return data["prompt_id"]

    def _wait_for_outputs(self, client: httpx.Client, prompt_id: str, progress: ProgressCallback) -> dict:
        started = time.monotonic()
        expected = max(30, self.settings.comfyui_expected_seconds)
        while True:
            elapsed = time.monotonic() - started
            if elapsed > self.settings.comfyui_timeout_seconds:
                raise GenerationError("انتهت مهلة انتظار ComfyUI. جرّب مدة أقصر أو دقة أقل.")
            try:
                response = client.get(f"/history/{prompt_id}")
                response.raise_for_status()
                history = response.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise GenerationError("انقطع الاتصال بـ ComfyUI أثناء التوليد.", str(exc)) from exc

            entry = history.get(prompt_id)
            if entry:
                status = entry.get("status", {})
                if status.get("status_str") == "error":
                    messages = json.dumps(status.get("messages", []))[:3000]
                    oom = "out of memory" in messages.lower() or "OutOfMemory" in messages
                    raise GenerationError(
                        "نفدت ذاكرة كرت الشاشة (VRAM). جرّب مدة أقصر أو نموذجًا أصغر."
                        if oom else "فشل ComfyUI أثناء توليد الفيديو.",
                        messages,
                    )
                if status.get("completed", True) and entry.get("outputs"):
                    return entry["outputs"]

            # Asymptotic estimate: ComfyUI's HTTP API does not report per-step progress.
            fraction = 0.05 + 0.85 * (1 - 1 / (1 + elapsed / expected))
            progress(fraction, f"يتم توليد الفيديو بالذكاء الاصطناعي... ({int(elapsed)} ثانية)")
            time.sleep(self.poll_interval)

    def _download(self, client: httpx.Client, item: dict, dst: Path) -> Path:
        params = {"filename": item["filename"], "subfolder": item.get("subfolder", ""), "type": item.get("type", "output")}
        try:
            response = client.get("/view", params=params)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise GenerationError("تعذّر تنزيل الناتج من ComfyUI.", str(exc)) from exc
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
                convert_to_mp4(self.ffmpeg_path, src, request.output_path, COMFY_FPS)
            elif frames:
                paths = [
                    self._download(client, item, request.work_dir / f"frame_{i:05d}{Path(item['filename']).suffix.lower()}")
                    for i, item in enumerate(frames)
                ]
                frames_to_mp4(self.ffmpeg_path, paths, COMFY_FPS, request.output_path)
            else:
                raise GenerationError("لم يُرجع ComfyUI أي فيديو. تأكد أن سير العمل يحتوي على عقدة حفظ (Save).")
        except FFmpegError as exc:
            raise GenerationError("فشل تحويل ناتج ComfyUI إلى MP4.", str(exc)) from exc
