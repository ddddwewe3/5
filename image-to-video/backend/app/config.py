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
    comfyui_url: str = "http://127.0.0.1:8188"
    comfyui_timeout_seconds: int = 3600
    allow_remote_comfyui: bool = False
    # Generation on a CPU-only ComfyUI takes hours; it is refused unless explicitly allowed.
    allow_cpu_generation: bool = False
    # Demo mode adds a Ken Burns slideshow "model" for UI testing. It is NOT AI and is off by default.
    enable_demo_mode: bool = False
    # Shared secret required from the website when set (always set it if the engine is reachable remotely).
    engine_api_token: str = ""
    upload_dir: Path = PROJECT_ROOT / "uploads"
    output_dir: Path = PROJECT_ROOT / "outputs"
    workflows_dir: Path = PROJECT_ROOT / "workflows"
    data_dir: Path = PROJECT_ROOT / "data"
    max_upload_mb: int = 20
    file_ttl_hours: float = 24  # uploaded source images
    history_ttl_days: float = 7  # generated videos in the history
    cleanup_interval_minutes: float = 30
    cors_origins: list[str] = field(
        default_factory=lambda: ["http://localhost:5173", "http://127.0.0.1:5173"]
    )
    ffmpeg_path: str = ""
    max_concurrent_jobs: int = 1
    max_variations: int = 4

    @property
    def db_path(self) -> Path:
        return self.data_dir / "engine.db"

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    def ensure_dirs(self) -> None:
        for directory in (self.upload_dir, self.output_dir, self.workflows_dir, self.data_dir):
            directory.mkdir(parents=True, exist_ok=True)


def load_settings() -> Settings:
    return Settings(
        comfyui_url=_env("COMFYUI_URL", "http://127.0.0.1:8188").rstrip("/"),
        comfyui_timeout_seconds=int(_env("COMFYUI_TIMEOUT_SECONDS", "3600")),
        allow_remote_comfyui=_env_bool("ALLOW_REMOTE_COMFYUI", False),
        allow_cpu_generation=_env_bool("ALLOW_CPU_GENERATION", False),
        enable_demo_mode=_env_bool("ENABLE_DEMO_MODE", False),
        engine_api_token=_env("ENGINE_API_TOKEN", ""),
        upload_dir=_env_path("UPLOAD_DIR", PROJECT_ROOT / "uploads"),
        output_dir=_env_path("OUTPUT_DIR", PROJECT_ROOT / "outputs"),
        workflows_dir=_env_path("WORKFLOWS_DIR", PROJECT_ROOT / "workflows"),
        data_dir=_env_path("DATA_DIR", PROJECT_ROOT / "data"),
        max_upload_mb=int(_env("MAX_UPLOAD_MB", "20")),
        file_ttl_hours=float(_env("FILE_TTL_HOURS", "24")),
        history_ttl_days=float(_env("HISTORY_TTL_DAYS", "7")),
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
        max_variations=max(1, min(8, int(_env("MAX_VARIATIONS", "4")))),
    )
