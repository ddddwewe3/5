"""ComfyUI provider against a fake in-process ComfyUI API."""

import json

import imageio_ffmpeg
import pytest
from PIL import Image

from app.models_registry import load_registry
from app.providers.comfyui import ComfyUIProvider, _ProgressWatcher, fill_workflow, find_missing, is_local_url
from conftest import LTX_FILES, WAN21_FILES, WAN22_FILES, FakeComfyUI, comfy_client, upload, wait_for


def test_fill_workflow_keeps_types_and_substitutes_text():
    workflow = {"a": {"inputs": {"w": "{{WIDTH}}", "t": "prefix {{PROMPT}}", "keep": "{{UNKNOWN}}", "l": ["1", 0]}}}
    filled = fill_workflow(workflow, {"WIDTH": 480, "PROMPT": "hi"})
    assert filled["a"]["inputs"] == {"w": 480, "t": "prefix hi", "keep": "{{UNKNOWN}}", "l": ["1", 0]}


def test_frame_counts_follow_each_model(settings):
    registry = load_registry(settings.workflows_dir)
    wan22, ltx, wan21 = (registry.get(i) for i in ("wan2.2-ti2v-5b", "ltxv-2b", "wan2.1-i2v-14b"))
    assert [wan22.frame_count(d) for d in (3, 5, 8)] == [73, 121, 193]   # 4n+1 at 24 fps
    assert [ltx.frame_count(d) for d in (3, 5, 8)] == [73, 121, 193]     # 8n+1 at 24 fps
    assert all((ltx.frame_count(d) - 1) % 8 == 0 for d in (3, 5, 8))
    assert [wan21.frame_count(d) for d in (3, 5, 8)] == [49, 81, 129]   # 4n+1 at 16 fps


def test_every_workflow_file_in_the_registry_exists_and_is_api_format(settings):
    registry = load_registry(settings.workflows_dir)
    provider = ComfyUIProvider(settings, "ffmpeg")
    for model in registry.models:
        for mode, name in model.workflows.items():
            workflow = provider.load_workflow(settings.workflows_dir / name)
            assert "{{PROMPT}}" in json.dumps(workflow), (model.id, mode)
            has_image = "{{IMAGE_1}}" in json.dumps(workflow)
            assert has_image == (mode != "t2v"), (model.id, mode)


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


def test_ui_format_workflow_is_rejected(settings):
    (settings.workflows_dir / "ui.json").write_text(json.dumps({"nodes": [], "links": []}))
    with pytest.raises(Exception) as err:
        ComfyUIProvider(settings, "ffmpeg").load_workflow(settings.workflows_dir / "ui.json")
    assert "API" in err.value.message


def test_find_missing_reports_files_and_nodes():
    workflow = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "model.safetensors"}},
                "2": {"class_type": "NewNode", "inputs": {}},
                "3": {"class_type": "LoadImage", "inputs": {"image": "{{IMAGE_1}}"}}}
    info = {"UNETLoader": {"input": {"required": {"unet_name": [["other.safetensors"], {}]}}},
            "LoadImage": {"input": {"required": {"image": [["a.png"], {}]}}}}
    missing = find_missing(workflow, info)
    assert {"kind": "file", "name": "model.safetensors", "folder": "diffusion_models",
            "node": "UNETLoader", "input": "unet_name"} in missing
    assert {"kind": "node", "name": "NewNode"} in missing
    assert len(missing) == 2
    # New-style COMBO schema
    info["UNETLoader"]["input"]["required"]["unet_name"] = ["COMBO", {"options": ["model.safetensors"]}]
    info["NewNode"] = {"input": {"required": {}}}
    assert find_missing(workflow, info) == []


def test_model_availability_detects_installed_files(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES)
    with comfy_client(settings, fake) as client:
        health = client.get("/api/health").json()["engine_detail"]
        assert health["available"] is True
        assert health["details"]["gpu"] == {"has_gpu": True, "name": "cuda:0 NVIDIA RTX 4090",
                                            "type": "cuda", "vram_gb": 24.0}
        models = {m["id"]: m["availability"] for m in client.get("/api/models").json()["models"]}
    assert models["wan2.2-ti2v-5b"]["available"] is True
    assert models["wan2.2-ti2v-5b"]["modes"]["t2v"]["available"] is True
    assert models["ltxv-2b"]["available"] is False
    assert "ltx-video-2b-v0.9.5.safetensors" in models["ltxv-2b"]["message"]
    assert "download_models.py" in models["ltxv-2b"]["setup_steps"][0]


