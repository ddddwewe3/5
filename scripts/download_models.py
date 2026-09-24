#!/usr/bin/env python3
"""Download the free, open-source model files a video model needs into a ComfyUI install.

Uses only the Python standard library. Downloads resume if interrupted.

  python scripts/download_models.py --list
  python scripts/download_models.py --comfyui ~/ComfyUI                      # default model (Wan 2.2 5B)
  python scripts/download_models.py --comfyui ~/ComfyUI --model ltxv-2b
  python scripts/download_models.py --comfyui ~/ComfyUI --model wan2.1-i2v-14b --include-optional
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "image-to-video" / "workflows" / "models.json"
CHUNK = 1024 * 1024


def load_registry() -> dict:
    return json.loads(REGISTRY.read_text(encoding="utf-8"))


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def download(url: str, dest: Path) -> None:
    part = dest.with_suffix(dest.suffix + ".part")
    have = part.stat().st_size if part.exists() else 0
    request = urllib.request.Request(url, headers={"User-Agent": "vesion-model-downloader"})
    if have:
        request.add_header("Range", f"bytes={have}-")
    try:
        response = urllib.request.urlopen(request, timeout=60)
    except urllib.error.HTTPError as exc:
        if exc.code == 416:  # already complete
            part.rename(dest)
            return
        raise
    with response:
        if have and response.status != 206:
            have = 0  # server ignored the range request; start over
        total = int(response.headers.get("Content-Length", 0)) + have
        mode = "ab" if have else "wb"
        started, done = time.monotonic(), have
        with part.open(mode) as fh:
            while True:
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                fh.write(chunk)
                done += len(chunk)
                elapsed = max(time.monotonic() - started, 0.001)
                speed = (done - have) / elapsed
                pct = f"{done / total * 100:5.1f}%" if total else ""
                print(f"\r    {pct} {human(done)} / {human(total)}  {human(speed)}/s   ", end="", flush=True)
    print()
    part.rename(dest)


def main() -> int:
    registry = load_registry()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--comfyui", type=Path, help="Path to your ComfyUI folder (contains main.py)")
    parser.add_argument("--model", action="append", help="Model id (repeatable). Default: " + registry["default_model"])
    parser.add_argument("--include-optional", action="store_true", help="Also download optional files")
    parser.add_argument("--list", action="store_true", help="List models and their files")
    args = parser.parse_args()

    models = {m["id"]: m for m in registry["models"]}
    if args.list:
        for m in registry["models"]:
            size = sum(f.get("size_gb", 0) for f in m["files"] if not f.get("optional"))
            print(f"{m['id']:18} {m['name']:18} ~{size:.0f}GB  VRAM {m['min_vram_gb']}GB+  {m['license']}")
            for f in m["files"]:
                print(f"    {'(optional) ' if f.get('optional') else ''}{f['folder']}/{f['name']}")
        return 0
    if not args.comfyui:
        parser.error("--comfyui is required (path to your ComfyUI folder)")
    comfy = args.comfyui.expanduser().resolve()
    if not (comfy / "main.py").is_file():
        print(f"✗ {comfy} does not look like a ComfyUI folder (main.py not found).", file=sys.stderr)
        return 1

    wanted = args.model or [registry["default_model"]]
    unknown = [m for m in wanted if m not in models]
    if unknown:
        print(f"✗ Unknown model(s): {', '.join(unknown)}. Use --list.", file=sys.stderr)
        return 1

    files, seen = [], set()
    for model_id in wanted:
        for f in models[model_id]["files"]:
            if f.get("optional") and not args.include_optional:
                continue
            key = (f["folder"], f["name"])
            if key not in seen:
                seen.add(key)
                files.append(f)

    print(f"Downloading {len(files)} file(s) for: {', '.join(wanted)} → {comfy / 'models'}")
    failed = 0
    for f in files:
        dest = comfy / "models" / f["folder"] / f["name"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.is_file() and dest.stat().st_size > 0:
            print(f"✓ {f['folder']}/{f['name']} (already present)")
            continue
        print(f"↓ {f['folder']}/{f['name']} (~{f.get('size_gb', '?')}GB)")
        for attempt in range(1, 4):
            try:
                download(f["url"], dest)
                print(f"✓ {f['folder']}/{f['name']}")
                break
            except (urllib.error.URLError, OSError) as exc:
                print(f"\n  attempt {attempt} failed: {exc}")
                time.sleep(3 * attempt)
        else:
            failed += 1
            print(f"✗ Could not download {f['name']}. Download it manually from:\n  {f['url']}", file=sys.stderr)
    if failed:
        return 1
    print("\nDone. Restart ComfyUI, then reload the studio page — the model will show as ready.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
