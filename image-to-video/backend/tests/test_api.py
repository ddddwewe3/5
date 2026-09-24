"""Engine API behaviour without a working AI engine: validation, uploads, honesty, auth, demo mode."""

import imageio_ffmpeg
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.store import GenerationStore
from conftest import make_image_bytes, upload, wait_for


def test_health_reports_engine_unavailable_with_setup_steps(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    assert body["free"] is True
    assert body["engine_detail"]["available"] is False
    assert body["engine_detail"]["setup_steps"], "setup instructions must be returned instead of crashing"
    assert body["demo_mode"] is False
    assert body["providers"]["mock"]["available"] is False


def test_models_are_listed_but_unavailable_without_engine(client):
    body = client.get("/api/models").json()
    ids = [m["id"] for m in body["models"]]
    assert ids == ["wan2.2-ti2v-5b", "ltxv-2b", "wan2.1-i2v-14b"]
    assert body["default_model"] == "wan2.2-ti2v-5b"
    wan22 = body["models"][0]
    assert wan22["modes"] == ["t2v", "i2v"]
    assert wan22["resolutions"]["720p"]["16:9"] == [1280, 704]
    assert wan22["files"][0]["url"].startswith("https://huggingface.co/")
    assert all(m["availability"]["available"] is False for m in body["models"])


def test_generation_is_refused_when_engine_is_offline_never_faked(client):
    response = client.post("/api/generations", json={"mode": "t2v", "prompt": "a cat surfing"})
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert "غير متصل" in detail["message"]
    assert detail["setup_steps"]
    assert client.get("/api/generations").json()["generations"] == []


def test_legacy_generate_has_no_silent_fallback(client):
    file_id = upload(client).json()["file_id"]
    response = client.post("/api/generate", json={"image_ids": [file_id], "prompt": "x"})
    assert response.status_code == 503
    mock = client.post("/api/generate", json={"image_ids": [file_id], "prompt": "x", "provider": "mock"})
    assert mock.status_code == 503
    assert "معطّل" in mock.json()["detail"]["message"]


def test_upload_png_jpeg_webp(client):
    for fmt, name, mime in [("PNG", "a.png", "image/png"), ("JPEG", "b.jpg", "image/jpeg"),
                            ("WEBP", "c.webp", "image/webp")]:
        response = upload(client, make_image_bytes(fmt), name, mime)
        assert response.status_code == 201, response.text
        assert (response.json()["width"], response.json()["height"]) == (320, 240)


def test_upload_rejects_executables_and_non_images(client):
    assert upload(client, b"MZ\x90\x00" + b"\0" * 100, "setup.exe", "application/octet-stream").status_code == 415
    assert upload(client, b"\x7fELF" + b"\0" * 100, "photo.png").status_code == 415
    assert upload(client, b"not an image", "photo.jpg", "image/jpeg").status_code == 415
    assert upload(client, make_image_bytes(), "photo.gif", "image/gif").status_code == 415
    assert upload(client, make_image_bytes("PNG", size=(10, 10))).status_code == 400


def test_upload_rejects_too_large(settings):
    settings.max_upload_mb = 1
    with TestClient(create_app(settings, use_websocket=False)) as small:
        big = make_image_bytes("PNG") + b"\0" * (1024 * 1024 + 10)
        assert upload(small, big).status_code == 413


def test_delete_uploaded_file(client):
    file_id = upload(client).json()["file_id"]
    assert client.delete(f"/api/files/{file_id}").json()["deleted"] is True
    assert client.delete(f"/api/files/{file_id}").status_code == 404
    assert client.delete("/api/files/not-a-valid-id").status_code == 400


def test_validation_errors_are_arabic(client):
    response = client.post("/api/generations", json={"prompt": "", "aspect_ratio": "4:3"})
    assert response.status_code == 422
    assert "بيانات الطلب غير صالحة" in response.json()["detail"]["message"]


def test_request_shape_is_checked_before_engine(client):
    file_id = upload(client).json()["file_id"]
    cases = [
        ({"mode": "t2v", "prompt": "x", "image_ids": [file_id]}, 400),
        ({"mode": "i2v", "prompt": "x"}, 400),
        ({"model": "nope", "prompt": "x"}, 404),
        ({"model": "ltxv-2b", "mode": "flf2v", "prompt": "x", "image_ids": [file_id, file_id]}, 400),
        ({"mode": "t2v", "prompt": "x", "resolution": "4k"}, 400),
        ({"mode": "t2v", "prompt": "x", "duration": 7}, 400),
        ({"mode": "t2v", "prompt": "x", "variations": 6}, 400),
        ({"mode": "i2v", "prompt": "x", "image_ids": ["a" * 32]}, 404),
    ]
    for body, status in cases:
        assert client.post("/api/generations", json=body).status_code == status, body


def test_token_is_required_when_configured(settings):
    settings.engine_api_token = "s3cret"
    with TestClient(create_app(settings, use_websocket=False)) as secured:
        assert secured.get("/api/health").status_code == 401
        assert secured.get("/api/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
        assert secured.get("/api/health", headers={"Authorization": "Bearer s3cret"}).status_code == 200


def test_cors_allows_vite_dev_origin(client):
    response = client.options("/api/health", headers={"Origin": "http://localhost:5173",
                                                      "Access-Control-Request-Method": "GET"})
    assert response.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_settings_defaults_are_local_private_and_honest():
    s = Settings()
    assert s.comfyui_url.startswith("http://127.0.0.1")
    assert s.allow_remote_comfyui is False
    assert s.allow_cpu_generation is False
    assert s.enable_demo_mode is False
    assert s.max_upload_mb == 20


def test_interrupted_generations_are_marked_failed_on_restart(settings):
    store = GenerationStore(settings.db_path)
    store.create({"id": "c" * 32, "owner": "local", "batch_id": "b", "model": "wan2.2-ti2v-5b", "mode": "t2v",
                  "provider": "comfyui", "params": {"prompt": "x"}, "status": "running"})
    store.close()
    with TestClient(create_app(settings, use_websocket=False)) as restarted:
        body = restarted.get("/api/generations/" + "c" * 32).json()
    assert body["status"] == "failed"
    assert "إعادة التوليد" in body["error"]


# ---------------------------------------------------------------- demo mode


def _video_info(path):
    frames, seconds = imageio_ffmpeg.count_frames_and_secs(str(path))
    reader = imageio_ffmpeg.read_frames(str(path))
    meta = next(reader)
    reader.close()
    return frames, seconds, meta["size"]


def demo_client(settings):
    settings.enable_demo_mode = True
    return TestClient(create_app(settings, use_websocket=False))


def test_demo_mode_is_clearly_labeled_and_works_end_to_end(settings):
    with demo_client(settings) as demo:
        models = demo.get("/api/models").json()["models"]
        assert models[-1]["id"] == "demo-slideshow" and models[-1]["is_demo"] is True
        file_id = upload(demo).json()["file_id"]
        response = demo.post("/api/generations", json={
            "model": "demo-slideshow", "mode": "i2v", "prompt": "x", "image_ids": [file_id],
            "duration": 3, "aspect_ratio": "9:16",
        })
        assert response.status_code == 202, response.text
        generation = response.json()["generations"][0]
        assert generation["is_demo"] is True
        assert "ليس فيديو مولّدًا بالذكاء الاصطناعي" in generation["notice"]
        done = wait_for(demo, generation["id"])
        assert done["status"] == "completed", done
        assert done["thumbnail_url"]
        _, seconds, size = _video_info(settings.output_dir / generation["id"] / "video.mp4")
        assert size == (720, 1280) and abs(seconds - 3) < 0.3
        video = demo.get(done["video_url"])
        assert video.status_code == 200 and video.headers["content-type"] == "video/mp4"
        assert "attachment" in demo.get(done["video_url"] + "?download=1").headers["content-disposition"]
        assert demo.get(done["thumbnail_url"]).headers["content-type"] == "image/jpeg"


def test_legacy_endpoints_work_in_demo_mode(settings):
    with demo_client(settings) as demo:
        ids = [upload(demo, make_image_bytes(color=c)).json()["file_id"] for c in [(255, 0, 0), (0, 0, 255)]]
        response = demo.post("/api/generate", json={"image_ids": ids, "prompt": "x", "duration": 5,
                                                    "aspect_ratio": "16:9", "provider": "mock"})
        assert response.status_code == 202, response.text
        job = wait_for(demo, response.json()["job_id"], path="/api/status/")
        assert job["status"] == "completed"
        assert job["video_url"] == f"/api/video/{job['id']}"
        assert demo.get(job["video_url"]).status_code == 200


def test_history_regenerate_delete_and_owner_isolation(settings):
    alice = {"X-Owner-Id": "a" * 32}
    bob = {"X-Owner-Id": "b" * 32}
    with demo_client(settings) as demo:
        file_id = upload(demo).json()["file_id"]
        created = demo.post("/api/generations", headers=alice, json={
            "model": "demo-slideshow", "mode": "i2v", "prompt": "x", "image_ids": [file_id], "duration": 3,
        }).json()["generations"][0]
        wait_for_owner(demo, created["id"], alice)

        assert [g["id"] for g in demo.get("/api/generations", headers=alice).json()["generations"]] == [created["id"]]
        assert demo.get("/api/generations", headers=bob).json()["generations"] == []
        assert demo.get(f"/api/generations/{created['id']}", headers=bob).status_code == 404
        assert demo.get(f"/api/generations/{created['id']}/video", headers=bob).status_code == 404
        assert demo.delete(f"/api/generations/{created['id']}", headers=bob).status_code == 404

        # Source images are kept per generation, so regenerate works even after the upload is deleted.
        demo.delete(f"/api/files/{file_id}")
        again = demo.post(f"/api/generations/{created['id']}/regenerate", headers=alice)
        assert again.status_code == 202, again.text
        regenerated = again.json()["generations"][0]
        assert regenerated["params"]["prompt"] == "x"
        assert regenerated["params"]["seed"] != created["params"]["seed"]
        wait_for_owner(demo, regenerated["id"], alice)
        assert len(demo.get("/api/generations", headers=alice).json()["generations"]) == 2

        assert demo.delete(f"/api/generations/{created['id']}", headers=alice).json()["deleted"] is True
        assert not (settings.output_dir / created["id"]).exists()
        assert demo.get(f"/api/generations/{created['id']}", headers=alice).status_code == 404


def wait_for_owner(client, generation_id, headers, timeout=60):
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/api/generations/{generation_id}", headers=headers).json()
        if body["status"] in {"completed", "failed", "cancelled"}:
            assert body["status"] == "completed", body
            return body
        time.sleep(0.1)
    raise AssertionError("timeout")


def test_cancel_queued_generation(settings):
    settings.enable_demo_mode = True
    with TestClient(create_app(settings, use_websocket=False, start_worker=False)) as paused:
        file_id = upload(paused).json()["file_id"]
        generation = paused.post("/api/generations", json={
            "model": "demo-slideshow", "mode": "i2v", "prompt": "x", "image_ids": [file_id], "variations": 2,
        }).json()["generations"]
        assert [g["queue_position"] for g in generation] == [1, 2]
        cancelled = paused.post(f"/api/generations/{generation[0]['id']}/cancel").json()
        assert cancelled["status"] == "cancelled"
        assert paused.get(f"/api/generations/{generation[1]['id']}").json()["queue_position"] == 1