def test_missing_node_asks_to_update_comfyui(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES, missing_nodes={"Wan22ImageToVideoLatent"})
    with comfy_client(settings, fake) as client:
        model = client.get("/api/models").json()["models"][0]["availability"]
    assert model["available"] is False
    assert "Wan22ImageToVideoLatent" in model["message"]
    assert "حدّث ComfyUI" in model["setup_steps"][0]


def test_cpu_only_comfyui_is_detected_and_refused(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES, gpu=False)
    with comfy_client(settings, fake) as client:
        engine = client.get("/api/health").json()["engine_detail"]
        assert engine["available"] is False
        assert "CPU" in engine["message"]
        assert client.post("/api/generations", json={"mode": "t2v", "prompt": "x"}).status_code == 503
    settings.allow_cpu_generation = True
    with comfy_client(settings, fake) as client:
        assert client.get("/api/health").json()["engine_detail"]["available"] is True


def test_text_to_video_full_flow(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES)
    with comfy_client(settings, fake) as client:
        response = client.post("/api/generations", json={
            "mode": "t2v", "prompt": "a lighthouse in a storm", "negative_prompt": "blurry",
            "duration": 5, "aspect_ratio": "16:9", "resolution": "720p", "motion": "high",
        })
        assert response.status_code == 202, response.text
        generation = response.json()["generations"][0]
        assert generation["model"] == "wan2.2-ti2v-5b" and generation["is_demo"] is False
        assert generation["notice"] is None
        done = wait_for(client, generation["id"])
        assert done["status"] == "completed", done
        assert done["thumbnail_url"] and done["video_url"]

    workflow = fake.queued[0]
    assert "_comment" not in workflow
    latent = workflow["6"]["inputs"]
    assert (latent["width"], latent["height"], latent["length"]) == (1280, 704, 121)
    assert "start_image" not in latent
    assert workflow["4"]["inputs"]["text"].startswith("a lighthouse in a storm")
    assert "energetic" in workflow["4"]["inputs"]["text"]
    assert workflow["5"]["inputs"]["text"] == "blurry"
    assert workflow["10"]["inputs"]["fps"] == 24
    assert isinstance(workflow["8"]["inputs"]["seed"], int)
    assert fake.uploaded == []
    frames, _ = imageio_ffmpeg.count_frames_and_secs(str(settings.output_dir / generation["id"] / "video.mp4"))
    assert frames == 6


def test_image_to_video_and_variations(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES, pending_polls=0)
    with comfy_client(settings, fake) as client:
        file_id = upload(client).json()["file_id"]
        response = client.post("/api/generations", json={
            "mode": "i2v", "prompt": "make it move", "image_ids": [file_id], "aspect_ratio": "9:16",
            "resolution": "480p", "duration": 3, "variations": 3, "seed": 100,
        })
        generations = response.json()["generations"]
        assert len({g["batch_id"] for g in generations}) == 1
        assert [g["params"]["seed"] for g in generations] == [100, 101, 102]
        for g in generations:
            assert wait_for(client, g["id"])["status"] == "completed"
    assert len(fake.queued) == 3
    assert fake.queued[0]["11"]["inputs"]["image"] == "upload_0.png"
    assert fake.queued[0]["6"]["inputs"]["start_image"] == ["11", 0]
    assert (fake.queued[0]["6"]["inputs"]["width"], fake.queued[0]["6"]["inputs"]["height"]) == (480, 832)


def test_first_last_frame_uses_wan21(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN21_FILES, pending_polls=0)
    with comfy_client(settings, fake) as client:
        ids = [upload(client).json()["file_id"] for _ in range(2)]
        response = client.post("/api/generations", json={
            "model": "wan2.1-i2v-14b", "mode": "flf2v", "prompt": "x", "image_ids": ids})
        assert wait_for(client, response.json()["generations"][0]["id"])["status"] == "completed"
    assert fake.queued[0]["9"]["class_type"] == "WanFirstLastFrameToVideo"
    assert fake.queued[0]["14"]["inputs"]["image"] == "upload_1.png"


def test_legacy_generate_uses_an_installed_image_model(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN21_FILES, pending_polls=0)
    with comfy_client(settings, fake) as client:
        file_id = upload(client).json()["file_id"]
        response = client.post("/api/generate", json={"image_ids": [file_id], "prompt": "x"})
        assert response.status_code == 202, response.text
        assert response.json()["is_mock"] is False
        job = wait_for(client, response.json()["job_id"], path="/api/status/")
    assert job["status"] == "completed"
    assert fake.queued[0]["9"]["class_type"] == "WanImageToVideo"


def test_rejected_workflow_is_reported_in_arabic(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES, fail_prompt=True)
    with comfy_client(settings, fake) as client:
        gid = client.post("/api/generations", json={"mode": "t2v", "prompt": "x"}).json()["generations"][0]["id"]
        done = wait_for(client, gid)
    assert done["status"] == "failed"
    assert "رفض ComfyUI" in done["error"]
    assert "unet_name" in done["error_details"]


