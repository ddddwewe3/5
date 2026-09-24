"""Video model registry, loaded from workflows/models.json.

Each model names a provider (e.g. "comfyui"), the workflow file per generation mode,
and the resolutions / durations / frame rate it supports. Adding a model is a JSON edit.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

MODES = ("t2v", "i2v", "flf2v")
MODE_IMAGE_COUNT = {"t2v": 0, "i2v": 1, "flf2v": 2}
MODE_LABELS_AR = {"t2v": "نص إلى فيديو", "i2v": "صورة إلى فيديو", "flf2v": "من صورة أولى إلى صورة أخيرة"}
ASPECT_RATIOS = ("16:9", "9:16", "1:1")


@dataclass
class ModelSpec:
    id: str
    provider: str
    name: str
    tagline_ar: str = ""
    license: str = ""
    min_vram_gb: float = 0
    recommended_vram_gb: float = 0
    fps: int = 16
    frame_multiple: int = 4
    steps: int = 20
    expected_seconds: int = 600
    prompt_language: str = "multilingual"
    workflows: dict[str, str] = field(default_factory=dict)
    durations: list[int] = field(default_factory=lambda: [3, 5, 8])
    resolutions: dict[str, dict[str, list[int]]] = field(default_factory=dict)
    default_resolution: str = ""
    files: list[dict] = field(default_factory=list)
    is_demo: bool = False

    @property
    def modes(self) -> list[str]:
        return [mode for mode in MODES if mode in self.workflows]

    def dimensions(self, resolution: str, aspect_ratio: str) -> tuple[int, int]:
        width, height = self.resolutions[resolution][aspect_ratio]
        return int(width), int(height)

    def frame_count(self, duration: float) -> int:
        """Frames for `duration` seconds, as a multiple of frame_multiple plus one (Wan: 4n+1, LTX: 8n+1)."""
        m = self.frame_multiple
        return max(1, round(duration * self.fps / m)) * m + 1

    def public(self) -> dict:
        return {
            "id": self.id,
            "provider": self.provider,
            "name": self.name,
            "tagline": self.tagline_ar,
            "license": self.license,
            "min_vram_gb": self.min_vram_gb,
            "recommended_vram_gb": self.recommended_vram_gb,
            "fps": self.fps,
            "modes": self.modes,
            "durations": self.durations,
            "resolutions": {
                name: {ratio: list(size) for ratio, size in ratios.items()}
                for name, ratios in self.resolutions.items()
            },
            "default_resolution": self.default_resolution or next(iter(self.resolutions), ""),
            "prompt_language": self.prompt_language,
            "is_demo": self.is_demo,
            "files": [
                {"name": f["name"], "folder": f["folder"], "size_gb": f.get("size_gb"),
                 "url": f.get("url"), "optional": bool(f.get("optional"))}
                for f in self.files
            ],
        }


DEMO_MODEL = ModelSpec(
    id="demo-slideshow",
    provider="mock",
    name="عرض تجريبي (ليس ذكاءً اصطناعيًا)",
    tagline_ar="للاختبار فقط: عرض شرائح بحركة Ken Burns من صورك. لا يولّد فيديو بالذكاء الاصطناعي.",
    license="—",
    fps=25,
    frame_multiple=1,
    expected_seconds=10,
    workflows={"i2v": "", "flf2v": ""},
    resolutions={"720p": {"16:9": [1280, 720], "9:16": [720, 1280], "1:1": [960, 960]}},
    default_resolution="720p",
    is_demo=True,
)


@dataclass
class Registry:
    models: list[ModelSpec]
    default_model: str

    def get(self, model_id: str) -> ModelSpec | None:
        return next((m for m in self.models if m.id == model_id), None)


def load_registry(workflows_dir: Path, include_demo: bool = False) -> Registry:
    path = workflows_dir / "models.json"
    models: list[ModelSpec] = []
    default = ""
    if path.is_file():
        raw = json.loads(path.read_text(encoding="utf-8"))
        default = raw.get("default_model", "")
        allowed = set(ModelSpec.__dataclass_fields__)
        for entry in raw.get("models", []):
            models.append(ModelSpec(**{k: v for k, v in entry.items() if k in allowed}))
    if include_demo:
        models.append(DEMO_MODEL)
    if not default and models:
        default = models[0].id
    return Registry(models=models, default_model=default)
