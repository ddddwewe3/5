import io
import json
import shutil
import sys
import time
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import PROJECT_ROOT, Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.providers.comfyui import LOADER_FOLDERS  # noqa: E402

FILE_INPUTS = {"unet_name", "clip_name", "vae_name", "ckpt_name"}


def make_image_bytes(fmt: str = "PNG", size=(320, 240), color=(200, 120, 60)) -> bytes:
    """A photo-like test image with detail (a flat color would make any zoom look frozen)."""
    from PIL import ImageDraw

    img = Image.new("RGB", size, color)
    draw = ImageDraw.Draw(img)
    for i in range(0, size[0], 16):
        draw.line([(i, 0), (size[0] - i, size[1])], fill=((i * 7) % 255, 255 - color[1], (i * 3) % 255), width=3)
    draw.ellipse([size[0] // 4, size[1] // 4, size[0] * 3 // 4, size[1] * 3 // 4], outline=(255, 255, 255), width=6)
    buffer = io.BytesIO()
    img.save(buffer, format=fmt)
    return buffer.getvalue()


def animated_webp(frames=6, size=(96, 160)) -> bytes:
    images = [Image.new("RGB", size, (i * 40 % 255, 100, 150)) for i in range(frames)]
    buffer = io.BytesIO()
    images[0].save(buffer, format="WEBP", save_all=True, append_images=images[1:], duration=42, loop=0)
    return buffer.getvalue()


def frozen_webp(frames=6, size=(96, 160)) -> bytes:
    """Frames that differ imperceptibly: a still image disguised as a video."""
    images = [Image.new("RGB", size, (120, 100, 150 + (i % 2))) for i in range(frames)]
    buffer = io.BytesIO()
    images[0].save(buffer, format="WEBP", save_all=True, append_images=images[1:], duration=42, loop=0, lossless=True)
    return buffer.getvalue()


LTX_FILES = {"ltx-video-2b-v0.9.5.safetensors", "t5xxl_fp16.safetensors"}


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    workflows = tmp_path / "workflows"
    shutil.copytree(PROJECT_ROOT / "workflows", workflows)
    return Settings(
        comfyui_url="http://127.0.0.1:59999",  # nothing listens here
        upload_dir=tmp_path / "uploads",
        output_dir=tmp_path / "outputs",
        workflows_dir=workflows,
        data_dir=tmp_path / "data",
    )


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings, use_websocket=False)) as test_client:
        yield test_client


def upload(client, data: bytes | None = None, name="photo.png", mime="image/png"):
    return client.post("/api/upload", files={"file": (name, data or make_image_bytes(), mime)})


def wait_for(client, generation_id: str, timeout: float = 60, path: str = "/api/generations/") -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"{path}{generation_id}").json()
        if body["status"] in {"completed", "failed", "cancelled"}:
            return body
        time.sleep(0.1)
    raise AssertionError("generation did not finish in time")


