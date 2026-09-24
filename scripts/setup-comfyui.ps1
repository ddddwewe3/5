# Installs ComfyUI (free, open source) and the default free video model (Wan 2.2 5B) on Windows.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup-comfyui.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup-comfyui.ps1 -ComfyDir D:\ComfyUI -Model ltxv-2b
#
# Needs: Git (https://git-scm.com) and Python 3.10-3.12 (https://www.python.org, tick "Add python.exe to PATH").
# Alternative without Python: download the ComfyUI portable build, then run only:
#   py scripts\download_models.py --comfyui <path>\ComfyUI_windows_portable\ComfyUI
param(
  [string]$ComfyDir = "$HOME\ComfyUI",
  [string]$Model = "wan2.2-ti2v-5b"
)
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

Write-Host "==> ComfyUI folder: $ComfyDir"
if (Test-Path "$ComfyDir\.git") {
  git -C $ComfyDir pull --ff-only
} else {
  git clone https://github.com/comfyanonymous/ComfyUI.git $ComfyDir
}

Set-Location $ComfyDir
if (-not (Test-Path "venv")) { py -m venv venv }
& .\venv\Scripts\python.exe -m pip install --upgrade pip

if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  Write-Host "==> NVIDIA GPU found:"
  nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
  & .\venv\Scripts\pip.exe install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
} else {
  Write-Warning "No NVIDIA GPU detected. ComfyUI will install, but the studio refuses CPU-only generation because it takes hours."
  & .\venv\Scripts\pip.exe install torch torchvision torchaudio
}
& .\venv\Scripts\pip.exe install -r requirements.txt

Write-Host "==> Downloading model files for: $Model"
& .\venv\Scripts\python.exe "$RepoRoot\scripts\download_models.py" --comfyui $ComfyDir --model $Model
if ($LASTEXITCODE -ne 0) { throw "Model download failed" }

Write-Host ""
Write-Host "==> Done. Start ComfyUI with:"
Write-Host "      cd `"$ComfyDir`"; .\venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188"
Write-Host "    Then start the video engine and the website (see README), open http://localhost:3000/studio"