def test_out_of_vram_is_explained(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES, pending_polls=0,
                       history_error="torch.OutOfMemoryError: CUDA out of memory")
    with comfy_client(settings, fake) as client:
        gid = client.post("/api/generations", json={"mode": "t2v", "prompt": "x"}).json()["generations"][0]["id"]
        done = wait_for(client, gid)
    assert done["status"] == "failed"
    assert "VRAM" in done["error"]


def test_cancel_and_delete_running_generation(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES, never_finish=True)
    with comfy_client(settings, fake) as client:
        first = client.post("/api/generations", json={"mode": "t2v", "prompt": "x"}).json()["generations"][0]
        _wait_status(client, first["id"], "running")
        client.post(f"/api/generations/{first['id']}/cancel")
        assert wait_for(client, first["id"])["status"] == "cancelled"
        assert fake.interrupted or fake.deleted_from_queue

        second = client.post("/api/generations", json={"mode": "t2v", "prompt": "y"}).json()["generations"][0]
        _wait_status(client, second["id"], "running")
        assert client.delete(f"/api/generations/{second['id']}").json()["deleted"] is True
        assert client.get(f"/api/generations/{second['id']}").status_code == 404
        _wait_gone(settings, second["id"])


def _wait_status(client, gid, status, timeout=10):
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        if client.get(f"/api/generations/{gid}").json()["status"] == status:
            return
        time.sleep(0.05)
    raise AssertionError(f"never reached {status}")


def _wait_gone(settings, gid, timeout=10):
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        if not (settings.output_dir / gid).exists():
            return
        time.sleep(0.05)
    raise AssertionError("files not removed")


def test_websocket_progress_mapping():
    watcher = _ProgressWatcher("http://127.0.0.1:8188", "abc")
    assert watcher.url == "ws://127.0.0.1:8188/ws?clientId=abc"
    assert watcher.progress()[0] == 0.08
    watcher._handle({"type": "execution_start", "data": {"prompt_id": "p"}})
    watcher._handle({"type": "progress", "data": {"value": 10, "max": 20}})
    fraction, message = watcher.progress()
    assert fraction == pytest.approx(0.5)
    assert "10 من 20" in message
    watcher._handle({"type": "progress", "data": {"value": 20, "max": 20}})
    watcher._handle({"type": "executing", "data": {"node": "9"}})
    assert watcher.progress()[0] == 0.92
    watcher._handle({"type": "executing", "data": {"node": None}})
    assert watcher.finished
    watcher._handle({"type": "execution_error", "data": {"exception_message": "boom"}})
    assert "boom" in watcher.error


def test_animated_webp_keeps_timing_of_merged_frames(tmp_path):
    from app.ffmpeg_utils import animated_image_to_mp4, find_ffmpeg

    frames = [Image.new("RGB", (64, 64), c) for c in [(255, 0, 0), (0, 255, 0)]]
    src = tmp_path / "anim.webp"
    frames[0].save(src, format="WEBP", save_all=True, append_images=frames[1:], duration=[62, 188], loop=0)
    dst = tmp_path / "out.mp4"
    animated_image_to_mp4(find_ffmpeg(), src, dst, default_fps=16)
    count, _ = imageio_ffmpeg.count_frames_and_secs(str(dst))
    assert count == 4


def test_corrupted_model_file_is_explained(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES, pending_polls=0,
                       history_error="safetensors_rust.SafetensorError: Error while deserializing header: header too small")
    with comfy_client(settings, fake) as client:
        gid = client.post("/api/generations", json={"mode": "t2v", "prompt": "x"}).json()["generations"][0]["id"]
        done = wait_for(client, gid)
    assert done["status"] == "failed"
    assert "تالف" in done["error"] and "download_models.py" in done["error"]
    assert "header too small" in done["error_details"]


OOM = "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB"


def test_out_of_vram_retries_with_lower_resolution_and_reports_it(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES, pending_polls=0, history_error=OOM, fail_first=1)
    with comfy_client(settings, fake) as client:
        file_id = upload(client).json()["file_id"]
        gid = client.post("/api/generations", json={
            "mode": "i2v", "prompt": "a man talking", "image_ids": [file_id], "resolution": "720p", "duration": 5,
            "aspect_ratio": "16:9"}).json()["generations"][0]["id"]
        done = wait_for(client, gid)
    assert done["status"] == "completed", done
    assert done["success"] is True and done["stage"] is None
    assert [q["6"]["inputs"]["width"] for q in fake.queued] == [1280, 832]  # 720p, then 480p
    assert done["params"]["resolution"] == "480p" and done["params"]["width"] == 832
    assert "ذاكرة كرت الشاشة لم تكفِ" in done["notice"] and "480p" in done["notice"]
    assert done["result"]["frames"] >= 2 and done["result"]["width"] > 0
    assert done["filename"].endswith(".mp4")