class FakeComfyUI:
    """In-process stand-in for the ComfyUI HTTP API."""

    def __init__(self, workflows_dir: Path, installed: set[str] | None = None, gpu: bool = True,
                 fail_prompt: bool = False, history_error: str | None = None, pending_polls: int = 1,
                 never_finish: bool = False, missing_nodes: set[str] | None = None,
                 fail_first: int | None = None, log_text: str = "", frozen: bool = False):
        self.installed = installed if installed is not None else set()
        self.gpu = gpu
        self.fail_prompt = fail_prompt
        self.history_error = history_error
        self.pending_polls = pending_polls
        self.never_finish = never_finish
        self.fail_first = fail_first  # history_error only for the first N prompts (None = all)
        self.log_text = log_text
        self.folder_paths: dict = {}
        self.frozen = frozen
        self.uploaded: list[str] = []
        self.queued: list[dict] = []
        self.interrupted = False
        self.deleted_from_queue: list[str] = []
        self.object_info = self._build_object_info(workflows_dir, missing_nodes or set())

    def _build_object_info(self, workflows_dir: Path, missing_nodes: set[str]) -> dict:
        info: dict = {}
        for path in workflows_dir.glob("*_api.json"):
            for node in json.loads(path.read_text()).values():
                if not isinstance(node, dict) or node["class_type"] in missing_nodes:
                    continue
                required = info.setdefault(node["class_type"], {"input": {"required": {}}})["input"]["required"]
                for key in node["inputs"]:
                    if node["class_type"] in LOADER_FOLDERS and key in FILE_INPUTS:
                        required[key] = [sorted(self.installed)]
                    else:
                        required.setdefault(key, ["*", {}])
        return info

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/system_stats":
            device = {"name": "cuda:0 NVIDIA RTX 4090", "type": "cuda", "vram_total": 24 * 1024**3} if self.gpu \
                else {"name": "cpu", "type": "cpu", "vram_total": 0}
            return httpx.Response(200, json={"system": {"comfyui_version": "0.3.test"}, "devices": [device]})
        if path == "/object_info":
            return httpx.Response(200, json=self.object_info)
        if path == "/upload/image":
            name = f"upload_{len(self.uploaded)}.png"
            self.uploaded.append(name)
            return httpx.Response(200, json={"name": name, "subfolder": "", "type": "input"})
        if path == "/prompt":
            if self.fail_prompt:
                return httpx.Response(400, json={"error": {"type": "value_not_in_list", "message": "unet_name not in list"}})
            self.queued.append(json.loads(request.content)["prompt"])
            return httpx.Response(200, json={"prompt_id": f"pid-{len(self.queued)}", "number": 1, "node_errors": {}})
        if path == "/queue":
            if request.method == "POST":
                self.deleted_from_queue += json.loads(request.content).get("delete", [])
                return httpx.Response(200, json={})
            running = [[0, f"pid-{len(self.queued)}"]] if self.queued else []
            return httpx.Response(200, json={"queue_running": running, "queue_pending": []})
        if path == "/interrupt":
            self.interrupted = True
            return httpx.Response(200, json={})
        if path.startswith("/history/"):
            pid = path.rsplit("/", 1)[1]
            if self.never_finish or self.pending_polls > 0:
                self.pending_polls -= 1
                return httpx.Response(200, json={})
            failing = self.fail_first is None or int(pid.split("-")[1]) <= self.fail_first
            if self.history_error and failing:
                return httpx.Response(200, json={pid: {"status": {"status_str": "error", "completed": False,
                                                                   "messages": [["execution_error", {"exception_message": self.history_error}]]},
                                                        "outputs": {}}})
            return httpx.Response(200, json={pid: {
                "status": {"status_str": "success", "completed": True},
                "outputs": {"10": {"images": [{"filename": "out_00001_.webp", "subfolder": "vesion", "type": "output"}],
                                   "animated": [True]}},
            }})
        if path == "/view":
            return httpx.Response(200, content=frozen_webp() if self.frozen else animated_webp())
        if path == "/internal/folder_paths":
            return httpx.Response(200, json=self.folder_paths)
        if path == "/internal/logs":
            return httpx.Response(200, json=self.log_text)
        return httpx.Response(404)


WAN22_FILES = {"wan2.2_ti2v_5B_fp16.safetensors", "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "wan2.2_vae.safetensors"}
WAN21_FILES = {"wan2.1_i2v_480p_14B_fp8_e4m3fn.safetensors", "wan2.1_flf2v_720p_14B_fp8_e4m3fn.safetensors",
               "umt5_xxl_fp8_e4m3fn_scaled.safetensors", "wan_2.1_vae.safetensors", "clip_vision_h.safetensors"}


def comfy_client(settings, fake: FakeComfyUI, start_worker: bool = True) -> TestClient:
    settings.comfyui_url = "http://127.0.0.1:8188"
    app = create_app(settings, comfy_transport=httpx.MockTransport(fake.handler), use_websocket=False,
                     start_worker=start_worker)
    app.state.providers["comfyui"].poll_interval = 0.01
    return TestClient(app)
