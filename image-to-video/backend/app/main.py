"""FastAPI video engine: free, self-hosted AI video generation (text-to-video, image-to-video)."""

from __future__ import annotations

import asyncio
import hmac
import logging
import random
import re
import shutil
import time
import uuid
from contextlib import asynccontextmanager, suppress
from typing import Literal

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, field_validator

from .config import Settings, load_settings
from .ffmpeg_utils import find_ffmpeg
from .models_registry import MODE_IMAGE_COUNT, MODE_LABELS_AR, ModelSpec, load_registry
from .providers import build_providers
from .storage import (
    UploadError,
    cleanup_old_files,
    delete_upload,
    is_valid_file_id,
    save_upload,
    upload_path,
)
from .store import GenerationStore
from .worker import GenerationWorker, generation_dir, remove_generation_files

log = logging.getLogger("vesion.engine")

OWNER_RE = re.compile(r"^[a-f0-9]{32}$")
LOCAL_OWNER = "local"
MAX_ACTIVE_PER_OWNER = 8
MAX_QUEUE = 100
STAGE_INFO = {
    "upload": ("رفع الصورة", "أعد رفع الصورة وحاول مرة أخرى."),
    "preprocessing": ("تجهيز الطلب", "ملف سير العمل أو الإعدادات غير صالحة. حدّث المشروع (git pull) وأعد تشغيله."),
    "engine_connection": ("الاتصال بمحرك الذكاء الاصطناعي",
                          "تأكد أن نافذة ComfyUI مفتوحة وتعمل، ثم أعد المحاولة."),
    "model_loading": ("تحميل النموذج",
                      "شغّل install-windows.bat مرة أخرى ليفحص ملفات النموذج ويعيد تنزيل التالف منها."),
    "generation": ("التوليد", "جرّب دقة 480p ومدة 3 ثوانٍ، وأغلق البرامج التي تستخدم كرت الشاشة."),
    "encoding": ("تحويل الفيديو إلى MP4", "أعد المحاولة. إذا تكرر الخطأ أرسل التفاصيل التقنية."),
    "validation": ("التحقق من الفيديو", "الناتج لم يكن فيديو صالحًا. أعد التوليد."),
    "output": ("استلام الناتج", "تأكد أن سير العمل يحتوي على عقدة حفظ، ثم أعد المحاولة."),
}
DEMO_NOTICE = "عرض تجريبي: هذا عرض شرائح بحركة Ken Burns وليس فيديو مولّدًا بالذكاء الاصطناعي."


class GenerationBody(BaseModel):
    model: str | None = Field(default=None, max_length=100)
    mode: Literal["t2v", "i2v", "flf2v"] = "t2v"
    prompt: str = Field(min_length=1, max_length=2000)
    negative_prompt: str = Field(default="", max_length=2000)
    image_ids: list[str] = Field(default_factory=list, max_length=2)
    duration: int = Field(default=5, ge=1, le=20)
    aspect_ratio: Literal["16:9", "9:16", "1:1"] = "16:9"
    resolution: str | None = Field(default=None, max_length=20)
    motion: Literal["low", "medium", "high"] = "medium"
    variations: int = Field(default=1, ge=1, le=8)
    seed: int | None = Field(default=None, ge=0, le=2**32 - 1)

    @field_validator("prompt")
    @classmethod
    def prompt_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("empty prompt")
        return value.strip()


class LegacyGenerateBody(BaseModel):
    """Body of the original /api/generate endpoint (image-to-video only)."""

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
    "image_ids": "الصور",
    "prompt": "البرومبت",
    "negative_prompt": "البرومبت السلبي",
    "duration": "المدة",
    "aspect_ratio": "نسبة الأبعاد",
    "resolution": "الدقة",
    "motion": "قوة الحركة",
    "provider": "المحرك",
    "model": "النموذج",
    "mode": "وضع التوليد",
    "variations": "عدد النسخ",
    "seed": "البذرة (seed)",
}


def _error(status: int, message: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"message": message, **extra})


