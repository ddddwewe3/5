import imageio_ffmpeg

from app.config import Settings
from conftest import make_image_bytes, upload, wait_for_job


def test_health_reports_comfyui_unavailable_with_setup_steps(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok"
    comfy = body["providers"]["comfyui"]
    assert comfy["available"] is False
    assert comfy["setup_steps"], "setup instructions must be returned instead of crashing"
    assert body["providers"]["mock"]["available"] is True


def test_upload_png_jpeg_webp(client):
    for fmt, name, mime in [("PNG", "a.png", "image/png"), ("JPEG", "b.jpg", "image/jpeg"),
                            ("WEBP", "c.webp", "image/webp")]:
        response = upload(client, make_image_bytes(fmt), name, mime)
        assert response.status_code == 201, response.text
        body = response.json()
        assert len(body["file_id"]) == 32
        assert (body["width"], body["height"]) == (320, 240)


def test_upload_rejects_executable(client):
    response = upload(client, b"MZ\x90\x00" + b"\x00" * 100, "setup.exe", "application/octet-stream")
    assert response.status_code == 415
    assert "التنفيذية" in response.json()["detail"]["message"]


def test_upload_rejects_executable_renamed_as_image(client):
    response = upload(client, b"\x7fELF" + b"\x00" * 100, "photo.png", "image/png")
    assert response.status_code == 415


def test_upload_rejects_non_image_content(client):
    response = upload(client, b"hello, not an image at all", "photo.jpg", "image/jpeg")
    assert response.status_code == 415
    assert "الصورة" in response.json()["detail"]["message"]


def test_upload_rejects_wrong_extension(client):
    response = upload(client, make_image_bytes(), "photo.gif", "image/gif")
    assert response.status_code == 415


def test_upload_rejects_too_large(settings):
    from fastapi.testclient import TestClient
    from app.main import create_app

    settings.max_upload_mb = 1
    with TestClient(create_app(settings)) as small_client:
        big = make_image_bytes("PNG") + b"\x00" * (1024 * 1024 + 10)
        response = upload(small_client, big)
    assert response.status_code == 413


def test_upload_rejects_tiny_image(client):
    response = upload(client, make_image_bytes("PNG", size=(10, 10)))
    assert response.status_code == 400


def test_delete_file(client):
    file_id = upload(client).json()["file_id"]
    assert client.delete(f"/api/files/{file_id}").json()["deleted"] is True
    assert client.delete(f"/api/files/{file_id}").status_code == 404
    assert client.delete("/api/files/..%2F..%2Fetc").status_code in (400, 404)
    assert client.delete("/api/files/not-a-valid-id").status_code == 400


def test_generate_validation_errors_are_arabic(client):
    response = client.post("/api/generate", json={"image_ids": [], "prompt": "", "duration": 4})
    assert response.status_code == 422
    assert "بيانات الطلب غير صالحة" in response.json()["detail"]["message"]


def test_generate_rejects_three_images(client):
    ids = [upload(client).json()["file_id"] for _ in range(3)]
    response = client.post("/api/generate", json={"image_ids": ids, "prompt": "x"})
    assert response.status_code == 422


def test_generate_missing_image(client):
    response = client.post("/api/generate", json={"image_ids": ["a" * 32], "prompt": "x"})
    assert response.status_code == 404


def test_generate_forced_comfyui_unavailable_returns_setup_steps(client):
    file_id = upload(client).json()["file_id"]
    response = client.post("/api/generate", json={"image_ids": [file_id], "prompt": "x", "provider": "comfyui"})
    assert response.status_code == 503
    detail = response.json()["detail"]
    assert "ComfyUI" in detail["message"]
    assert detail["setup_steps"]


def _video_info(path):
    frames, seconds = imageio_ffmpeg.count_frames_and_secs(str(path))
    reader = imageio_ffmpeg.read_frames(str(path))
    meta = next(reader)
    reader.close()
    return frames, seconds, meta["size"]


def test_generate_auto_falls_back_to_mock_one_image(client, settings):
    file_id = upload(client).json()["file_id"]
    response = client.post("/api/generate", json={
        "image_ids": [file_id], "prompt": "فيديو تجريبي", "duration": 3, "aspect_ratio": "9:16", "motion": "high",
    })
    assert response.status_code == 202, response.text
    body = response.json()
    assert body["is_mock"] is True and body["provider"] == "mock"
    assert "ليس فيديو مولّدًا بالذكاء الاصطناعي" in body["notice"]

    job = wait_for_job(client, body["job_id"])
    assert job["status"] == "completed", job
    assert job["video_url"] == f"/api/video/{body['job_id']}"

    frames, seconds, size = _video_info(settings.output_dir / f"{body['job_id']}.mp4")
    assert size == (720, 1280)
    assert abs(seconds - 3) < 0.3

    video = client.get(job["video_url"])
    assert video.status_code == 200
    assert video.headers["content-type"] == "video/mp4"
    download = client.get(job["video_url"] + "?download=1")
    assert "attachment" in download.headers["content-disposition"]


def test_generate_mock_two_images_crossfade(client, settings):
    ids = [upload(client, make_image_bytes(color=c)).json()["file_id"] for c in [(255, 0, 0), (0, 0, 255)]]
    response = client.post("/api/generate", json={
        "image_ids": ids, "prompt": "x", "duration": 5, "aspect_ratio": "16:9", "motion": "low", "provider": "mock",
    })
    job = wait_for_job(client, response.json()["job_id"])
    assert job["status"] == "completed", job
    _, seconds, size = _video_info(settings.output_dir / f"{job['id']}.mp4")
    assert size == (1280, 720)
    assert abs(seconds - 5) < 0.3


def test_status_and_video_unknown_job(client):
    assert client.get("/api/status/" + "b" * 32).status_code == 404
    assert client.get("/api/status/bad").status_code == 400
    assert client.get("/api/video/" + "b" * 32).status_code == 404


def test_cors_allows_vite_dev_origin(client):
    response = client.options("/api/health", headers={
        "Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET",
    })
    assert response.headers.get("access-control-allow-origin") == "http://localhost:5173"


def test_settings_defaults_are_local_and_private():
    s = Settings()
    assert s.comfyui_url.startswith("http://127.0.0.1")
    assert s.allow_remote_comfyui is False
    assert s.max_upload_mb == 20
    assert s.file_ttl_hours == 24
