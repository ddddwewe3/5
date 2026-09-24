"""FFmpeg helpers: locating the binary, converting outputs to MP4, Ken Burns slideshow."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageSequence


class FFmpegError(Exception):
    pass


def find_ffmpeg(configured: str = "") -> str | None:
    """Return a usable ffmpeg executable: FFMPEG_PATH, then PATH, then the imageio-ffmpeg bundle."""
    if configured:
        return configured if Path(configured).is_file() or shutil.which(configured) else None
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 - package missing or no binary for this platform
        return None


def run_ffmpeg(ffmpeg: str, args: list[str], timeout: float = 600) -> None:
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", *args]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise FFmpegError("FFmpeg timed out") from exc
    except OSError as exc:
        raise FFmpegError(f"Could not start FFmpeg: {exc}") from exc
    if result.returncode != 0:
        raise FFmpegError(result.stderr.strip()[-2000:] or f"FFmpeg exited with {result.returncode}")


MP4_ARGS = [
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    "-an",
]
EVEN_DIMENSIONS = "scale=trunc(iw/2)*2:trunc(ih/2)*2"


def video_to_mp4(ffmpeg: str, src: Path, dst: Path) -> None:
    """Re-encode any FFmpeg-readable video (mp4/webm/gif/mov...) to browser-friendly H.264 MP4."""
    run_ffmpeg(ffmpeg, ["-i", str(src), "-vf", EVEN_DIMENSIONS, *MP4_ARGS, str(dst)])


def frames_to_mp4(ffmpeg: str, frames: list[Path], fps: float, dst: Path) -> None:
    if not frames:
        raise FFmpegError("No frames to encode")
    with tempfile.TemporaryDirectory() as tmp:
        for index, frame in enumerate(frames):
            shutil.copyfile(frame, Path(tmp) / f"frame_{index:05d}{frame.suffix.lower()}")
        suffix = frames[0].suffix.lower()
        run_ffmpeg(
            ffmpeg,
            [
                "-framerate", f"{fps:g}",
                "-i", str(Path(tmp) / f"frame_%05d{suffix}"),
                "-vf", EVEN_DIMENSIONS,
                *MP4_ARGS,
                str(dst),
            ],
        )


def animated_image_to_mp4(ffmpeg: str, src: Path, dst: Path, default_fps: float = 16) -> None:
    """Convert animated WEBP/GIF to MP4. Frames are extracted with Pillow because
    FFmpeg's WEBP decoder does not support animation in many builds."""
    # Encoders merge identical consecutive frames into one longer frame, so each frame
    # is repeated according to its own duration to keep the original timing.
    frame_ms = 1000 / default_fps
    with Image.open(src) as img, tempfile.TemporaryDirectory() as tmp:
        frames: list[Path] = []
        for index, frame in enumerate(ImageSequence.Iterator(img)):
            path = Path(tmp) / f"f_{index:05d}.png"
            frame.convert("RGB").save(path)
            duration = int(frame.info.get("duration") or 0)
            frames += [path] * max(1, round(duration / frame_ms))
        frames_to_mp4(ffmpeg, frames, default_fps, dst)


def convert_to_mp4(ffmpeg: str, src: Path, dst: Path, default_fps: float = 16) -> None:
    suffix = src.suffix.lower()
    if suffix in {".webp", ".gif", ".png", ".apng"}:
        try:
            with Image.open(src) as img:
                animated = getattr(img, "n_frames", 1) > 1
        except OSError:
            animated = False
        if animated or suffix == ".webp":
            animated_image_to_mp4(ffmpeg, src, dst, default_fps)
            return
    video_to_mp4(ffmpeg, src, dst)


# ---------------------------------------------------------------------------
# Mock mode: Ken Burns slideshow (NOT AI video — just zoom/pan over the photos)
# ---------------------------------------------------------------------------

MOTION_ZOOM = {"low": 0.08, "medium": 0.18, "high": 0.32}  # total zoom gained per clip
CROSSFADE_SECONDS = 0.6


def ken_burns_slideshow(
    ffmpeg: str,
    images: list[Path],
    dst: Path,
    duration: float,
    width: int,
    height: int,
    motion: str = "medium",
    fps: int = 25,
) -> None:
    if not images:
        raise FFmpegError("No images")
    count = len(images)
    fade = CROSSFADE_SECONDS if count > 1 else 0.0
    clip_seconds = (duration + fade * (count - 1)) / count
    frames = max(2, round(clip_seconds * fps))
    zoom_total = MOTION_ZOOM.get(motion, MOTION_ZOOM["medium"])
    step = zoom_total / frames

    inputs: list[str] = []
    filters: list[str] = []
    for index, image in enumerate(images):
        inputs += ["-i", str(image)]
        # Alternate direction: first clip zooms in, second zooms out, with a gentle pan.
        if index % 2 == 0:
            zoom = f"min(1+{step:.6f}*on,{1 + zoom_total:.4f})"
            x = "iw/2-(iw/zoom/2)"
        else:
            zoom = f"max({1 + zoom_total:.4f}-{step:.6f}*on,1)"
            x = f"(iw-iw/zoom)*on/{frames}"
        # Upscale first so the zoompan motion is smooth rather than jittery.
        filters.append(
            f"[{index}:v]scale={width * 2}:{height * 2}:force_original_aspect_ratio=increase,"
            f"crop={width * 2}:{height * 2},setsar=1,"
            f"zoompan=z='{zoom}':x='{x}':y='ih/2-(ih/zoom/2)':d={frames}:s={width}x{height}:fps={fps},"
            f"format=yuv420p,setsar=1[v{index}]"
        )

    if count == 1:
        final = "v0"
    else:
        offset = clip_seconds - fade
        filters.append(
            f"[v0][v1]xfade=transition=fade:duration={fade}:offset={offset:.3f}[vout]"
        )
        final = "vout"

    run_ffmpeg(
        ffmpeg,
        [
            *inputs,
            "-filter_complex", ";".join(filters),
            "-map", f"[{final}]",
            "-t", f"{duration:g}",
            "-r", str(fps),
            *MP4_ARGS,
            str(dst),
        ],
    )


def make_thumbnail(ffmpeg: str, video: Path, dst: Path, width: int = 480) -> None:
    """Poster image for the history grid (first frames can be black, so seek slightly in)."""
    for seek in ("0.4", "0"):
        try:
            run_ffmpeg(ffmpeg, ["-ss", seek, "-i", str(video), "-frames:v", "1",
                                "-vf", f"scale={width}:-2", "-q:v", "4", str(dst)], timeout=60)
        except FFmpegError:
            continue
        if dst.is_file() and dst.stat().st_size > 0:
            return
    raise FFmpegError("Could not create thumbnail")
