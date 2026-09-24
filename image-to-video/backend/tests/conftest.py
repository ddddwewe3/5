import io
import shutil
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import PROJECT_ROOT, Settings  # noqa: E402
from app.main import create_app  # noqa: E402


def make_image_bytes(fmt: str = "PNG", size=(320, 240), color=(200, 120, 60)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, color).save(buffer, format=fmt)
    return buffer.getvalue()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    workflows = tmp_path / "workflows"
    shutil.copytree(PROJECT_ROOT / "workflows", workflows)
    return Settings(
        video_provider="auto",
        comfyui_url="http://127.0.0.1:59999",  # nothing listens here
        upload_dir=tmp_path / "uploads",
        output_dir=tmp_path / "outputs",
        workflows_dir=workflows,
    )


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def upload(client, data: bytes | None = None, name="photo.png", mime="image/png"):
    return client.post("/api/upload", files={"file": (name, data or make_image_bytes(), mime)})


def wait_for_job(client, job_id: str, timeout: float = 60) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        body = client.get(f"/api/status/{job_id}").json()
        if body["status"] in {"completed", "failed"}:
            return body
        time.sleep(0.2)
    raise AssertionError("job did not finish in time")
