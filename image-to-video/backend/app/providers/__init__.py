"""Video engine registry. Add a new engine by implementing VideoProvider and registering it here."""

from __future__ import annotations

from .base import (
    GenerationError,
    GenerationRequest,
    ProviderStatus,
    ProviderUnavailable,
    VideoProvider,
)
from .comfyui import ComfyUIProvider
from .mock import MockProvider


def build_providers(settings, ffmpeg_path: str | None, comfy_transport=None) -> dict[str, VideoProvider]:
    return {
        "comfyui": ComfyUIProvider(settings, ffmpeg_path, transport=comfy_transport),
        "mock": MockProvider(ffmpeg_path),
    }


__all__ = [
    "ComfyUIProvider",
    "GenerationError",
    "GenerationRequest",
    "MockProvider",
    "ProviderStatus",
    "ProviderUnavailable",
    "VideoProvider",
    "build_providers",
]
