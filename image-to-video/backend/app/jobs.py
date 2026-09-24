"""In-memory background job tracking for video generation."""

from __future__ import annotations

import logging
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from typing import Callable

from .providers import GenerationError, GenerationRequest, ProviderUnavailable, VideoProvider

log = logging.getLogger("image2video.jobs")


@dataclass
class Job:
    id: str
    provider: str
    is_mock: bool
    status: str = "queued"  # queued | running | completed | failed
    progress: int = 0
    message: str = "في قائمة الانتظار..."
    error: str | None = None
    error_details: str | None = None
    setup_steps: list[str] = field(default_factory=list)
    notice: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def public(self) -> dict:
        data = asdict(self)
        data["video_url"] = f"/api/video/{self.id}" if self.status == "completed" else None
        return data


class JobManager:
    def __init__(self, max_workers: int = 1):
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="video-job")

    def create(self, provider: VideoProvider, notice: str | None = None) -> Job:
        job = Job(id=uuid.uuid4().hex, provider=provider.name, is_mock=provider.is_mock, notice=notice)
        with self._lock:
            self._jobs[job.id] = job
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def update(self, job_id: str, **changes) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return
            for key, value in changes.items():
                setattr(job, key, value)
            job.updated_at = time.time()

    def submit(self, job: Job, provider: VideoProvider, request: GenerationRequest,
               on_done: Callable[[Job], None] | None = None):
        return self._executor.submit(self._run, job, provider, request, on_done)

    def _run(self, job: Job, provider: VideoProvider, request: GenerationRequest, on_done) -> None:
        def progress(fraction: float, message: str) -> None:
            percent = max(1, min(99, int(fraction * 100)))
            self.update(job.id, progress=percent, message=message)

        self.update(job.id, status="running", progress=1, message="بدأ التوليد...")
        try:
            request.output_path.parent.mkdir(parents=True, exist_ok=True)
            provider.generate(request, progress)
            if not request.output_path.is_file() or request.output_path.stat().st_size == 0:
                raise GenerationError("لم يتم إنشاء ملف الفيديو.")
            self.update(job.id, status="completed", progress=100, message="اكتمل الفيديو.")
        except ProviderUnavailable as exc:
            self.update(job.id, status="failed", error=exc.message, setup_steps=exc.setup_steps,
                        message="المحرك غير متاح.")
        except GenerationError as exc:
            log.warning("Job %s failed: %s %s", job.id, exc.message, exc.details)
            self.update(job.id, status="failed", error=exc.message, error_details=exc.details or None,
                        message="فشل التوليد.")
        except Exception as exc:  # noqa: BLE001 - never let a job crash silently
            log.exception("Job %s crashed", job.id)
            self.update(job.id, status="failed", error="حدث خطأ غير متوقع أثناء التوليد.",
                        error_details=str(exc)[:2000], message="فشل التوليد.")
        finally:
            shutil.rmtree(request.work_dir, ignore_errors=True)
            if on_done:
                on_done(self.get(job.id))

    def forget_older_than(self, max_age_seconds: float) -> int:
        cutoff = time.time() - max_age_seconds
        with self._lock:
            stale = [jid for jid, job in self._jobs.items()
                     if job.updated_at < cutoff and job.status in {"completed", "failed"}]
            for jid in stale:
                del self._jobs[jid]
        return len(stale)

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