def test_out_of_vram_everywhere_fails_honestly_with_stage(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES, pending_polls=0, history_error=OOM)
    with comfy_client(settings, fake) as client:
        gid = client.post("/api/generations", json={"mode": "t2v", "prompt": "x", "resolution": "720p",
                                                    "duration": 8}).json()["generations"][0]["id"]
        done = wait_for(client, gid)
    assert done["status"] == "failed" and done["success"] is False
    assert done["stage"] == "generation" and done["stage_label"] == "التوليد"
    assert "VRAM" in done["error"] and done["hint"]
    # 720p/8s -> 480p/8s -> 480p/3s: every attempt was a real request to the engine
    sizes = [(q["6"]["inputs"]["width"], q["6"]["inputs"]["length"]) for q in fake.queued]
    assert sizes == [(1280, 193), (832, 193), (832, 73)]
    assert not (settings.output_dir / gid / "video.mp4").exists()


def test_corrupted_model_falls_back_to_another_installed_model(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES | LTX_FILES, pending_polls=0, fail_first=1,
                       history_error="SafetensorError: Error while deserializing header: header too small")
    with comfy_client(settings, fake) as client:
        gid = client.post("/api/generations", json={"mode": "t2v", "prompt": "x"}).json()["generations"][0]["id"]
        done = wait_for(client, gid)
    assert done["status"] == "completed", done
    assert done["model"] == "ltxv-2b"
    assert fake.queued[1]["1"]["class_type"] == "CheckpointLoaderSimple"
    assert "تعذّر تحميل النموذج" in done["notice"]


def test_comfyui_log_is_attached_to_failures(settings):
    log = "Traceback (most recent call last):\n  File \"nodes.py\"\nRuntimeError: mat1 and mat2 shapes cannot be multiplied"
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES, pending_polls=0,
                       history_error="RuntimeError: shapes", log_text=log)
    with comfy_client(settings, fake) as client:
        gid = client.post("/api/generations", json={"mode": "t2v", "prompt": "x"}).json()["generations"][0]["id"]
        done = wait_for(client, gid)
    assert done["status"] == "failed"
    assert "--- ComfyUI log" in done["error_details"] and "mat1 and mat2" in done["error_details"]


def test_frozen_output_is_rejected_by_validation(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES, pending_polls=0, frozen=True)
    with comfy_client(settings, fake) as client:
        gid = client.post("/api/generations", json={"mode": "t2v", "prompt": "x"}).json()["generations"][0]["id"]
        done = wait_for(client, gid)
    assert done["status"] == "failed" and done["success"] is False
    assert done["stage"] == "validation"
    assert "still image" in done["error_details"]
    assert done["video_url"] is None


def test_health_summary(settings):
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES)
    with comfy_client(settings, fake) as client:
        body = client.get("/api/health").json()
    assert {k: body[k] for k in ("backend", "engine", "comfyui", "models")} == \
        {"backend": "ok", "engine": "ok", "comfyui": "ok", "models": "ok"}
    fake.gpu = False
    with comfy_client(settings, fake) as client:
        body = client.get("/api/health").json()
    assert body["comfyui"] == "cpu_only" and body["engine"] == "unavailable"


def test_corrupted_model_file_is_detected_before_generating(settings, tmp_path):
    models = tmp_path / "comfy_models"
    (models / "diffusion_models").mkdir(parents=True)
    (models / "diffusion_models" / "wan2.2_ti2v_5B_fp16.safetensors").write_bytes(b"\x10\x00" + b"\0" * 100)
    fake = FakeComfyUI(settings.workflows_dir, installed=WAN22_FILES)
    fake.folder_paths = {"diffusion_models": [str(models / "diffusion_models")]}
    with comfy_client(settings, fake) as client:
        model = client.get("/api/models").json()["models"][0]["availability"]
        response = client.post("/api/generations", json={"mode": "t2v", "prompt": "x"})
    assert model["available"] is False
    assert "تالفة" in model["message"] and "wan2.2_ti2v_5B_fp16.safetensors" in model["message"]
    assert response.status_code == 503
    assert fake.queued == []  # nothing was sent to ComfyUI


def test_old_gpu_without_pytorch_kernels_is_explained():
    from app.providers.comfyui import classify_failure

    kind, message, stage = classify_failure(
        "RuntimeError: CUDA error: no kernel image is available for execution on the device")
    assert kind == "cuda" and stage == "generation"
    assert "install-windows.bat" in message and "GTX 10xx" in message
