"""Safe storage of uploaded images and cleanup of expired files."""

from __future__ import annotations

import io
import re
import time
import uuid
from pathlib import Path
from typing import BinaryIO

from PIL import Image, ImageOps, UnidentifiedImageError

FILE_ID_RE = re.compile(r"^[a-f0-9]{32}$")

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}
ALLOWED_PIL_FORMATS = {"JPEG", "PNG", "WEBP"}

# Extensions that are never accepted, even if renamed content would be rejected anyway.
BLOCKED_EXTENSIONS = {
    ".exe", ".dll", ".bat", ".cmd", ".com", ".msi", ".scr", ".ps1", ".vbs", ".js",
    ".jar", ".sh", ".bin", ".elf", ".app", ".apk", ".deb", ".rpm", ".py", ".php",
}
# Magic bytes of common executable / archive formats.
BLOCKED_SIGNATURES = (
    b"MZ",                  # Windows PE
    b"\x7fELF",             # Linux ELF
    b"#!",                  # scripts with shebang
    b"\xca\xfe\xba\xbe",    # Mach-O fat / Java class
    b"\xcf\xfa\xed\xfe",    # Mach-O 64
    b"\xce\xfa\xed\xfe",    # Mach-O 32
    b"PK\x03\x04",          # zip / jar / apk
)

MIN_DIMENSION = 64
MAX_PIXELS = 40_000_000
CHUNK_SIZE = 1024 * 1024


class UploadError(Exception):
    """Upload rejected. `message` is shown to the user (Arabic)."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def is_valid_file_id(file_id: str) -> bool:
    return bool(FILE_ID_RE.match(file_id or ""))


def _read_limited(stream: BinaryIO, max_bytes: int) -> bytes:
    buffer = io.BytesIO()
    while True:
        chunk = stream.read(CHUNK_SIZE)
        if not chunk:
            break
        buffer.write(chunk)
        if buffer.tell() > max_bytes:
            raise UploadError(
                f"حجم الصورة أكبر من الحد المسموح ({max_bytes // (1024 * 1024)} ميغابايت).",
                413,
            )
    return buffer.getvalue()


def save_upload(
    stream: BinaryIO,
    filename: str | None,
    content_type: str | None,
    upload_dir: Path,
    max_bytes: int,
) -> dict:
    """Validate an uploaded image and store a sanitized PNG copy.

    The image is fully decoded and re-encoded, which strips metadata (EXIF/GPS)
    and guarantees the stored file is a real image.
    """
    ext = Path(filename or "").suffix.lower()
    if ext in BLOCKED_EXTENSIONS:
        raise UploadError("الملفات التنفيذية غير مسموح بها. ارفع صورة فقط.", 415)
    if ext not in ALLOWED_EXTENSIONS:
        raise UploadError("نوع الملف غير مدعوم. الأنواع المسموح بها: JPG و PNG و WEBP.", 415)
    if content_type and content_type not in ALLOWED_MIME_TYPES | {"application/octet-stream"}:
        raise UploadError("نوع الملف غير مدعوم. الأنواع المسموح بها: JPG و PNG و WEBP.", 415)

    data = _read_limited(stream, max_bytes)
    if not data:
        raise UploadError("الملف فارغ.")
    if data.startswith(BLOCKED_SIGNATURES):
        raise UploadError("الملفات التنفيذية غير مسموح بها. ارفع صورة فقط.", 415)

    try:
        with Image.open(io.BytesIO(data)) as probe:
            if probe.format not in ALLOWED_PIL_FORMATS:
                raise UploadError("محتوى الملف ليس صورة JPG أو PNG أو WEBP صالحة.", 415)
            width, height = probe.size
            if width * height > MAX_PIXELS:
                raise UploadError("أبعاد الصورة كبيرة جدًا.", 413)
            probe.verify()
        with Image.open(io.BytesIO(data)) as img:
            img.load()
            img = ImageOps.exif_transpose(img)
            img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
    except UploadError:
        raise
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombError):
        raise UploadError("تعذّرت قراءة الصورة. قد يكون الملف تالفًا أو ليس صورة.", 415)

    width, height = img.size
    if width < MIN_DIMENSION or height < MIN_DIMENSION:
        raise UploadError(f"الصورة صغيرة جدًا. الحد الأدنى {MIN_DIMENSION}×{MIN_DIMENSION} بكسل.")

    upload_dir.mkdir(parents=True, exist_ok=True)
    file_id = uuid.uuid4().hex
    path = upload_dir / f"{file_id}.png"
    img.save(path, format="PNG")
    return {
        "file_id": file_id,
        "width": width,
        "height": height,
        "size_bytes": path.stat().st_size,
    }


def upload_path(upload_dir: Path, file_id: str) -> Path | None:
    if not is_valid_file_id(file_id):
        return None
    path = upload_dir / f"{file_id}.png"
    return path if path.is_file() else None


def delete_upload(upload_dir: Path, file_id: str) -> bool:
    path = upload_path(upload_dir, file_id)
    if path is None:
        return False
    path.unlink(missing_ok=True)
    return True


def cleanup_old_files(directories: list[Path], max_age_seconds: float, now: float | None = None) -> int:
    """Delete files (and emptied sub-directories) older than max_age_seconds."""
    now = time.time() if now is None else now
    removed = 0
    for directory in directories:
        if not directory.is_dir():
            continue
        for path in sorted(directory.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            if path.name == ".gitkeep":
                continue
            try:
                if path.is_file() and now - path.stat().st_mtime > max_age_seconds:
                    path.unlink()
                    removed += 1
                elif path.is_dir() and not any(path.iterdir()):
                    if now - path.stat().st_mtime > max_age_seconds:
                        path.rmdir()
            except OSError:
                continue
    return removed
