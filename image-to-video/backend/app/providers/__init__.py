"""Video engine registry. Add a new engine by implementing VideoProvider and registering it here;
models in workflows/models.json refer to engines by name ("provider")."""

from __future__ import annotations

from .base import (
    GenerationCancelled,
    GenerationError,
    GenerationRequest,
    ModelAvailability,
    ModelLoadError,
    OutOfVRAMError,
    ProviderStatus,
    ProviderUnavailable,
    VideoProvider,
)
from .comfyui import ComfyUIProvider
from .mock import MockProvider


def build_providers(settings, ffmpeg_path: str | None, comfy_transport=None,
                    use_websocket: bool = True) -> dict[str, VideoProvider]:
    return {
        "comfyui": ComfyUIProvider(settings, ffmpeg_path, transport=comfy_transport, use_websocket=use_websocket),
        "mock": MockProvider(ffmpeg_path),
    }


__all__ = [
    "ComfyUIProvider",
    "GenerationCancelled",
    "GenerationError",
    "GenerationRequest",
    "MockProvider",
    "ModelAvailability",
    "ModelLoadError",
    "OutOfVRAMError",
    "ProviderStatus",
    "ProviderUnavailable",
    "VideoProvider",
    "build_providers",
]
