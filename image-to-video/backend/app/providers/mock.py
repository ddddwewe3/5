"""Mock provider: a Ken Burns slideshow made with FFmpeg.

This is NOT AI video generation. It only zooms/pans over the uploaded photos so the
interface can be tested end-to-end without a GPU or an AI model.
"""

from __future__ import annotations

from ..ffmpeg_utils import FFmpegError, ken_burns_slideshow
from .base import GenerationError, GenerationRequest, ProgressCallback, ProviderStatus, VideoProvider

MOCK_RESOLUTIONS = {"9:16": (720, 1280), "16:9": (1280, 720), "1:1": (960, 960)}


class MockProvider(VideoProvider):
    name = "mock"
    is_mock = True

    def __init__(self, ffmpeg_path: str | None):
        self.ffmpeg_path = ffmpeg_path

    def status(self) -> ProviderStatus:
        if not self.ffmpeg_path:
            return ProviderStatus(
                name=self.name,
                available=False,
                is_mock=True,
                message="FFmpeg غير متوفر، لذا لا يعمل وضع المعاينة.",
                setup_steps=[
                    "ثبّت الحزمة imageio-ffmpeg عبر: pip install imageio-ffmpeg",
                    "أو ثبّت FFmpeg وأضفه إلى PATH، أو حدّد مساره في FFMPEG_PATH داخل ملف .env",
                ],
            )
        return ProviderStatus(
            name=self.name,
            available=True,
            is_mock=True,
            message="وضع المعاينة: عرض شرائح بحركة Ken Burns، وليس فيديو مولّدًا بالذكاء الاصطناعي.",
        )

    def generate(self, request: GenerationRequest, progress: ProgressCallback) -> None:
        if not self.ffmpeg_path:
            raise GenerationError("FFmpeg غير متوفر، لذا لا يعمل وضع المعاينة.")
        width, height = MOCK_RESOLUTIONS[request.aspect_ratio]
        progress(0.1, "جارٍ تجهيز عرض الشرائح التجريبي...")
        try:
            ken_burns_slideshow(
                self.ffmpeg_path,
                request.image_paths,
                request.output_path,
                duration=request.duration,
                width=width,
                height=height,
                motion=request.motion,
            )
        except FFmpegError as exc:
            raise GenerationError("فشل FFmpeg في إنشاء الفيديو التجريبي.", str(exc)) from exc
        progress(1.0, "اكتمل الفيديو التجريبي.")
