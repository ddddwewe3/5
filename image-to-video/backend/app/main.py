"""FastAPI application: local image-to-video generation."""

from __future__ import annotations

import asyncio
import logging
import random
from contextlib import asynccontextmanager, suppress
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, field_validator

from .config import Settings, load_settings
from .ffmpeg_utils import find_ffmpeg
from .jobs import JobManager
from .providers import GenerationRequest, build_providers
from .storage import (
    UploadError,
    cleanup_old_files,
    delete_upload,
    is_valid_file_id,
    save_upload,
    upload_path,
)

log = logging.getLogger("image2video")


class GenerateBody(BaseModel):
    image_ids: list[str] = Field(min_length=1, max_length=2)
    prompt: str = Field(min_length=1, max_length=2000)
    negative_prompt: str = Field(default="", max_length=2000)
    duration: Literal[3, 5, 8] = 5
    aspect_ratio: Literal["9:16", "16:9", "1:1"] = "9:16"
    motion: Literal["low", "medium", "high"] = "medium"
    provider: Literal["auto", "comfyui", "mock"] = "auto"
    seed: int | None = Field(default=None, ge=0, le=2**32 - 1)

    @field_validator("prompt")
    @classmethod
    def prompt_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("empty prompt")
        return value.strip()


FIELD_NAMES_AR = {
    "image_ids": "الصور (صورة واحدة أو صورتان)",
    "prompt": "البرومبت",
    "negative_prompt": "البرومبت السلبي",
    "duration": "المدة (3 أو 5 أو 8 ثوانٍ)",
    "aspect_ratio": "نسبة الأبعاد",
    "motion": "قوة الحركة",
    "provider": "المحرك",
    "seed": "البذرة (seed)",
}


def _error(status: int, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"message": message, **extra})


