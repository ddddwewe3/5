#!/usr/bin/env python3
"""Pre-downloads the local model so the first generation starts immediately.
Usage: python worker/predownload.py <model id or folder> <models dir>"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import video_worker  # noqa: E402


def main():
    model = sys.argv[1] if len(sys.argv) > 1 else "Lightricks/LTX-Video"
    models_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "models")
    try:
        path = video_worker.download(model, models_dir, "setup")
        print("Model ready: %s" % path, file=sys.stderr)
    except video_worker.WorkerError as e:
        print("Model download failed: %s" % e, file=sys.stderr)
        print("It will be retried automatically on the first generation.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
