"""Demo provider: a Ken Burns slideshow made with FFmpeg.

This is NOT AI video generation. It only zooms/pans over the uploaded photos so the
interface can be tested end-to-end without a GPU. It is disabled unless ENABLE_DEMO_MODE=true.
"""

from __future__ import annotations

from ..ffmpeg_utils import FFmpegError, ken_burns_slideshow
from .base import (
    CancelCheck,
    GenerationError,
    GenerationRequest,
    ModelAvailability,
    ProgressCallback,
    ProviderStatus,
    VideoProvider,
)


class MockProvider(VideoProvider):
    name = "mock"
    is_mock = True

    def __init__(self, ffmpeg_path: str | None):
        self.ffmpeg_path = ffmpeg_path

    def status(self) -> ProviderStatus:
        if not self.ffmpeg_path:
            return ProviderStatus(
                name=self.name, available=False, is_mock=True,
                message="FFmpeg غير متوفر، لذا لا يعمل العرض التجريبي.",
                setup_steps=["pip install imageio-ffmpeg أو ثبّت FFmpeg وأضفه إلى PATH"],
            )
        return ProviderStatus(
            name=self.name, available=True, is_mock=True,
            message="عرض تجريبي: شرائح بحركة Ken Burns، وليس فيديو مولّدًا بالذكاء الاصطناعي.",
        )

    def model_status(self, model) -> ModelAvailability:
        status = self.status()
        modes = {mode: {"available": status.available, "missing": []} for mode in model.modes}
        return ModelAvailability(status.available, status.message, modes, status.setup_steps)

    def generate(self, request: GenerationRequest, progress: ProgressCallback,
                 should_cancel: CancelCheck = lambda: False) -> None:
        if not self.ffmpeg_path:
            raise GenerationError("FFmpeg غير متوفر، لذا لا يعمل العرض التجريبي.")
        if not request.image_paths:
            raise GenerationError("العرض التجريبي يحتاج صورة واحدة على الأقل.")
        progress(0.1, "جارٍ تجهيز العرض التجريبي (ليس ذكاءً اصطناعيًا)...")
        try:
            ken_burns_slideshow(
                self.ffmpeg_path,
                request.image_paths,
                request.output_path,
                duration=request.duration,
                width=request.width,
                height=request.height,
                motion=request.motion,
            )
        except FFmpegError as exc:
            raise GenerationError("فشل FFmpeg في إنشاء العرض التجريبي.", str(exc)) from exc
        progress(1.0, "اكتمل العرض التجريبي.")
