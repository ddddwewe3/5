"""Background worker: takes queued generations from the store and runs them one at a time
(or MAX_CONCURRENT_JOBS at a time) on the model's provider."""

from __future__ import annotations

import logging
import shutil
import threading
import time
from pathlib import Path

from .ffmpeg_utils import FFmpegError, make_thumbnail
from .models_registry import Registry
from .providers import (
    GenerationCancelled,
    GenerationError,
    GenerationRequest,
    ProviderUnavailable,
    VideoProvider,
)
from .store import GenerationStore

log = logging.getLogger("vesion.engine.worker")


def generation_dir(output_dir: Path, generation_id: str) -> Path:
    return output_dir / generation_id


def remove_generation_files(output_dir: Path, generation_id: str) -> None:
    shutil.rmtree(generation_dir(output_dir, generation_id), ignore_errors=True)


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

    def run(self, generation: dict) -> None:
        gid = generation["id"]
        gdir = generation_dir(self.settings.output_dir, gid)
        work_dir = gdir / "work"
        output_path = gdir / "video.mp4"
        params = generation["params"]
        last = {"progress": -1, "message": "", "at": 0.0}

        def progress(fraction: float, message: str) -> None:
            percent = max(1, min(99, int(fraction * 100)))
            now = time.monotonic()
            if percent == last["progress"] and message == last["message"]:
                return
            if percent == last["progress"] and now - last["at"] < 1:
                return
            last.update(progress=percent, message=message, at=now)
            self.store.update(gid, progress=percent, message=message)

        def should_cancel() -> bool:
            current = self.store.get(gid)
            return current is None or bool(current["cancel_requested"])

        try:
            model = self.registry.get(generation["model"])
            if model is None:
                raise GenerationError("النموذج المطلوب لم يعد موجودًا في قائمة النماذج.")
            provider = self.providers[model.provider]
            images = [gdir / f"input_{i + 1}.png" for i in range(params.get("image_count", 0))]
            if any(not path.is_file() for path in images):
                raise GenerationError("الصور الأصلية لهذا التوليد لم تعد موجودة.")
            request = GenerationRequest(
                model=model, mode=generation["mode"], image_paths=images,
                prompt=params["prompt"], negative_prompt=params.get("negative_prompt", ""),
                duration=params["duration"], aspect_ratio=params["aspect_ratio"],
                resolution=params["resolution"], motion=params.get("motion", "medium"),
                seed=params["seed"], output_path=output_path, work_dir=work_dir, job_id=gid,
            )
            gdir.mkdir(parents=True, exist_ok=True)
            provider.generate(request, progress, should_cancel)
            if not output_path.is_file() or output_path.stat().st_size == 0:
                raise GenerationError("لم يتم إنشاء ملف الفيديو.")
            if self.ffmpeg_path:
                try:
                    make_thumbnail(self.ffmpeg_path, output_path, gdir / "thumb.jpg")
                except FFmpegError:
                    log.warning("Thumbnail failed for %s", gid)
            self.store.update(gid, status="completed", progress=100, message="اكتمل الفيديو.",
                              finished_at=time.time())
        except GenerationCancelled:
            self.store.update(gid, status="cancelled", message="تم إلغاء التوليد.", finished_at=time.time())
        except ProviderUnavailable as exc:
            self.store.update(gid, status="failed", error=exc.message, setup_steps=exc.setup_steps,
                              message="محرك الذكاء الاصطناعي غير متاح.", finished_at=time.time())
        except GenerationError as exc:
            log.warning("Generation %s failed: %s %s", gid, exc.message, exc.details[:500])
            self.store.update(gid, status="failed", error=exc.message, error_details=exc.details or None,
                              message="فشل التوليد.", finished_at=time.time())
        except Exception as exc:  # noqa: BLE001
            log.exception("Generation %s crashed", gid)
            self.store.update(gid, status="failed", error="حدث خطأ غير متوقع أثناء التوليد.",
                              error_details=str(exc)[:2000], message="فشل التوليد.", finished_at=time.time())
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
            current = self.store.get(gid)
            if current is None or current["deleted"]:
                remove_generation_files(self.settings.output_dir, gid)
                self.store.delete(gid)
