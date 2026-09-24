"""Application settings, loaded from environment variables (and an optional .env file)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent

# Project-level .env first, then backend/.env (neither overrides real env vars).
load_dotenv(PROJECT_ROOT / ".env")
load_dotenv(BACKEND_DIR / ".env")


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value.strip() if value and value.strip() else default


def _env_bool(name: str, default: bool) -> bool:
    return _env(name, "true" if default else "false").lower() in {"1", "true", "yes", "on"}


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    path = Path(raw)
    return path if path.is_absolute() else (PROJECT_ROOT / path).resolve()


@dataclass
class Settings:
    video_provider: str = "auto"  # auto | comfyui | mock
    comfyui_url: str = "http://127.0.0.1:8188"
    comfyui_workflow: str = "wan2.1_i2v_480p_api.json"
    comfyui_workflow_two_images: str = "wan2.1_flf2v_720p_api.json"
    comfyui_timeout_seconds: int = 1800
    comfyui_expected_seconds: int = 600
    allow_remote_comfyui: bool = False
    upload_dir: Path = PROJECT_ROOT / "uploads"
    output_dir: Path = PROJECT_ROOT / "outputs"
    workflows_dir: Path = PROJECT_ROOT / "workflows"
    max_upload_mb: int = 20
    file_ttl_hours: float = 24
    cleanup_interval_minutes: float = 30
    cors_origins: list[str] = field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )
    ffmpeg_path: str = ""
    max_concurrent_jobs: int = 1

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    def ensure_dirs(self) -> None:
        for directory in (self.upload_dir, self.output_dir, self.workflows_dir):
            directory.mkdir(parents=True, exist_ok=True)


def load_settings() -> Settings:
    return Settings(
        video_provider=_env("VIDEO_PROVIDER", "auto").lower(),
        comfyui_url=_env("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/"),
        comfyui_workflow=_env("COMFYUI_WORKFLOW", "wan2.1_i2v_480p_api.json"),
        # An explicitly empty value disables the two-image workflow.
        comfyui_workflow_two_images=os.environ.get(
            "COMFYUI_WORKFLOW_TWO_IMAGES", "wan2.1_flf2v_720p_api.json"
        ).strip(),
        comfyui_timeout_seconds=int(_env("COMFYUI_TIMEOUT_SECONDS", "1800")),
        comfyui_expected_seconds=int(_env("COMFYUI_EXPECTED_SECONDS", "600")),
        allow_remote_comfyui=_env_bool("ALLOW_REMOTE_COMFYUI", False),
        upload_dir=_env_path("UPLOAD_DIR", PROJECT_ROOT / "uploads"),
        output_dir=_env_path("OUTPUT_DIR", PROJECT_ROOT / "outputs"),
        workflows_dir=_env_path("WORKFLOWS_DIR", PROJECT_ROOT / "workflows"),
        max_upload_mb=int(_env("MAX_UPLOAD_MB", "20")),
        file_ttl_hours=float(_env("FILE_TTL_HOURS", "24")),
        cleanup_interval_minutes=float(_env("CLEANUP_INTERVAL_MINUTES", "30")),
        cors_origins=[
            origin.strip()
            for origin in _env(
                "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
            ).split(",")
            if origin.strip()
        ],
        ffmpeg_path=_env("FFMPEG_PATH", ""),
        max_concurrent_jobs=max(1, int(_env("MAX_CONCURRENT_JOBS", "1"))),
    )
