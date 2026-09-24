"""Provider abstraction: every video engine implements VideoProvider."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from ..models_registry import ModelSpec

# progress callback: (fraction 0..1, Arabic status message)
ProgressCallback = Callable[[float, str], None]
CancelCheck = Callable[[], bool]


@dataclass
class GenerationRequest:
    model: "ModelSpec"
    mode: str  # t2v | i2v | flf2v
    image_paths: list[Path]
    prompt: str
    negative_prompt: str
    duration: int
    aspect_ratio: str
    resolution: str
    motion: str
    seed: int
    output_path: Path
    work_dir: Path
    job_id: str

    @property
    def width(self) -> int:
        return self.model.dimensions(self.resolution, self.aspect_ratio)[0]

    @property
    def height(self) -> int:
        return self.model.dimensions(self.resolution, self.aspect_ratio)[1]

    @property
    def frames(self) -> int:
        return self.model.frame_count(self.duration)


@dataclass
class ProviderStatus:
    name: str
    available: bool
    message: str
    is_mock: bool = False
    setup_steps: list[str] = field(default_factory=list)
    details: dict = field(default_factory=dict)


@dataclass
class ModelAvailability:
    available: bool
    message: str
    modes: dict[str, dict] = field(default_factory=dict)  # mode -> {available, missing: [...]}
    setup_steps: list[str] = field(default_factory=list)


# Where a generation failed. Shown to the user and returned by the API.
STAGES = ("upload", "preprocessing", "engine_connection", "model_loading", "generation",
          "encoding", "validation", "output")


class ProviderUnavailable(Exception):
    """The engine is not installed / not reachable. Message is Arabic and user-facing."""

    stage = "engine_connection"

    def __init__(self, message: str, setup_steps: list[str] | None = None):
        super().__init__(message)
        self.message = message
        self.setup_steps = setup_steps or []


class GenerationError(Exception):
    """Generation failed. Message is Arabic and user-facing; `stage` says where it failed."""

    def __init__(self, message: str, details: str = "", stage: str = "generation"):
        super().__init__(message)
        self.message = message
        self.details = details
        self.stage = stage


class OutOfVRAMError(GenerationError):
    """The GPU ran out of memory. The worker retries with lighter settings."""

    def __init__(self, message: str, details: str = ""):
        super().__init__(message, details, stage="generation")


class ModelLoadError(GenerationError):
    """A model file could not be loaded (missing, corrupted, incompatible)."""

    def __init__(self, message: str, details: str = ""):
        super().__init__(message, details, stage="model_loading")


class GenerationCancelled(Exception):
    pass


class VideoProvider(ABC):
    name: str = "base"
    is_mock: bool = False

    @abstractmethod
    def status(self) -> ProviderStatus:
        """Cheap availability check of the engine itself; must never raise."""

    @abstractmethod
    def model_status(self, model: "ModelSpec") -> ModelAvailability:
        """Whether this model (and each of its modes) can run right now; must never raise."""

    @abstractmethod
    def generate(self, request: GenerationRequest, progress: ProgressCallback,
                 should_cancel: CancelCheck = lambda: False) -> None:
        """Write an MP4 to request.output_path. Raise GenerationError / ProviderUnavailable /
        GenerationCancelled."""
