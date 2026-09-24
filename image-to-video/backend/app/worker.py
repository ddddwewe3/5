"""Background worker: takes queued generations from the store and runs them one at a time
(or MAX_CONCURRENT_JOBS at a time) on the model's provider.

A generation only becomes "completed" after the MP4 was produced by the AI engine and validated
with FFmpeg. When the GPU runs out of memory (or a model file cannot be loaded) the worker retries
with lighter real settings — lower resolution, shorter duration, then another installed model —
and records every change in the generation's notice.
"""

from __future__ import annotations

import logging
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from .ffmpeg_utils import FFmpegError, VideoValidationError, make_thumbnail, probe_video
from .models_registry import ModelSpec, Registry
from .providers import (
    GenerationCancelled,
    GenerationError,
    GenerationRequest,
    ModelLoadError,
    OutOfVRAMError,
    ProviderUnavailable,
    VideoProvider,
)
from .store import GenerationStore

log = logging.getLogger("vesion.engine.worker")

MAX_ATTEMPTS = 4


def generation_dir(output_dir: Path, generation_id: str) -> Path:
    return output_dir / generation_id


def remove_generation_files(output_dir: Path, generation_id: str) -> None:
    shutil.rmtree(generation_dir(output_dir, generation_id), ignore_errors=True)


@dataclass(frozen=True)
class Attempt:
    model: ModelSpec
    resolution: str
    duration: int

    @property
    def key(self) -> tuple[str, str, int]:
        return (self.model.id, self.resolution, self.duration)

    def describe(self) -> str:
        return f"{self.model.name} · {self.resolution} · {self.duration} ثوانٍ"


def _pixels(model: ModelSpec, resolution: str) -> int:
    width, height = next(iter(model.resolutions[resolution].values()))
    return width * height


