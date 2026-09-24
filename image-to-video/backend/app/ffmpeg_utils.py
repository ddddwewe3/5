"""FFmpeg helpers: locating the binary, converting outputs to MP4, Ken Burns slideshow."""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageSequence, ImageStat


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


class VideoValidationError(FFmpegError):
    pass


def probe_video(ffmpeg: str, path: Path, timeout: float = 300) -> dict:
    """Validate a generated MP4 by decoding it completely with FFmpeg.

    Returns {width, height, duration, frames, size_bytes, codec}. Raises VideoValidationError when
    the file is missing/empty, has no video stream, cannot be decoded, is too short, or is frozen
    (first and last frames identical — a still image, not a video).
    """
    if not path.is_file() or path.stat().st_size == 0:
        raise VideoValidationError("Output file is missing or empty")
    cmd = [ffmpeg, "-hide_banner", "-nostdin", "-i", str(path), "-map", "0:v:0", "-f", "null", "-"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError) as exc:
        raise VideoValidationError(f"Could not decode video: {exc}") from exc
    log = result.stderr
    if result.returncode != 0:
        raise VideoValidationError(log.strip()[-1500:] or "FFmpeg could not decode the file")
    stream = re.search(r"Stream #\S+.*?Video: (\w+).*?, (\d{2,5})x(\d{2,5})", log)
    if not stream:
        raise VideoValidationError("No video stream found in the file")
    duration_match = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", log)
    duration = 0.0
    if duration_match:
        h, m, sec = duration_match.groups()
        duration = int(h) * 3600 + int(m) * 60 + float(sec)
    frames_match = re.findall(r"frame=\s*(\d+)", log)
    frames = int(frames_match[-1]) if frames_match else 0
    info = {
        "codec": stream.group(1),
        "width": int(stream.group(2)),
        "height": int(stream.group(3)),
        "duration": round(duration, 3),
        "frames": frames,
        "size_bytes": path.stat().st_size,
    }
    if info["width"] < 16 or info["height"] < 16:
        raise VideoValidationError(f"Invalid resolution {info['width']}x{info['height']}")
    if frames < 2 or duration < 0.2:
        raise VideoValidationError(f"Video too short ({frames} frames, {duration:.2f}s)")
    if _is_frozen(ffmpeg, path, duration):
        raise VideoValidationError("First and last frames are identical: the output is a still image, not motion")
    return info


def _is_frozen(ffmpeg: str, path: Path, duration: float) -> bool:
    with tempfile.TemporaryDirectory() as tmp:
        first, last = Path(tmp) / "first.png", Path(tmp) / "last.png"
        try:
            run_ffmpeg(ffmpeg, ["-i", str(path), "-frames:v", "1", "-vf", "scale=64:-2", str(first)], timeout=60)
            run_ffmpeg(ffmpeg, ["-ss", f"{max(0.0, duration - 0.15):.3f}", "-i", str(path), "-frames:v", "1",
                                "-vf", "scale=64:-2", str(last)], timeout=60)
        except FFmpegError:
            return False  # decoding already succeeded; don't fail on the comparison itself
        if not first.is_file() or not last.is_file():
            return False
        with Image.open(first) as a, Image.open(last) as b:
            a, b = a.convert("L"), b.convert("L").resize(a.size)
            diff = ImageStat.Stat(ImageChops.difference(a, b)).mean[0]
        return diff < 0.05
