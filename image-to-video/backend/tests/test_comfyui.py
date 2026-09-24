"""Tests the ComfyUI provider against a fake in-process ComfyUI API."""

import io
import json

import httpx
import imageio_ffmpeg
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import create_app
from app.providers.comfyui import ComfyUIProvider, fill_workflow, frame_count, is_local_url
from conftest import upload, wait_for_job


def animated_webp(frames=6, size=(96, 160)) -> bytes:
    images = [Image.new("RGB", size, (i * 40 % 255, 100, 150)) for i in range(frames)]
    buffer = io.BytesIO()
    images[0].save(buffer, format="WEBP", save_all=True, append_images=images[1:], duration=62, loop=0)
    return buffer.getvalue()


class FakeComfyUI:
    def __init__(self, fail_prompt: bool = False, pending_polls: int = 1):
        self.fail_prompt = fail_prompt
        self.pending_polls = pending_polls
        self.uploaded: list[str] = []
        self.queued_workflow: dict | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/system_stats":
            return httpx.Response(200, json={"system": {"comfyui_version": "0.3.test"}})
        if path == "/upload/image":
            name = f"upload_{len(self.uploaded)}.png"
            self.uploaded.append(name)
            return httpx.Response(200, json={"name": name, "subfolder": "", "type": "input"})
        if path == "/prompt":
            if self.fail_prompt:
                return httpx.Response(400, json={"error": {"type": "value_not_in_list",
                                                           "message": "unet_name not in list"}})
            self.queued_workflow = json.loads(request.content)["prompt"]
            return httpx.Response(200, json={"prompt_id": "pid-1", "number": 1, "node_errors": {}})
        if path == "/history/pid-1":
            if self.pending_polls > 0:
                self.pending_polls -= 1
                return httpx.Response(200, json={})
            return httpx.Response(200, json={"pid-1": {
                "status": {"status_str": "success", "completed": True},
                "outputs": {"13": {"images": [{"filename": "out_00001_.webp", "subfolder": "image2video",
                                               "type": "output"}], "animated": [True]}},
            }})
        if path == "/view":
            assert request.url.params["filename"] == "out_00001_.webp"
            return httpx.Response(200, content=animated_webp())
        return httpx.Response(404)


def make_client(settings, fake: FakeComfyUI) -> TestClient:
    settings.comfyui_url = "http://127.0.0.1:8188"
    app = create_app(settings, comfy_transport=httpx.MockTransport(fake.handler))
    app.state.providers["comfyui"].poll_interval = 0.01
    return TestClient(app)


def test_fill_workflow_keeps_types_and_substitutes_text():
    workflow = {"a": {"inputs": {"w": "{{WIDTH}}", "t": "prefix {{PROMPT}}", "keep": "{{UNKNOWN}}", "l": ["1", 0]}}}
    filled = fill_workflow(workflow, {"WIDTH": 480, "PROMPT": "hi"})
    assert filled["a"]["inputs"] == {"w": 480, "t": "prefix hi", "keep": "{{UNKNOWN}}", "l": ["1", 0]}


def test_frame_count_is_4n_plus_1():
    assert frame_count(3) == 49 and frame_count(5) == 81 and frame_count(8) == 129


@pytest.mark.parametrize("url,expected", [
    ("http://127.0.0.1:8188", True), ("http://localhost:8188", True),
    ("http://192.168.1.10:8188", True), ("http://host.docker.internal:8188", True),
    ("https://example.com", False), ("http://8.8.8.8:8188", False),
])
def test_is_local_url(url, expected):
    assert is_local_url(url) is expected


def test_remote_comfyui_refused_by_default(settings):
    settings.comfyui_url = "https://some-cloud-service.example.com"
    status = ComfyUIProvider(settings, "ffmpeg").status()
    assert status.available is False
    assert "ALLOW_REMOTE_COMFYUI" in status.message


def test_ui_format_workflow_is_rejected_with_clear_message(settings):
    (settings.workflows_dir / "ui.json").write_text(json.dumps({"nodes": [], "links": []}))
    provider = ComfyUIProvider(settings, "ffmpeg")
    with pytest.raises(Exception) as err:
        provider._load_workflow(settings.workflows_dir / "ui.json")
    assert "API" in err.value.message


