#!/usr/bin/env bash
# Installs ComfyUI (free, open source) and the default free video model (Wan 2.2 5B).
#
#   bash scripts/setup-comfyui.sh                 # installs into ~/ComfyUI
#   bash scripts/setup-comfyui.sh /data/ComfyUI   # custom folder
#   MODEL=ltxv-2b bash scripts/setup-comfyui.sh   # other model (see: python3 scripts/download_models.py --list)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMFY_DIR="${1:-$HOME/ComfyUI}"
MODEL="${MODEL:-wan2.2-ti2v-5b}"
PYTHON="${PYTHON:-python3}"

echo "==> ComfyUI folder: $COMFY_DIR"
if [ -d "$COMFY_DIR/.git" ]; then
  echo "==> Updating existing ComfyUI"
  git -C "$COMFY_DIR" pull --ff-only
else
  git clone https://github.com/comfyanonymous/ComfyUI.git "$COMFY_DIR"
fi

cd "$COMFY_DIR"
if [ ! -d venv ]; then
  "$PYTHON" -m venv venv
fi
# shellcheck disable=SC1091
source venv/bin/activate
python -m pip install --upgrade pip

if command -v nvidia-smi >/dev/null 2>&1; then
  echo "==> NVIDIA GPU found:"
  nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader || true
  # CUDA 12.8 PyTorch builds dropped older GPUs (GTX 10xx, compute capability < 7.0): use cu126 there.
  CAP="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | tr -d ' ')"
  CUDA=cu128
  if awk "BEGIN{exit !(${CAP:-9} < 7.0)}"; then CUDA=cu126; fi
  echo "==> GPU compute capability ${CAP} -> PyTorch build ${CUDA}"
  CHECK="import torch,sys; ok=torch.cuda.is_available() and ('sm_%d%d' % torch.cuda.get_device_capability(0)) in torch.cuda.get_arch_list(); print('torch', torch.__version__, 'gpu kernels ok:', ok); sys.exit(0 if ok else 1)"
  if ! python -c "$CHECK" 2>/dev/null; then
    pip install --force-reinstall torch torchvision torchaudio --index-url "https://download.pytorch.org/whl/${CUDA}"
    python -c "$CHECK" || echo "!!  PyTorch still cannot run on this GPU. Update the NVIDIA driver and run again."
  fi
elif [ "$(uname -s)" = "Darwin" ]; then
  echo "==> macOS: installing PyTorch with Apple Metal (MPS). Video models run, but slowly."
  pip install torch torchvision torchaudio
else
  echo "!!  No NVIDIA GPU detected (nvidia-smi not found)."
  echo "!!  ComfyUI will install, but the studio refuses CPU-only generation because it takes hours."
  pip install torch torchvision torchaudio
fi
pip install -r requirements.txt

echo "==> Downloading model files for: $MODEL"
python "$REPO_ROOT/scripts/download_models.py" --comfyui "$COMFY_DIR" --model "$MODEL"

cat <<MSG

==> Done. Start ComfyUI with:
      cd "$COMFY_DIR" && source venv/bin/activate && python main.py --listen 127.0.0.1 --port 8188

    Then start the video engine and the website (see README), open http://localhost:3000/studio
MSG
