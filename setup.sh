#!/usr/bin/env bash
# OpenReel Studio installer for Linux / macOS (Windows: use setup.bat).
# Usage: ./setup.sh [--yes] [--no-comfyui] [--model ltxv-2b|wan22-5b|wan21-1.3b|none] [--cpu] [--no-piper]
set -uo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
YES=0; NO_COMFY=0; MODEL=""; CPU=0; NO_PIPER=0; PROBLEMS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes) YES=1 ;;
    --no-comfyui) NO_COMFY=1 ;;
    --model) MODEL="${2:-}"; shift ;;
    --cpu) CPU=1 ;;
    --no-piper) NO_PIPER=1 ;;
    *) echo "Unknown option $1"; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m[OK]\033[0m %s\n' "$1"; }
note() { printf '  \033[33m[!]\033[0m  %s\n' "$1"; }
bad()  { printf '  \033[31m[X]\033[0m  %s\n' "$1"; PROBLEMS+=("$1"); }
ask() {  # ask "question" default(y|n)
  local def="${2:-y}" ans
  if [ "$YES" = 1 ]; then [ "$def" = y ]; return; fi
  read -r -p "  $1 [$( [ "$def" = y ] && echo Y/n || echo y/N )] " ans
  ans="${ans:-$def}"; [[ "$ans" =~ ^[Yy] ]]
}
have() { command -v "$1" >/dev/null 2>&1; }
env_get() { [ -f .env ] && grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | sed 's/^"//; s/"$//'; }
env_set() { node -e 'const fs=require("fs");const [k,v]=process.argv.slice(1);let s=fs.existsSync(".env")?fs.readFileSync(".env","utf8"):"";const re=new RegExp("^"+k+"=.*$","m");s=re.test(s)?s.replace(re,k+"="+v):s.replace(/\n?$/,"\n")+k+"="+v+"\n";fs.writeFileSync(".env",s)' "$1" "$2"; }

printf '\n  \033[35mOpenReel Studio - setup\033[0m\n  Free, self-hosted AI video generation\n'
OS="$(uname -s)"

step "Node.js"
NODE_OK=0
if have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then ok "Node.js $(node --version)"; NODE_OK=1
else bad "Node.js 18+ is required: https://nodejs.org (or: brew install node / nvm install --lts)"; fi

if [ "$NODE_OK" = 1 ]; then
  step "Node packages"
  if npm install --no-audit --no-fund; then ok "Installed"; else bad "npm install failed"; fi
fi
[ -f .env ] || { cp .env.example .env; ok "Created .env"; }

step "FFmpeg"
if [ "$NODE_OK" = 1 ] && node scripts/install-ffmpeg.js; then ok "FFmpeg ready"   # finds existing FFmpeg or installs a portable build
elif have ffmpeg; then ok "$(ffmpeg -hide_banner -version | head -n1 | cut -d' ' -f1-3)"
else
  if [ "$OS" = Darwin ] && have brew && ask "Install FFmpeg with Homebrew?"; then brew install ffmpeg
  elif have apt-get && ask "Install FFmpeg with apt (needs sudo)?"; then sudo apt-get update && sudo apt-get install -y ffmpeg
  elif have dnf && ask "Install FFmpeg with dnf (needs sudo)?"; then sudo dnf install -y ffmpeg; fi
  have ffmpeg && ok "FFmpeg installed" || bad "FFmpeg is required (https://ffmpeg.org/download.html)"
fi

step "GPU"
GPU_CAP=""
if have nvidia-smi && nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader | while read -r l; do ok "$l"; done
  GPU_CAP="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n1 | tr -d ' ')"
elif [ "$OS" = Darwin ] && [ "$(uname -m)" = arm64 ]; then ok "Apple Silicon (Metal/MPS)"
else note "No NVIDIA GPU detected - generation runs on the CPU (slow)."; fi

step "Python + PyTorch (local AI engine)"
PY_OK=0
VENV_PY="$ROOT/.venv/bin/python"
if [ ! -x "$VENV_PY" ]; then
  PY=""
  for c in python3.12 python3.11 python3.10 python3.13 python3; do
    if have "$c" && "$c" -c 'import sys; exit(0 if (3,10)<=sys.version_info[:2]<=(3,13) else 1)' 2>/dev/null; then PY="$c"; break; fi
  done
  if [ -n "$PY" ]; then "$PY" -m venv .venv && ok "Created .venv with $($PY --version)"
  else bad "Python 3.10-3.13 is required (e.g. sudo apt install python3 python3-venv / brew install python@3.11)"; fi
fi
if [ -x "$VENV_PY" ]; then
  "$VENV_PY" -m pip install --upgrade pip wheel -q
  if ! "$VENV_PY" -c 'import torch' 2>/dev/null; then
    if [ "$OS" = Darwin ]; then "$VENV_PY" -m pip install torch torchvision
    elif [ -n "$GPU_CAP" ] && [ "$CPU" = 0 ]; then
      IDX=cu126; awk "BEGIN{exit !($GPU_CAP >= 12.0)}" && IDX=cu128
      "$VENV_PY" -m pip install torch torchvision --index-url "https://download.pytorch.org/whl/$IDX"
    else "$VENV_PY" -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu; fi
  fi
  "$VENV_PY" -m pip install -r worker/requirements.txt -q
  if INFO="$("$VENV_PY" -c 'import torch, diffusers; print(torch.__version__, torch.cuda.is_available(), diffusers.__version__)' 2>/dev/null)"; then
    ok "torch/cuda/diffusers: $INFO"; PY_OK=1
  else bad "Python AI packages failed to install"; fi
fi

step "Text-to-speech"
[ "$OS" = Darwin ] && ok "macOS voices available"
if have espeak-ng || have espeak; then ok "eSpeak NG"
elif have apt-get && ask "Install espeak-ng (free TTS, needs sudo)?"; then sudo apt-get install -y espeak-ng && ok "eSpeak NG"; fi
if [ "$PY_OK" = 1 ] && [ "$NO_PIPER" = 0 ] && ask "Install Piper neural voices (~120 MB)?"; then
  "$VENV_PY" -m pip install -q piper-tts && mkdir -p models/piper
  BASE=https://huggingface.co/rhasspy/piper-voices/resolve/main
  for v in en/en_US/lessac/medium/en_US-lessac-medium ar/ar_JO/kareem/medium/ar_JO-kareem-medium; do
    n="$(basename "$v")"
    for ext in onnx onnx.json; do
      [ -f "models/piper/$n.$ext" ] || curl -fsSL "$BASE/$v.$ext" -o "models/piper/$n.$ext" || { note "Could not download Piper voice $n"; rm -f "models/piper/$n.$ext"; }
    done
  done
fi

step "ComfyUI (primary local video engine)"
COMFY_URL="$(env_get COMFYUI_URL)"; COMFY_URL="${COMFY_URL:-http://127.0.0.1:8188}"
COMFY_PATH="$(env_get COMFYUI_PATH)"
if [ -z "$COMFY_PATH" ]; then
  for c in "$ROOT/ComfyUI" "$HOME/ComfyUI"; do [ -f "$c/main.py" ] && { COMFY_PATH="$c"; env_set COMFYUI_PATH "$c"; ok "Found ComfyUI at $c"; break; }; done
fi
if curl -fsS "$COMFY_URL/system_stats" >/dev/null 2>&1; then ok "ComfyUI running at $COMFY_URL"
elif [ -n "$COMFY_PATH" ] && [ -f "$COMFY_PATH/main.py" ]; then ok "ComfyUI installed at $COMFY_PATH (start.sh launches it)"
elif [ "$NO_COMFY" = 0 ] && [ "$PY_OK" = 1 ] && ask "Install ComfyUI into ./ComfyUI (shares the Python environment)?"; then
  if have git; then git clone --depth 1 https://github.com/comfyanonymous/ComfyUI ComfyUI
  else curl -fsSL https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.tar.gz | tar -xz && mv ComfyUI-master ComfyUI; fi
  "$VENV_PY" -m pip install -r ComfyUI/requirements.txt -q && COMFY_PATH="$ROOT/ComfyUI" && env_set COMFYUI_PATH "$COMFY_PATH" && ok "ComfyUI installed"
else note "ComfyUI is not running. Start ComfyUI to enable local AI video generation (or set COMFYUI_PATH in .env)."; fi

step "Video models (free, open source)"
if [ -n "$COMFY_PATH" ] && [ -d "$COMFY_PATH/models" ] && [ "$NODE_OK" = 1 ]; then
  if [ -z "$MODEL" ]; then if ask "Download LTX-Video 2B for ComfyUI now (~11.5 GB, fastest model)?"; then MODEL=ltxv-2b; else MODEL=none; fi; fi
  [ "$MODEL" != none ] && { node scripts/download-models.js --model "$MODEL" --comfyui "$COMFY_PATH" || note "Model download incomplete - run 'npm run download-models' later (it resumes)."; }
elif [ "$PY_OK" = 1 ] && ask "Pre-download the local model now (otherwise on first use)?"; then
  LM="$(env_get LOCAL_MODEL)"; "$VENV_PY" worker/predownload.py "${LM:-Lightricks/LTX-Video}" "$ROOT/models" 2>&1 | grep -v '^{' || true
fi

step "Checking the installation"
[ "$NODE_OK" = 1 ] && node scripts/doctor.js
if [ ${#PROBLEMS[@]} -gt 0 ]; then printf '\n  \033[31mSetup finished with problems:\033[0m\n'; printf '   - %s\n' "${PROBLEMS[@]}"; exit 1; fi
printf '\n  \033[32mSetup complete! Run ./start.sh to launch OpenReel Studio.\033[0m\n\n'