def test_full_comfyui_generation_flow(settings):
    fake = FakeComfyUI()
    with make_client(settings, fake) as client:
        assert client.get("/api/health").json()["providers"]["comfyui"]["available"] is True
        file_id = upload(client).json()["file_id"]
        response = client.post("/api/generate", json={
            "image_ids": [file_id], "prompt": "زفاف", "duration": 5, "aspect_ratio": "9:16", "motion": "low",
        })
        body = response.json()
        assert body["provider"] == "comfyui" and body["is_mock"] is False and body["notice"] is None
        job = wait_for_job(client, body["job_id"])
        assert job["status"] == "completed", job

    inputs = {node_id: node["inputs"] for node_id, node in fake.queued_workflow.items()}
    assert inputs["5"]["image"] == "upload_0.png"
    assert inputs["9"]["width"] == 480 and inputs["9"]["height"] == 832 and inputs["9"]["length"] == 81
    assert inputs["6"]["text"].startswith("زفاف")
    assert isinstance(inputs["11"]["seed"], int)
    assert "_comment" not in fake.queued_workflow

    video = settings.output_dir / f"{body['job_id']}.mp4"
    frames, _ = imageio_ffmpeg.count_frames_and_secs(str(video))
    assert frames == 6


def test_two_images_use_first_last_frame_workflow(settings):
    fake = FakeComfyUI(pending_polls=0)
    with make_client(settings, fake) as client:
        ids = [upload(client).json()["file_id"] for _ in range(2)]
        job_id = client.post("/api/generate", json={"image_ids": ids, "prompt": "x"}).json()["job_id"]
        assert wait_for_job(client, job_id)["status"] == "completed"
    assert fake.queued_workflow["9"]["class_type"] == "WanFirstLastFrameToVideo"
    assert fake.queued_workflow["14"]["inputs"]["image"] == "upload_1.png"


def test_missing_model_error_is_reported_in_arabic(settings):
    fake = FakeComfyUI(fail_prompt=True)
    with make_client(settings, fake) as client:
        file_id = upload(client).json()["file_id"]
        job_id = client.post("/api/generate", json={"image_ids": [file_id], "prompt": "x"}).json()["job_id"]
        job = wait_for_job(client, job_id)
    assert job["status"] == "failed"
    assert "رفض ComfyUI" in job["error"]
    assert "ملفات النموذج" in job["error"]
    assert "unet_name" in job["error_details"]


def test_empty_two_image_workflow_setting_falls_back_to_single_image(monkeypatch, settings):
    from app.config import load_settings

    monkeypatch.setenv("COMFYUI_WORKFLOW_TWO_IMAGES", "")
    assert load_settings().comfyui_workflow_two_images == ""

    settings.comfyui_workflow_two_images = ""
    fake = FakeComfyUI(pending_polls=0)
    with make_client(settings, fake) as client:
        ids = [upload(client).json()["file_id"] for _ in range(2)]
        job_id = client.post("/api/generate", json={"image_ids": ids, "prompt": "x"}).json()["job_id"]
        assert wait_for_job(client, job_id)["status"] == "completed"
    assert fake.queued_workflow["9"]["class_type"] == "WanImageToVideo"


def test_animated_webp_keeps_timing_of_merged_frames(tmp_path):
    from app.ffmpeg_utils import animated_image_to_mp4, find_ffmpeg

    frames = [Image.new("RGB", (64, 64), c) for c in [(255, 0, 0), (0, 255, 0)]]
    src = tmp_path / "anim.webp"
    # second frame lasts 3 frame-intervals, as libwebp produces when identical frames are merged
    frames[0].save(src, format="WEBP", save_all=True, append_images=frames[1:], duration=[62, 188], loop=0)
    dst = tmp_path / "out.mp4"
    animated_image_to_mp4(find_ffmpeg(), src, dst, default_fps=16)
    count, _ = imageio_ffmpeg.count_frames_and_secs(str(dst))
    assert count == 4
