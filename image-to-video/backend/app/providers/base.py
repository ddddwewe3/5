"""Provider abstraction: every video engine implements VideoProvider."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

# progress callback: (fraction 0..1, Arabic status message)
ProgressCallback = Callable[[float, str], None]

ASPECT_RATIOS = ("9:16", "16:9", "1:1")
MOTION_LEVELS = ("low", "medium", "high")
DURATIONS = (3, 5, 8)


@dataclass
class GenerationRequest:
    image_paths: list[Path]
    prompt: str
    negative_prompt: str
    duration: int
    aspect_ratio: str
    motion: str
    seed: int
    output_path: Path
    work_dir: Path
    job_id: str


@dataclass
class ProviderStatus:
    name: str
    available: bool
    message: str
    is_mock: bool = False
    setup_steps: list[str] = field(default_factory=list)
    details: dict = field(default_factory=dict)


class ProviderUnavailable(Exception):
    """The engine is not installed / not reachable. Message is Arabic and user-facing."""

    def __init__(self, message: str, setup_steps: list[str] | None = None):
        super().__init__(message)
        self.message = message
        self.setup_steps = setup_steps or []


class GenerationError(Exception):
    """Generation failed. Message is Arabic and user-facing."""

    def __init__(self, message: str, details: str = ""):
        super().__init__(message)
        self.message = message
        self.details = details


class VideoProvider(ABC):
    name: str = "base"
    is_mock: bool = False

    @abstractmethod
    def status(self) -> ProviderStatus:
        """Cheap availability check; must never raise."""

    @abstractmethod
    def generate(self, request: GenerationRequest, progress: ProgressCallback) -> None:
        """Generate an MP4 at request.output_path. Raise GenerationError / ProviderUnavailable."""
