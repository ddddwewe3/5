import io
import os
import time

import pytest
from PIL import Image

from app.storage import UploadError, cleanup_old_files, save_upload
from conftest import make_image_bytes


def test_save_upload_strips_metadata_and_stores_png(tmp_path):
    img = Image.new("RGB", (200, 100), (10, 20, 30))
    exif = Image.Exif()
    exif[0x010F] = "SecretCameraMaker"
    buffer = io.BytesIO()
    img.save(buffer, format="JPEG", exif=exif)

    info = save_upload(io.BytesIO(buffer.getvalue()), "x.jpg", "image/jpeg", tmp_path, 20 * 1024 * 1024)
    stored = tmp_path / f"{info['file_id']}.png"
    assert stored.is_file()
    with Image.open(stored) as reopened:
        assert reopened.format == "PNG"
        assert not reopened.getexif()


def test_save_upload_rejects_script(tmp_path):
    with pytest.raises(UploadError):
        save_upload(io.BytesIO(b"#!/bin/sh\nrm -rf /"), "x.png", "image/png", tmp_path, 1024 * 1024)


def test_save_upload_rejects_oversize(tmp_path):
    with pytest.raises(UploadError) as err:
        save_upload(io.BytesIO(make_image_bytes() + b"\0" * 2048), "x.png", "image/png", tmp_path, 1024)
    assert err.value.status_code == 413


def test_cleanup_removes_only_expired_files(tmp_path):
    old = tmp_path / "old.png"
    new = tmp_path / "new.png"
    keep = tmp_path / ".gitkeep"
    for path in (old, new, keep):
        path.write_bytes(b"x")
    past = time.time() - 25 * 3600
    os.utime(old, (past, past))
    os.utime(keep, (past, past))

    removed = cleanup_old_files([tmp_path], 24 * 3600)
    assert removed == 1
    assert not old.exists() and new.exists() and keep.exists()