def create_app(settings: Settings | None = None, comfy_transport=None) -> FastAPI:
    settings = settings or load_settings()
    settings.ensure_dirs()
    ffmpeg_path = find_ffmpeg(settings.ffmpeg_path)
    providers = build_providers(settings, ffmpeg_path, comfy_transport)
    jobs = JobManager(settings.max_concurrent_jobs)

    async def cleanup_loop() -> None:
        ttl = settings.file_ttl_hours * 3600
        while True:
            try:
                removed = await asyncio.to_thread(
                    cleanup_old_files, [settings.upload_dir, settings.output_dir], ttl
                )
                jobs.forget_older_than(ttl)
                if removed:
                    log.info("Cleanup removed %d expired files", removed)
            except Exception:  # noqa: BLE001
                log.exception("Cleanup failed")
            await asyncio.sleep(settings.cleanup_interval_minutes * 60)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        task = asyncio.create_task(cleanup_loop())
        yield
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        jobs.shutdown()

    app = FastAPI(title="Local Image-to-Video", version="1.0.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.providers = providers
    app.state.jobs = jobs
    app.state.ffmpeg_path = ffmpeg_path

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["*"],
    )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_request: Request, exc: RequestValidationError):
        fields = []
        for err in exc.errors():
            loc = [str(p) for p in err.get("loc", []) if p not in ("body", "query", "path")]
            if loc:
                fields.append(FIELD_NAMES_AR.get(loc[0], loc[0]))
        message = "بيانات الطلب غير صالحة"
        if fields:
            message += ": " + "، ".join(dict.fromkeys(fields))
        return JSONResponse(status_code=422, content={"detail": {"message": message}})

    @app.get("/api/health")
    def health():
        comfy = providers["comfyui"].status()
        mock = providers["mock"].status()
        return {
            "status": "ok",
            "default_provider": settings.video_provider,
            "ffmpeg": {"available": bool(ffmpeg_path)},
            "max_upload_mb": settings.max_upload_mb,
            "file_ttl_hours": settings.file_ttl_hours,
            "providers": {
                "comfyui": {
                    "available": comfy.available,
                    "message": comfy.message,
                    "setup_steps": comfy.setup_steps,
                    "details": comfy.details,
                },
                "mock": {"available": mock.available, "message": mock.message, "setup_steps": mock.setup_steps},
            },
        }

    @app.post("/api/upload", status_code=201)
    def upload(file: UploadFile = File(...)):
        try:
            info = save_upload(file.file, file.filename, file.content_type,
                               settings.upload_dir, settings.max_upload_bytes)
        except UploadError as exc:
            raise _error(exc.status_code, exc.message)
        finally:
            file.file.close()
        return info

    @app.delete("/api/files/{file_id}")
    def delete_file(file_id: str):
        if not is_valid_file_id(file_id):
            raise _error(400, "معرّف الملف غير صالح.")
        if not delete_upload(settings.upload_dir, file_id):
            raise _error(404, "الملف غير موجود أو تم حذفه مسبقًا.")
        return {"deleted": True, "file_id": file_id}

    def _choose_provider(requested: str):
        choice = settings.video_provider if requested == "auto" else requested
        if choice == "mock":
            provider = providers["mock"]
            status = provider.status()
            if not status.available:
                raise _error(503, status.message, setup_steps=status.setup_steps)
            return provider, "وضع المعاينة: هذا عرض شرائح بحركة Ken Burns وليس فيديو مولّدًا بالذكاء الاصطناعي."
        comfy_status = providers["comfyui"].status()
        if comfy_status.available:
            return providers["comfyui"], None
        if choice == "comfyui":
            raise _error(503, comfy_status.message, setup_steps=comfy_status.setup_steps)
        # auto: fall back to mock so the UI stays testable
        mock_status = providers["mock"].status()
        if not mock_status.available:
            raise _error(503, comfy_status.message, setup_steps=comfy_status.setup_steps + mock_status.setup_steps)
        return providers["mock"], (
            "ComfyUI غير متاح، لذلك تم استخدام وضع المعاينة: عرض شرائح بحركة Ken Burns "
            "وليس فيديو مولّدًا بالذكاء الاصطناعي."
        )

    @app.post("/api/generate", status_code=202)
    def generate(body: GenerateBody):
        paths = []
        for file_id in body.image_ids:
            path = upload_path(settings.upload_dir, file_id)
            if path is None:
                raise _error(404, "إحدى الصور غير موجودة. ربما انتهت صلاحيتها؛ ارفعها مرة أخرى.")
            paths.append(path)

        provider, notice = _choose_provider(body.provider)
        job = jobs.create(provider, notice)
        request = GenerationRequest(
            image_paths=paths,
            prompt=body.prompt,
            negative_prompt=body.negative_prompt,
            duration=body.duration,
            aspect_ratio=body.aspect_ratio,
            motion=body.motion,
            seed=body.seed if body.seed is not None else random.randint(0, 2**32 - 1),
            output_path=settings.output_dir / f"{job.id}.mp4",
            work_dir=settings.output_dir / f"tmp_{job.id}",
            job_id=job.id,
        )
        jobs.submit(job, provider, request)
        return {"job_id": job.id, "provider": provider.name, "is_mock": provider.is_mock, "notice": notice}

    @app.get("/api/status/{job_id}")
    def status(job_id: str):
        if not is_valid_file_id(job_id):
            raise _error(400, "معرّف المهمة غير صالح.")
        job = jobs.get(job_id)
        if job is None:
            if (settings.output_dir / f"{job_id}.mp4").is_file():
                return {"id": job_id, "status": "completed", "progress": 100, "message": "اكتمل الفيديو.",
                        "video_url": f"/api/video/{job_id}", "error": None}
            raise _error(404, "المهمة غير موجودة أو انتهت صلاحيتها.")
        return job.public()

    @app.get("/api/video/{job_id}")
    def video(job_id: str, download: bool = False):
        if not is_valid_file_id(job_id):
            raise _error(400, "معرّف المهمة غير صالح.")
        path = settings.output_dir / f"{job_id}.mp4"
        if not path.is_file():
            job = jobs.get(job_id)
            if job and job.status in {"queued", "running"}:
                raise _error(409, "الفيديو لم يكتمل بعد.")
            raise _error(404, "الفيديو غير موجود أو تم حذفه تلقائيًا.")
        return FileResponse(
            path,
            media_type="video/mp4",
            filename=f"video-{job_id[:8]}.mp4" if download else None,
            content_disposition_type="attachment" if download else "inline",
        )

    return app


app = create_app()