def create_app(settings: Settings | None = None, comfy_transport=None, use_websocket: bool = True,
               start_worker: bool = True) -> FastAPI:
    settings = settings or load_settings()
    settings.ensure_dirs()
    ffmpeg_path = find_ffmpeg(settings.ffmpeg_path)
    providers = build_providers(settings, ffmpeg_path, comfy_transport, use_websocket)
    registry = load_registry(settings.workflows_dir, include_demo=settings.enable_demo_mode)
    store = GenerationStore(settings.db_path)
    worker = GenerationWorker(store, registry, providers, settings, ffmpeg_path)

    def cleanup_once() -> None:
        cleanup_old_files([settings.upload_dir], settings.file_ttl_hours * 3600)
        cutoff = time.time() - settings.history_ttl_days * 86400
        for generation in store.expired(cutoff):
            remove_generation_files(settings.output_dir, generation["id"])
            store.delete(generation["id"])
        # Orphaned generation folders (e.g. from a crash) and legacy files.
        for path in settings.output_dir.iterdir():
            if path.name == ".gitkeep" or store.get(path.name.split(".")[0]) is not None:
                continue
            if time.time() - path.stat().st_mtime > settings.history_ttl_days * 86400:
                shutil.rmtree(path, ignore_errors=True) if path.is_dir() else path.unlink(missing_ok=True)

    async def cleanup_loop() -> None:
        while True:
            try:
                await asyncio.to_thread(cleanup_once)
            except Exception:  # noqa: BLE001
                log.exception("Cleanup failed")
            await asyncio.sleep(settings.cleanup_interval_minutes * 60)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        recovered = store.recover_interrupted()
        if recovered:
            log.warning("%d generations were interrupted by a restart", recovered)
        if start_worker:
            worker.start()
        task = asyncio.create_task(cleanup_loop())
        yield
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        worker.stop()

    app = FastAPI(title="Vesion Video Engine", version="2.0.0", lifespan=lifespan)
    app.state.settings = settings
    app.state.providers = providers
    app.state.registry = registry
    app.state.store = store
    app.state.worker = worker

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

    # -- auth & ownership -------------------------------------------------
    def require_token(authorization: str | None = Header(default=None)) -> None:
        if not settings.engine_api_token:
            return
        expected = f"Bearer {settings.engine_api_token}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise _error(401, "غير مصرّح: رمز المحرك (ENGINE_API_TOKEN) غير صحيح.")

    def owner_id(x_owner_id: str | None = Header(default=None)) -> str:
        if x_owner_id and OWNER_RE.match(x_owner_id):
            return x_owner_id
        return LOCAL_OWNER

    auth = [Depends(require_token)]

    # -- serialization ----------------------------------------------------
    def public(generation: dict) -> dict:
        gid = generation["id"]
        model = registry.get(generation["model"])
        completed = generation["status"] == "completed"
        has_thumb = completed and (generation_dir(settings.output_dir, gid) / "thumb.jpg").is_file()
        stage = generation.get("error_stage")
        label, hint = STAGE_INFO.get(stage, (None, None)) if generation["status"] == "failed" else (None, None)
        result = generation.get("result") or None
        return {
            "id": gid,
            # True only when the MP4 exists and passed FFmpeg validation.
            "success": completed and result is not None,
            "stage": stage if generation["status"] == "failed" else None,
            "stage_label": label,
            "hint": hint,
            "result": result,
            "filename": result.get("filename") if result else None,
            "batch_id": generation["batch_id"],
            "model": generation["model"],
            "model_name": model.name if model else generation["model"],
            "mode": generation["mode"],
            "mode_label": MODE_LABELS_AR.get(generation["mode"], generation["mode"]),
            "provider": generation["provider"],
            "status": generation["status"],
            "progress": generation["progress"],
            "message": generation["message"],
            "error": generation["error"],
            "error_details": generation["error_details"],
            "setup_steps": generation["setup_steps"],
            "notice": generation["notice"],
            "is_mock": bool(generation["is_demo"]),
            "is_demo": bool(generation["is_demo"]),
            "params": generation["params"],
            "created_at": generation["created_at"],
            "started_at": generation["started_at"],
            "finished_at": generation["finished_at"],
            "queue_position": store.queue_position(generation),
            "video_url": f"/api/generations/{gid}/video" if completed else None,
            "thumbnail_url": f"/api/generations/{gid}/thumbnail" if has_thumb else None,
        }

    def get_owned(generation_id: str, owner: str) -> dict:
        if not is_valid_file_id(generation_id):
            raise _error(400, "معرّف التوليد غير صالح.")
        generation = store.get(generation_id)
        if generation is None or generation["deleted"] or generation["owner"] != owner:
            raise _error(404, "هذا التوليد غير موجود أو تم حذفه.")
        return generation

    def model_availability(model: ModelSpec) -> dict:
        status = providers[model.provider].model_status(model)
        return {"available": status.available, "message": status.message,
                "modes": status.modes, "setup_steps": status.setup_steps}

    def enqueue(owner: str, model: ModelSpec, mode: str, params: dict, source_images: list,
                variations: int, notice: str | None = None) -> dict:
        if store.count_active(owner) + variations > MAX_ACTIVE_PER_OWNER:
            raise _error(429, f"لديك الكثير من الطلبات قيد التنفيذ. انتظر حتى تكتمل (الحد {MAX_ACTIVE_PER_OWNER}).")
        if store.count_active() + variations > MAX_QUEUE:
            raise _error(429, "قائمة الانتظار ممتلئة حاليًا. حاول بعد قليل.")
        batch_id = uuid.uuid4().hex
        base_seed = params.get("seed")
        created = []
        now = time.time()
        for index in range(variations):
            gid = uuid.uuid4().hex
            gdir = generation_dir(settings.output_dir, gid)
            gdir.mkdir(parents=True, exist_ok=True)
            for n, src in enumerate(source_images, start=1):
                shutil.copyfile(src, gdir / f"input_{n}.png")
            seed = (base_seed + index) % 2**32 if base_seed is not None else random.randint(0, 2**32 - 1)
            record = store.create({
                "id": gid, "owner": owner, "batch_id": batch_id, "model": model.id, "mode": mode,
                "provider": model.provider, "is_demo": int(model.is_demo), "notice": notice,
                "params": {**params, "seed": seed, "image_count": len(source_images)},
                "created_at": now + index * 1e-6,
            })
            created.append(record)
        worker.notify()
        return {"batch_id": batch_id, "generations": [public(g) for g in created]}

    def validate_and_resolve(body: GenerationBody) -> tuple[ModelSpec, dict, list]:
        model = registry.get(body.model or registry.default_model)
        if model is None:
            raise _error(404, "النموذج المطلوب غير موجود.")
        if body.mode not in model.modes:
            raise _error(400, f"النموذج {model.name} لا يدعم وضع «{MODE_LABELS_AR[body.mode]}».")
        needed = MODE_IMAGE_COUNT[body.mode]
        if len(body.image_ids) != needed:
            messages = {0: "وضع النص إلى فيديو لا يحتاج صورًا.", 1: "ارفع صورة واحدة لتحريكها.",
                        2: "ارفع صورتين: الإطار الأول والإطار الأخير."}
            raise _error(400, messages[needed])
        if body.duration not in model.durations:
            raise _error(400, "المدة المطلوبة غير مدعومة لهذا النموذج.")
        resolution = body.resolution or model.default_resolution or next(iter(model.resolutions))
        if resolution not in model.resolutions:
            raise _error(400, "الدقة المطلوبة غير مدعومة لهذا النموذج.")
        if body.variations > settings.max_variations:
            raise _error(400, f"الحد الأقصى لعدد النسخ هو {settings.max_variations}.")
        images = []
        for file_id in body.image_ids:
            path = upload_path(settings.upload_dir, file_id)
            if path is None:
                raise _error(404, "إحدى الصور غير موجودة. ربما انتهت صلاحيتها؛ ارفعها مرة أخرى.")
            images.append(path)
        availability = providers[model.provider].model_status(model)
        mode_status = availability.modes.get(body.mode, {})
        if not mode_status.get("available"):
            raise _error(503, availability.message, setup_steps=availability.setup_steps,
                         missing=mode_status.get("missing", []))
        width, height = model.dimensions(resolution, body.aspect_ratio)
        params = {
            "prompt": body.prompt, "negative_prompt": body.negative_prompt, "duration": body.duration,
            "aspect_ratio": body.aspect_ratio, "resolution": resolution, "motion": body.motion,
            "seed": body.seed, "width": width, "height": height, "fps": model.fps,
            "frames": model.frame_count(body.duration),
        }
        return model, params, images

    # -- routes -----------------------------------------------------------
    @app.get("/api/health", dependencies=auth)
    def health():
        comfy = providers["comfyui"].status()
        demo = providers["mock"].status()
        models_ok = any(providers[m.provider].model_status(m).available for m in registry.models if not m.is_demo) \
            if comfy.available else False
        comfy_state = "ok" if comfy.available else (
            "cpu_only" if "CPU" in comfy.message else ("blocked_remote" if "ALLOW_REMOTE" in comfy.message else "down"))
        return {
            "backend": "ok",
            "engine": "ok" if comfy.available and models_ok else "unavailable",
            "comfyui": comfy_state,
            "models": "ok" if models_ok else "missing",
            "status": "ok",
            "engine_detail": {"available": comfy.available, "message": comfy.message,
                              "setup_steps": comfy.setup_steps, "details": comfy.details},
            "demo_mode": settings.enable_demo_mode,
            "free": True,
            "max_upload_mb": settings.max_upload_mb,
            "file_ttl_hours": settings.file_ttl_hours,
            "history_ttl_days": settings.history_ttl_days,
            "max_variations": settings.max_variations,
            "ffmpeg": {"available": bool(ffmpeg_path)},
            # Fields kept for the original React client.
            "default_provider": "auto",
            "providers": {
                "comfyui": {"available": comfy.available, "message": comfy.message,
                            "setup_steps": comfy.setup_steps, "details": comfy.details},
                "mock": {"available": settings.enable_demo_mode and demo.available,
                         "message": demo.message if settings.enable_demo_mode else "العرض التجريبي معطّل.",
                         "setup_steps": demo.setup_steps},
            },
        }

    @app.get("/api/models", dependencies=auth)
    def models():
        return {
            "default_model": registry.default_model,
            "models": [{**m.public(), "availability": model_availability(m)} for m in registry.models],
        }

    @app.post("/api/upload", status_code=201, dependencies=auth)
    def upload(file: UploadFile = File(...)):
        try:
            info = save_upload(file.file, file.filename, file.content_type,
                               settings.upload_dir, settings.max_upload_bytes)
        except UploadError as exc:
            raise _error(exc.status_code, exc.message)
        finally:
            file.file.close()
        return info

    @app.delete("/api/files/{file_id}", dependencies=auth)
    def delete_file(file_id: str):
        if not is_valid_file_id(file_id):
            raise _error(400, "معرّف الملف غير صالح.")
        if not delete_upload(settings.upload_dir, file_id):
            raise _error(404, "الملف غير موجود أو تم حذفه مسبقًا.")
        return {"deleted": True, "file_id": file_id}

    @app.post("/api/generations", status_code=202, dependencies=auth)
    def create_generation(body: GenerationBody, owner: str = Depends(owner_id)):
        model, params, images = validate_and_resolve(body)
        return enqueue(owner, model, body.mode, params, images, body.variations,
                       DEMO_NOTICE if model.is_demo else None)

    @app.get("/api/generations", dependencies=auth)
    def list_generations(owner: str = Depends(owner_id), limit: int = 60, before: float | None = None):
        items = store.list_for_owner(owner, limit=max(1, min(limit, 200)), before=before)
        return {"generations": [public(g) for g in items]}

    @app.get("/api/generations/{generation_id}", dependencies=auth)
    def get_generation(generation_id: str, owner: str = Depends(owner_id)):
        return public(get_owned(generation_id, owner))

    @app.post("/api/generations/{generation_id}/cancel", dependencies=auth)
    def cancel_generation(generation_id: str, owner: str = Depends(owner_id)):
        generation = get_owned(generation_id, owner)
        if generation["status"] == "queued":
            store.update(generation_id, status="cancelled", message="تم إلغاء التوليد.", finished_at=time.time())
        elif generation["status"] == "running":
            store.update(generation_id, cancel_requested=1, message="جارٍ الإلغاء...")
        return public(store.get(generation_id))

    @app.post("/api/generations/{generation_id}/regenerate", status_code=202, dependencies=auth)
    def regenerate(generation_id: str, owner: str = Depends(owner_id)):
        original = get_owned(generation_id, owner)
        model = registry.get(original["model"])
        if model is None:
            raise _error(404, "النموذج المستخدم لم يعد متاحًا.")
        availability = providers[model.provider].model_status(model)
        if not availability.modes.get(original["mode"], {}).get("available"):
            raise _error(503, availability.message, setup_steps=availability.setup_steps)
        gdir = generation_dir(settings.output_dir, generation_id)
        images = [gdir / f"input_{i + 1}.png" for i in range(original["params"].get("image_count", 0))]
        if any(not p.is_file() for p in images):
            raise _error(410, "الصور الأصلية لهذا التوليد لم تعد موجودة.")
        params = {k: v for k, v in original["params"].items() if k != "image_count"}
        params["seed"] = None  # new seed = new variation
        return enqueue(owner, model, original["mode"], params, images, 1, original["notice"])

    @app.delete("/api/generations/{generation_id}", dependencies=auth)
    def delete_generation(generation_id: str, owner: str = Depends(owner_id)):
        generation = get_owned(generation_id, owner)
        if generation["status"] == "running":
            store.update(generation_id, cancel_requested=1, deleted=1)  # worker removes it when it stops
        else:
            remove_generation_files(settings.output_dir, generation_id)
            store.delete(generation_id)
        return {"deleted": True, "id": generation_id}

    def _video_response(generation: dict, download: bool):
        path = generation_dir(settings.output_dir, generation["id"]) / "video.mp4"
        if generation["status"] != "completed" or not path.is_file():
            if generation["status"] in {"queued", "running"}:
                raise _error(409, "الفيديو لم يكتمل بعد.")
            raise _error(404, "الفيديو غير موجود أو تم حذفه.")
        return FileResponse(
            path, media_type="video/mp4",
            filename=f"vesion-video-{generation['id'][:8]}.mp4" if download else None,
            content_disposition_type="attachment" if download else "inline",
        )

    @app.get("/api/generations/{generation_id}/video", dependencies=auth)
    def generation_video(generation_id: str, download: bool = False, owner: str = Depends(owner_id)):
        return _video_response(get_owned(generation_id, owner), download)

    @app.get("/api/generations/{generation_id}/thumbnail", dependencies=auth)
    def generation_thumbnail(generation_id: str, owner: str = Depends(owner_id)):
        get_owned(generation_id, owner)
        path = generation_dir(settings.output_dir, generation_id) / "thumb.jpg"
        if not path.is_file():
            raise _error(404, "لا توجد صورة مصغّرة.")
        return FileResponse(path, media_type="image/jpeg")

    # -- original image-to-video endpoints (used by the React client) ----------
    @app.post("/api/generate", status_code=202, dependencies=auth)
    def legacy_generate(body: LegacyGenerateBody, owner: str = Depends(owner_id)):
        mode = "flf2v" if len(body.image_ids) == 2 else "i2v"
        if body.provider == "mock":
            if not settings.enable_demo_mode:
                raise _error(503, "العرض التجريبي معطّل. فعّله بـ ENABLE_DEMO_MODE=true (ليس ذكاءً اصطناعيًا).")
            candidates = [registry.get("demo-slideshow")]
        else:
            candidates = [m for m in registry.models if not m.is_demo and mode in m.modes]
            if mode == "flf2v":  # fall back to animating the first image
                candidates += [m for m in registry.models if not m.is_demo and "i2v" in m.modes]
        chosen, chosen_mode, last = None, mode, None
        for model in candidates:
            for try_mode in ([mode] if mode in model.modes else ["i2v"]):
                status = providers[model.provider].model_status(model)
                last = status
                if status.modes.get(try_mode, {}).get("available"):
                    chosen, chosen_mode = model, try_mode
                    break
            if chosen:
                break
        if chosen is None:
            message = last.message if last else "لا يوجد نموذج مثبت لتحويل الصور إلى فيديو."
            raise _error(503, message, setup_steps=last.setup_steps if last else [])
        ids = body.image_ids if chosen_mode == "flf2v" or chosen.is_demo else body.image_ids[:1]
        request = GenerationBody(
            model=chosen.id, mode=chosen_mode if not chosen.is_demo else ("flf2v" if len(ids) == 2 else "i2v"),
            prompt=body.prompt, negative_prompt=body.negative_prompt, image_ids=ids, duration=body.duration,
            aspect_ratio=body.aspect_ratio, motion=body.motion, seed=body.seed,
        )
        model, params, images = validate_and_resolve(request)
        result = enqueue(owner, model, request.mode, params, images, 1, DEMO_NOTICE if model.is_demo else None)
        generation = result["generations"][0]
        return {"job_id": generation["id"], "provider": model.provider, "is_mock": model.is_demo,
                "notice": generation["notice"]}

    @app.get("/api/status/{job_id}", dependencies=auth)
    def legacy_status(job_id: str, owner: str = Depends(owner_id)):
        data = public(get_owned(job_id, owner))
        if data["video_url"]:
            data["video_url"] = f"/api/video/{job_id}"
        return data

    @app.get("/api/video/{job_id}", dependencies=auth)
    def legacy_video(job_id: str, download: bool = False, owner: str = Depends(owner_id)):
        return _video_response(get_owned(job_id, owner), download)

    return app


app = create_app()
