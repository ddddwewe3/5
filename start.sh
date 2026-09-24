#!/usr/bin/env bash
# Starts OpenReel Studio on Linux / macOS: ComfyUI (if installed and not running), then the server.
# Usage: ./start.sh [--no-browser] [--no-comfyui]
cd "$(dirname "$0")"
ROOT="$(pwd)"
NO_BROWSER=0; NO_COMFY=0
for a in "$@"; do case "$a" in --no-browser) NO_BROWSER=1 ;; --no-comfyui) NO_COMFY=1 ;; esac; done
env_get() { [ -f .env ] && grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed 's/^"//; s/"$//'; }
PORT="$(env_get PORT)"; PORT="${PORT:-3000}"
COMFY_URL="$(env_get COMFYUI_URL)"; COMFY_URL="${COMFY_URL:-http://127.0.0.1:8188}"; COMFY_URL="${COMFY_URL%/}"
COMFY_PATH="$(env_get COMFYUI_PATH)"
COMFY_ARGS="$(env_get COMFYUI_ARGS)"
mkdir -p logs
[ -d node_modules ] || npm install --no-audit --no-fund
[ -f .env ] || cp .env.example .env

if [ "$NO_COMFY" = 0 ]; then
  if curl -fsS "$COMFY_URL/system_stats" >/dev/null 2>&1; then
    echo "  ComfyUI already running at $COMFY_URL"
  elif [ -n "$COMFY_PATH" ] && [ -f "$COMFY_PATH/main.py" ]; then
    PY=""
    for c in "$COMFY_PATH/venv/bin/python" "$ROOT/.venv/bin/python"; do [ -x "$c" ] && { PY="$c"; break; }; done
    PY="${PY:-python3}"
    CPORT="$(echo "$COMFY_URL" | sed -E 's#.*:([0-9]+)$#\1#')"; [[ "$CPORT" =~ ^[0-9]+$ ]] || CPORT=8188
    # No NVIDIA GPU (and not a Mac) → run ComfyUI on the CPU unless COMFYUI_ARGS says otherwise.
    if [ -z "$COMFY_ARGS" ] && ! command -v nvidia-smi >/dev/null 2>&1 && [ "$(uname -s)" != Darwin ] && ! command -v rocminfo >/dev/null 2>&1; then COMFY_ARGS="--cpu"; fi
    echo "  Starting ComfyUI from $COMFY_PATH (log: logs/comfyui.log)"
    (cd "$COMFY_PATH" && nohup "$PY" main.py --listen 127.0.0.1 --port "$CPORT" $COMFY_ARGS > "$ROOT/logs/comfyui.log" 2>&1 &)
    printf "  Waiting for ComfyUI"
    for i in $(seq 1 180); do curl -fsS "$COMFY_URL/system_stats" >/dev/null 2>&1 && { echo " ready."; break; }; sleep 1; [ $((i % 3)) = 0 ] && printf "."; done
  else
    echo "  ComfyUI is not running. Start ComfyUI to enable local AI video generation."
    echo "  (Set COMFYUI_PATH in .env so start.sh can launch it. The local Python engine is used meanwhile.)"
  fi
fi

if [ "$NO_BROWSER" = 0 ]; then
  ( for i in $(seq 1 60); do curl -fsS "http://localhost:$PORT/api/settings" >/dev/null 2>&1 && break; sleep 1; done
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$PORT" >/dev/null 2>&1
    elif command -v open >/dev/null 2>&1; then open "http://localhost:$PORT"; fi ) &
fi
echo "  Starting OpenReel Studio on http://localhost:$PORT (Ctrl+C to stop)"
exec node server.js
