#!/usr/bin/env python3
"""Collects everything needed to debug video generation into one report file.

  python scripts/diagnose.py [--comfyui PATH]

Checks: GPU / driver, PyTorch + CUDA inside ComfyUI's environment, ports, ComfyUI status and log,
model files (complete or corrupted), the video engine's health and the last failed generations.
Uses only the Python standard library. Writes diagnose-report.txt in the project folder.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import sqlite3
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from download_models import safetensors_ok  # noqa: E402

lines: list[str] = []


def out(text: str = "") -> None:
    print(text)
    lines.append(text)


def section(title: str) -> None:
    out("")
    out("=" * 70)
    out(title)
    out("=" * 70)


def http_json(url: str, timeout: float = 5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8", "replace"))
    except Exception as exc:  # noqa: BLE001
        return {"__error__": f"{type(exc).__name__}: {exc}"}


def run(cmd: list[str], timeout: float = 60) -> str:
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (result.stdout + result.stderr).strip()
    except Exception as exc:  # noqa: BLE001
        return f"(could not run {cmd[0]}: {exc})"


def port_open(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(1)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--comfyui", type=Path, default=Path.home() / "ComfyUI")
    args = parser.parse_args()
    comfy = args.comfyui.expanduser()

    section("System")
    out(f"OS: {platform.platform()}")
    out(f"Python (this script): {sys.version.split()[0]}")
    out(f"Project: {ROOT}")
    out(f"ComfyUI folder: {comfy} (exists: {comfy.is_dir()})")
    git = run(["git", "-C", str(ROOT), "log", "-1", "--format=%h %s (%cr)"])
    out(f"Project version: {git}")

    section("GPU (nvidia-smi)")
    out(run(["nvidia-smi", "--query-gpu=name,driver_version,memory.total,memory.used", "--format=csv"]))

    section("PyTorch inside ComfyUI's environment")
    venv_python = comfy / ("venv/Scripts/python.exe" if os.name == "nt" else "venv/bin/python")
    if not venv_python.is_file():
        embedded = comfy.parent / "python_embeded" / "python.exe"  # Windows portable build
        venv_python = embedded if embedded.is_file() else venv_python
    if venv_python.is_file():
        out(run([str(venv_python), "-c",
                 "import torch;print('torch', torch.__version__);print('cuda available:', torch.cuda.is_available());"
                 "print('cuda build:', torch.version.cuda);"
                 "print('gpu:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else '-');"
                 "print('vram GB:', round(torch.cuda.get_device_properties(0).total_memory/1024**3,1) "
                 "if torch.cuda.is_available() else 0)"], timeout=120))
    else:
        out(f"ComfyUI Python not found at {venv_python}")

    section("Ports (something must listen on each)")
    for port, name in [(8188, "ComfyUI"), (8000, "video engine"), (3000, "website")]:
        out(f"{port} {name}: {'LISTENING' if port_open(port) else 'NOTHING RUNNING'}")

    section("ComfyUI status")
    stats = http_json("http://127.0.0.1:8188/system_stats")
    if "__error__" in stats:
        out(f"NOT REACHABLE: {stats['__error__']}")
    else:
        system = stats.get("system", {})
        out(f"version {system.get('comfyui_version')}, python {system.get('python_version', '?').split()[0]}, "
            f"pytorch {system.get('pytorch_version')}")
        for device in stats.get("devices", []):
            out(f"device: {device.get('name')} type={device.get('type')} "
                f"vram={round((device.get('vram_total') or 0) / 1024**3, 1)}GB "
                f"free={round((device.get('vram_free') or 0) / 1024**3, 1)}GB")

    section("Model files")
    registry = json.loads((ROOT / "image-to-video" / "workflows" / "models.json").read_text(encoding="utf-8"))
    for model in registry["models"]:
        out(f"[{model['id']}]")
        for f in model["files"]:
            path = comfy / "models" / f["folder"] / f["name"]
            if not path.is_file():
                state = "MISSING" + (" (optional)" if f.get("optional") else "")
            else:
                size = path.stat().st_size / 1024**3
                state = f"{size:.2f} GB, " + ("OK" if safetensors_ok(path) else "CORRUPTED/INCOMPLETE")
            out(f"  {f['folder']}/{f['name']}: {state}")

    section("Video engine health (http://127.0.0.1:8000/api/health)")
    health = http_json("http://127.0.0.1:8000/api/health")
    out(json.dumps({k: health.get(k) for k in ("backend", "engine", "comfyui", "models", "__error__") if k in health},
                   ensure_ascii=False))
    detail = health.get("engine_detail") or health.get("engine")
    if isinstance(detail, dict):
        out(f"message: {detail.get('message')}")

    section("Last generations (newest first)")
    db = ROOT / "image-to-video" / "data" / "engine.db"
    if db.is_file():
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        columns = {r["name"] for r in conn.execute("PRAGMA table_info(generations)")}
        stage = "error_stage" if "error_stage" in columns else "NULL AS error_stage"
        for row in conn.execute(f"SELECT id, model, mode, status, error, {stage}, error_details, params, created_at "
                                "FROM generations ORDER BY created_at DESC LIMIT 5"):
            params = json.loads(row["params"] or "{}")
            out(f"- {row['id'][:8]} {row['model']} {row['mode']} {params.get('resolution')} {params.get('duration')}s "
                f"-> {row['status']} [{row['error_stage']}] {row['error'] or ''}")
            if row["error_details"]:
                out("    details: " + row["error_details"][-1500:].replace("\n", "\n    "))
    else:
        out(f"No engine database at {db}")

    section("ComfyUI log (last 80 lines)")
    log = http_json("http://127.0.0.1:8188/internal/logs")
    out("\n".join(log.strip().splitlines()[-80:]) if isinstance(log, str) else json.dumps(log, ensure_ascii=False))

    report = ROOT / "diagnose-report.txt"
    report.write_text("\n".join(lines), encoding="utf-8")
    print(f"\nReport saved to {report}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
