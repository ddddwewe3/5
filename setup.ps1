<#
.SYNOPSIS
  OpenReel Studio installer for Windows.

.DESCRIPTION
  Checks and installs everything needed to generate AI videos locally for free:
  Node.js, FFmpeg, Python + PyTorch (CUDA build when an NVIDIA GPU is present), the local video
  worker, optional ComfyUI, free open-source models and local text-to-speech.
  Safe to run again at any time - finished steps are skipped.

.EXAMPLE
  .\setup.ps1                      # interactive
  .\setup.ps1 -Yes                 # accept all defaults (installs ComfyUI + LTX-Video model)
  .\setup.ps1 -Model none -NoComfyUI
#>
param(
  [switch]$Yes,                 # answer "yes" to every question
  [switch]$NoComfyUI,           # do not install ComfyUI
  [string]$Model = '',          # ComfyUI model to download: ltxv-2b | wan22-5b | wan21-1.3b | none
  [switch]$Cpu,                 # force CPU-only PyTorch
  [switch]$SkipPython,          # skip the Python / AI environment
  [switch]$NoPiper              # skip Piper neural voices
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # makes Invoke-WebRequest much faster
Set-Location -LiteralPath $PSScriptRoot
$Root = $PSScriptRoot
$IsWin = ($env:OS -eq 'Windows_NT')
$VenvPy = if ($IsWin) { Join-Path $Root '.venv\Scripts\python.exe' } else { Join-Path $Root '.venv/bin/python' }
$script:Problems = @()

function Write-Step($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }
function Write-Ok($t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function Write-Note($t) { Write-Host "  [!]  $t" -ForegroundColor Yellow }
function Write-Bad($t)  { Write-Host "  [X]  $t" -ForegroundColor Red; $script:Problems += $t }

function Ask([string]$Question, [bool]$Default = $true) {
  if ($Yes) { return $Default }
  $suffix = if ($Default) { '[Y/n]' } else { '[y/N]' }
  $answer = Read-Host "  $Question $suffix"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
  return $answer.Trim().ToLower().StartsWith('y')
}

function Test-Cmd([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Update-SessionPath {
  if (-not $IsWin) { return }
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Install-Winget([string]$Id, [string]$Label) {
  if (-not (Test-Cmd 'winget')) { return $false }
  Write-Host "  Installing $Label with winget..."
  & winget install -e --id $Id --accept-source-agreements --accept-package-agreements --silent | Out-Host
  Update-SessionPath
  return $true
}

function Get-EnvFileValue([string]$Key) {
  $file = Join-Path $Root '.env'
  if (-not (Test-Path $file)) { return '' }
  foreach ($line in Get-Content $file) {
    if ($line -match "^\s*$Key\s*=\s*(.*)$") { return $Matches[1].Trim().Trim('"') }
  }
  return ''
}

function Set-EnvFileValue([string]$Key, [string]$Value) {
  $file = Join-Path $Root '.env'
  $lines = @()
  if (Test-Path $file) { $lines = @(Get-Content $file) }
  $found = $false
  $lines = $lines | ForEach-Object { if ($_ -match "^\s*$Key\s*=") { $found = $true; "$Key=$Value" } else { $_ } }
  if (-not $found) { $lines += "$Key=$Value" }
  Set-Content -Path $file -Value $lines -Encoding UTF8
}

function Test-Url([string]$Url) {
  try { Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 4 | Out-Null; return $true } catch { return $false }
}

function Save-Url([string]$Url, [string]$Dest) {
  if (Test-Path $Dest) { return }
  $tmp = "$Dest.part"
  Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing
  Move-Item -Force $tmp $Dest
}

Write-Host ''
Write-Host '  OpenReel Studio - setup' -ForegroundColor Magenta
Write-Host '  Free, self-hosted AI video generation' -ForegroundColor DarkGray

# -- 1. Node.js ----------------------------------------------------------------
Write-Step 'Node.js'
$nodeOk = $false
if (Test-Cmd 'node') {
  $v = (& node --version).TrimStart('v')
  if ([int]($v.Split('.')[0]) -ge 18) { $nodeOk = $true; Write-Ok "Node.js $v" } else { Write-Note "Node.js $v is too old (need 18+)" }
}
if (-not $nodeOk) {
  if ((Ask 'Install Node.js LTS now?') -and (Install-Winget 'OpenJS.NodeJS.LTS' 'Node.js LTS') -and (Test-Cmd 'node')) {
    Write-Ok "Node.js $(& node --version)"; $nodeOk = $true
  } else {
    Write-Bad 'Node.js 18+ is required. Download it from https://nodejs.org and run setup again.'
  }
}

# -- 2. Node packages + .env ---------------------------------------------------
if ($nodeOk) {
  Write-Step 'Node packages'
  & npm install --no-audit --no-fund | Out-Host
  if ($LASTEXITCODE -ne 0) { Write-Bad 'npm install failed (see output above)' } else { Write-Ok 'Installed' }
}
if (-not (Test-Path (Join-Path $Root '.env'))) {
  Copy-Item (Join-Path $Root '.env.example') (Join-Path $Root '.env')
  Write-Ok 'Created .env from .env.example'
}

# -- 3. FFmpeg -----------------------------------------------------------------
Write-Step 'FFmpeg (video encoding)'
if ($nodeOk) {
  # Portable build into tools\ffmpeg (no PATH or admin rights needed); skipped when FFmpeg already works.
  & node ([IO.Path]::Combine($Root, 'scripts', 'install-ffmpeg.js')) | Out-Host
  if ($LASTEXITCODE -eq 0) { Write-Ok 'FFmpeg ready' }
  elseif ((Install-Winget 'Gyan.FFmpeg' 'FFmpeg') -and (Test-Cmd 'ffmpeg')) { Write-Ok 'FFmpeg installed with winget' }
  else { Write-Bad 'FFmpeg could not be installed. Start the app and click "Install FFmpeg automatically", or install it from https://www.gyan.dev/ffmpeg/builds/' }
} else {
  Write-Bad 'FFmpeg needs Node.js first (see above).'
}

# -- 4. GPU --------------------------------------------------------------------
Write-Step 'GPU'
$gpu = $null
if (Test-Cmd 'nvidia-smi') {
  $q = (& nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader 2>$null) | Select-Object -First 1
  if ($q) {
    $parts = $q.Split(',') | ForEach-Object { $_.Trim() }
    $gpu = @{ Name = $parts[0]; Memory = $parts[1]; Driver = $parts[2]; Cap = $parts[3] }
    Write-Ok "$($gpu.Name) | $($gpu.Memory) | driver $($gpu.Driver) | compute $($gpu.Cap)"
    $cudaLine = (& nvidia-smi 2>$null | Select-String 'CUDA Version' | Select-Object -First 1)
    if ($cudaLine) { Write-Ok ($cudaLine.ToString() -replace '.*(CUDA Version:\s*[\d.]+).*', '$1') }
  }
}
if (-not $gpu) {
  Write-Note 'No NVIDIA GPU detected. Generation will run on the CPU and be slow (minutes per clip).'
  Write-Note 'AMD/Intel GPUs: use ComfyUI with its DirectML/ROCm instructions and select ComfyUI as the engine.'
}

# -- 5. Python + AI packages ---------------------------------------------------
$pyOk = $false
if (-not $SkipPython) {
  Write-Step 'Python + PyTorch (local AI engine)'
  function Find-Python {
    foreach ($ver in @('3.12', '3.11', '3.10', '3.13')) {
      if (Test-Cmd 'py') {
        try { $out = & py "-$ver" -c "import sys; print(sys.executable)" 2>$null; if ($LASTEXITCODE -eq 0 -and $out) { return $out.Trim() } } catch { }
      }
    }
    foreach ($name in @('python', 'python3')) {
      if (Test-Cmd $name) {
        try {
          $info = & $name -c "import sys; print(sys.executable); print('%d.%d' % sys.version_info[:2])" 2>$null
          if ($LASTEXITCODE -eq 0 -and $info.Count -ge 2 -and @('3.10', '3.11', '3.12', '3.13') -contains $info[1].Trim()) { return $info[0].Trim() }
        } catch { }
      }
    }
    return $null
  }
  if (Test-Path $VenvPy) {
    Write-Ok 'Python environment .venv exists'
  } else {
    $py = Find-Python
    if (-not $py -and (Ask 'Python 3.10-3.13 not found. Install Python 3.11 now?')) {
      Install-Winget 'Python.Python.3.11' 'Python 3.11' | Out-Null
      $py = Find-Python
    }
    if ($py) {
      Write-Ok "Using $py"
      & $py -m venv (Join-Path $Root '.venv')
    } else {
      Write-Bad 'Python 3.10-3.13 is required for the local engine. Install it from https://www.python.org (tick "Add to PATH").'
    }
  }
  if (Test-Path $VenvPy) {
    & $VenvPy -m pip install --upgrade pip wheel --quiet | Out-Host
    $hasTorch = $false
    try { & $VenvPy -c "import torch" 2>$null; $hasTorch = ($LASTEXITCODE -eq 0) } catch { }
    if (-not $hasTorch) {
      $index = 'https://download.pytorch.org/whl/cpu'
      if ($gpu -and -not $Cpu) {
        $cap = 0.0
        [double]::TryParse($gpu.Cap, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$cap) | Out-Null
        $index = if ($cap -ge 12.0) { 'https://download.pytorch.org/whl/cu128' } else { 'https://download.pytorch.org/whl/cu126' }
      }
      Write-Host "  Installing PyTorch from $index (large download, one time)..."
      & $VenvPy -m pip install torch torchvision --index-url $index | Out-Host
    }
    Write-Host '  Installing diffusers and the video worker dependencies...'
    & $VenvPy -m pip install -r ([IO.Path]::Combine($Root, 'worker', 'requirements.txt')) | Out-Host
    $check = & $VenvPy -c "import torch, diffusers; print(torch.__version__, torch.cuda.is_available(), diffusers.__version__)" 2>$null
    if ($LASTEXITCODE -eq 0) {
      $pyOk = $true
      $p = $check.Split(' ')
      Write-Ok "torch $($p[0]) | CUDA available: $($p[1]) | diffusers $($p[2])"
      if ($gpu -and $p[1] -ne 'True') { Write-Note 'PyTorch cannot see your GPU. Update the NVIDIA driver, then re-run setup.' }
    } else {
      Write-Bad 'The Python AI packages could not be installed (see output above).'
    }
  }
}

# -- 6. Text-to-speech ---------------------------------------------------------
Write-Step 'Text-to-speech (voice-overs)'
if ($IsWin) { Write-Ok 'Windows built-in voices (SAPI) are available' }
if ($pyOk -and -not $NoPiper -and (Ask 'Install Piper neural voices (free, better quality, ~120 MB)?')) {
  try {
    & $VenvPy -m pip install piper-tts --quiet | Out-Host
    $voiceDir = [IO.Path]::Combine($Root, 'models', 'piper')
    New-Item -ItemType Directory -Force $voiceDir | Out-Null
    $base = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'
    foreach ($v in @('en/en_US/lessac/medium/en_US-lessac-medium', 'ar/ar_JO/kareem/medium/ar_JO-kareem-medium')) {
      $name = Split-Path $v -Leaf
      Save-Url "$base/$v.onnx" (Join-Path $voiceDir "$name.onnx")
      Save-Url "$base/$v.onnx.json" (Join-Path $voiceDir "$name.onnx.json")
      Write-Ok "Piper voice $name"
    }
  } catch { Write-Note "Piper could not be installed ($($_.Exception.Message)). Windows voices will be used." }
}

# -- 7. ComfyUI ----------------------------------------------------------------
Write-Step 'ComfyUI (primary local video engine)'
$comfyUrl = Get-EnvFileValue 'COMFYUI_URL'; if (-not $comfyUrl) { $comfyUrl = 'http://127.0.0.1:8188' }
$comfyPath = Get-EnvFileValue 'COMFYUI_PATH'
if (-not $comfyPath) {
  $candidates = @((Join-Path $Root 'ComfyUI'), 'C:\ComfyUI', "$env:USERPROFILE\ComfyUI", "$env:USERPROFILE\Desktop\ComfyUI_windows_portable\ComfyUI",
    'C:\ComfyUI_windows_portable\ComfyUI', "$env:USERPROFILE\Downloads\ComfyUI_windows_portable\ComfyUI")
  foreach ($c in $candidates) {
    try { if ($c -and (Test-Path -LiteralPath ([IO.Path]::Combine($c, 'main.py')))) { $comfyPath = $c; break } } catch { }
  }
  if ($comfyPath) { Set-EnvFileValue 'COMFYUI_PATH' $comfyPath; Write-Ok "Found ComfyUI at $comfyPath" }
}
if (Test-Url "$comfyUrl/system_stats") {
  Write-Ok "ComfyUI is running at $comfyUrl"
} elseif ($comfyPath -and (Test-Path (Join-Path $comfyPath 'main.py'))) {
  Write-Ok "ComfyUI installed at $comfyPath (start.bat will launch it)"
} elseif (-not $NoComfyUI -and $pyOk -and (Ask 'Install ComfyUI into .\ComfyUI (recommended, shares the Python environment)?')) {
  try {
    $zip = Join-Path $env:TEMP 'comfyui.zip'
    Write-Host '  Downloading ComfyUI...'
    Invoke-WebRequest 'https://github.com/comfyanonymous/ComfyUI/archive/refs/heads/master.zip' -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $Root -Force
    if (Test-Path (Join-Path $Root 'ComfyUI')) { Remove-Item -Recurse -Force (Join-Path $Root 'ComfyUI') }
    Rename-Item (Join-Path $Root 'ComfyUI-master') 'ComfyUI'
    Remove-Item $zip -Force
    & $VenvPy -m pip install -r ([IO.Path]::Combine($Root, 'ComfyUI', 'requirements.txt')) | Out-Host
    $comfyPath = Join-Path $Root 'ComfyUI'
    Set-EnvFileValue 'COMFYUI_PATH' $comfyPath
    Write-Ok "ComfyUI installed at $comfyPath"
  } catch { Write-Note "ComfyUI install failed: $($_.Exception.Message). The local Python engine will be used instead." }
} else {
  Write-Note 'ComfyUI is not running. Start ComfyUI to enable local AI video generation (or set COMFYUI_PATH in .env).'
}

# -- 8. Models -----------------------------------------------------------------
Write-Step 'Video models (free, open source)'
if ($comfyPath -and (Test-Path (Join-Path $comfyPath 'models')) -and $nodeOk) {
  if (-not $Model) { $Model = if (Ask 'Download LTX-Video 2B for ComfyUI now (~11.5 GB, fastest model)?') { 'ltxv-2b' } else { 'none' } }
  if ($Model -ne 'none') {
    & node ([IO.Path]::Combine($Root, 'scripts', 'download-models.js')) --model $Model --comfyui $comfyPath | Out-Host
    if ($LASTEXITCODE -ne 0) { Write-Note 'Model download incomplete - run download-models.bat later (it resumes).' }
  }
} elseif ($pyOk) {
  $localModel = Get-EnvFileValue 'LOCAL_MODEL'; if (-not $localModel) { $localModel = 'Lightricks/LTX-Video' }
  if (Ask "Pre-download the local model $localModel now (otherwise it downloads on first use)?") {
    & $VenvPy ([IO.Path]::Combine($Root, 'worker', 'predownload.py')) $localModel ([IO.Path]::Combine($Root, 'models')) 2>&1 | Where-Object { $_ -notmatch '^\{' } | Out-Host
  }
}

# -- 9. Final check ------------------------------------------------------------
Write-Step 'Checking the installation'
if ($nodeOk) { & node ([IO.Path]::Combine($Root, 'scripts', 'doctor.js')) | Out-Host }
Write-Host ''
if ($script:Problems.Count -gt 0) {
  Write-Host '  Setup finished with problems:' -ForegroundColor Red
  $script:Problems | ForEach-Object { Write-Host "   - $_" -ForegroundColor Red }
  exit 1
}
Write-Host '  Setup complete!  Double-click start.bat to launch OpenReel Studio.' -ForegroundColor Green
Write-Host ''