class GenerationWorker:
    def __init__(self, store: GenerationStore, registry: Registry, providers: dict[str, VideoProvider],
                 settings, ffmpeg_path: str | None):
        self.store = store
        self.registry = registry
        self.providers = providers
        self.settings = settings
        self.ffmpeg_path = ffmpeg_path
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        for index in range(self.settings.max_concurrent_jobs):
            thread = threading.Thread(target=self._loop, name=f"generation-worker-{index}", daemon=True)
            thread.start()
            self._threads.append(thread)

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def notify(self) -> None:
        self._wake.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            generation = self.store.claim_next()
            if generation is None:
                self._wake.wait(timeout=2)
                self._wake.clear()
                continue
            try:
                self.run(generation)
            except Exception:  # noqa: BLE001 - the loop must survive anything
                log.exception("Worker crashed on %s", generation["id"])

    # -- fallback planning ---------------------------------------------------
    def _usable(self, model: ModelSpec, mode: str) -> bool:
        if model.is_demo or mode not in model.modes:
            return False
        status = self.providers[model.provider].model_status(model)
        return bool(status.modes.get(mode, {}).get("available"))

    def _lighter(self, attempt: Attempt, mode: str, error: GenerationError, tried: set[tuple]) -> Attempt | None:
        """Next real (AI) attempt with lighter settings, or None when nothing lighter is left."""
        model = attempt.model
        candidates: list[Attempt] = []
        if isinstance(error, OutOfVRAMError):
            lower = sorted((r for r in model.resolutions if _pixels(model, r) < _pixels(model, attempt.resolution)),
                           key=lambda r: _pixels(model, r), reverse=True)
            candidates += [Attempt(model, r, attempt.duration) for r in lower]
            shortest = min(model.durations)
            if shortest < attempt.duration:
                lowest = min(model.resolutions, key=lambda r: _pixels(model, r))
                candidates.append(Attempt(model, lowest, shortest))
        # Another installed model (lowest settings) for out-of-memory and model-loading failures.
        if isinstance(error, (OutOfVRAMError, ModelLoadError)):
            for other in self.registry.models:
                if other.id != model.id and self._usable(other, mode):
                    lowest = min(other.resolutions, key=lambda r: _pixels(other, r))
                    duration = attempt.duration if attempt.duration in other.durations else min(other.durations)
                    if isinstance(error, OutOfVRAMError):
                        duration = min(duration, min(other.durations))
                    candidates.append(Attempt(other, lowest, duration))
        return next((c for c in candidates if c.key not in tried), None)

    # -- one generation ------------------------------------------------------
    def run(self, generation: dict) -> None:
        gid = generation["id"]
        gdir = generation_dir(self.settings.output_dir, gid)
        work_dir = gdir / "work"
        output_path = gdir / "video.mp4"
        params = dict(generation["params"])
        mode = generation["mode"]
        last = {"progress": -1, "message": "", "at": 0.0}
        notices: list[str] = [generation["notice"]] if generation["notice"] else []

        def progress(fraction: float, message: str) -> None:
            percent = max(1, min(99, int(fraction * 100)))
            now = time.monotonic()
            if percent == last["progress"] and (message == last["message"] or now - last["at"] < 1):
                return
            last.update(progress=percent, message=message, at=now)
            self.store.update(gid, progress=percent, message=message)

        def should_cancel() -> bool:
            current = self.store.get(gid)
            return current is None or bool(current["cancel_requested"])

        def fail(message: str, stage: str, details: str | None = None, steps: list[str] | None = None) -> None:
            log.warning("Generation %s failed at %s: %s %s", gid, stage, message, (details or "")[:500])
            self.store.update(gid, status="failed", error=message, error_stage=stage, error_details=details or None,
                              setup_steps=steps or [], message="فشل التوليد.", finished_at=time.time(),
                              notice=" ".join(notices) or None)

        try:
            model = self.registry.get(generation["model"])
            if model is None:
                raise GenerationError("النموذج المطلوب لم يعد موجودًا في قائمة النماذج.", stage="preprocessing")
            images = [gdir / f"input_{i + 1}.png" for i in range(params.get("image_count", 0))]
            if any(not path.is_file() for path in images):
                raise GenerationError("الصور الأصلية لهذا التوليد لم تعد موجودة.", stage="upload")
            if not self.ffmpeg_path:
                raise GenerationError("FFmpeg غير متوفر للتحقق من الفيديو.", stage="validation")
            gdir.mkdir(parents=True, exist_ok=True)

            attempt = Attempt(model, params["resolution"], params["duration"])
            tried: set[tuple] = set()
            for number in range(1, MAX_ATTEMPTS + 1):
                tried.add(attempt.key)
                request = GenerationRequest(
                    model=attempt.model, mode=mode, image_paths=images,
                    prompt=params["prompt"], negative_prompt=params.get("negative_prompt", ""),
                    duration=attempt.duration, aspect_ratio=params["aspect_ratio"],
                    resolution=attempt.resolution, motion=params.get("motion", "medium"),
                    seed=params["seed"], output_path=output_path, work_dir=work_dir, job_id=gid,
                )
                output_path.unlink(missing_ok=True)
                log.info("Generation %s attempt %d: %s", gid, number, attempt.describe())
                try:
                    self.providers[attempt.model.provider].generate(request, progress, should_cancel)
                    break
                except (OutOfVRAMError, ModelLoadError) as exc:
                    lighter = self._lighter(attempt, mode, exc, tried) if number < MAX_ATTEMPTS else None
                    if lighter is None:
                        raise
                    reason = "ذاكرة كرت الشاشة لم تكفِ" if isinstance(exc, OutOfVRAMError) else "تعذّر تحميل النموذج"
                    notices.append(f"{reason} لـ {attempt.describe()}، فأُعيد التوليد تلقائيًا بـ {lighter.describe()}.")
                    progress(0.03, f"{reason}. إعادة المحاولة بإعدادات أخف: {lighter.describe()}...")
                    shutil.rmtree(work_dir, ignore_errors=True)
                    attempt = lighter

            # The file must be a real, decodable, moving video before we call it a success.
            progress(0.97, "جارٍ التحقق من ملف الفيديو...")
            try:
                info = probe_video(self.ffmpeg_path, output_path)
            except VideoValidationError as exc:
                raise GenerationError("ملف الفيديو الناتج غير صالح، لذلك لم يُعتبر التوليد ناجحًا.", str(exc),
                                      stage="validation") from exc
            try:
                make_thumbnail(self.ffmpeg_path, output_path, gdir / "thumb.jpg")
            except FFmpegError:
                log.warning("Thumbnail failed for %s", gid)

            final_params = params
            if attempt.model.id != model.id or attempt.resolution != params["resolution"] \
                    or attempt.duration != params["duration"]:
                width, height = attempt.model.dimensions(attempt.resolution, params["aspect_ratio"])
                final_params = {**params, "resolution": attempt.resolution, "duration": attempt.duration,
                                "width": width, "height": height, "fps": attempt.model.fps,
                                "frames": attempt.model.frame_count(attempt.duration)}
            self.store.update(gid, status="completed", progress=100, message="اكتمل الفيديو.",
                              model=attempt.model.id, params=final_params, finished_at=time.time(),
                              notice=" ".join(notices) or None,
                              result={**info, "filename": f"vesion-video-{gid[:8]}.mp4"})
            log.info("Generation %s completed: %s", gid, info)
        except GenerationCancelled:
            self.store.update(gid, status="cancelled", message="تم إلغاء التوليد.", finished_at=time.time())
        except ProviderUnavailable as exc:
            fail(exc.message, exc.stage, steps=exc.setup_steps)
        except GenerationError as exc:
            fail(exc.message, exc.stage, exc.details)
        except Exception as exc:  # noqa: BLE001
            log.exception("Generation %s crashed", gid)
            fail("حدث خطأ غير متوقع أثناء التوليد.", "generation", str(exc)[:2000])
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
            current = self.store.get(gid)
            if current is None or current["deleted"]:
                remove_generation_files(self.settings.output_dir, gid)
                self.store.delete(gid)
            elif current["status"] != "completed":
                output_path.unlink(missing_ok=True)  # never leave an unvalidated video behind
