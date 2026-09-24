<#
.SYNOPSIS
  Starts OpenReel Studio: ComfyUI (when installed and not already running), the web server,
  and opens the browser. Used by start.bat.
#>
param([switch]$NoBrowser, [switch]$NoComfyUI)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $Root
$IsWin = ($env:OS -eq 'Windows_NT')

function Read-DotEnv {
  $vals = @{}
  $file = Join-Path $Root '.env'
  if (Test-Path $file) {
    foreach ($line in Get-Content $file) {
      if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)$') { $vals[$Matches[1]] = $Matches[2].Trim().Trim('"') }
    }
  }
  return $vals
}
function Test-Url([string]$Url) {
  try { Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 | Out-Null; return $true } catch { return $false }
}
function Wait-Url([string]$Url, [int]$Seconds, [string]$Label) {
  Write-Host -NoNewline "  Waiting for $Label"
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-Url $Url) { Write-Host ' ready.' -ForegroundColor Green; return $true }
    Start-Sleep -Seconds 1
    if ($i % 3 -eq 0) { Write-Host -NoNewline '.' }
  }
  Write-Host ' not responding yet.' -ForegroundColor Yellow
  return $false
}
function Start-Window([string]$Title, [string]$Command, [string]$Dir) {
  if ($IsWin) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList "/k title $Title && $Command" -WorkingDirectory $Dir
  } else {
    Start-Process -FilePath 'bash' -ArgumentList '-c', "$Command" -WorkingDirectory $Dir
  }
}

$envVals = Read-DotEnv
$port = if ($envVals['PORT']) { $envVals['PORT'] } else { '3000' }
$appUrl = "http://localhost:$port"
$comfyUrl = if ($envVals['COMFYUI_URL']) { $envVals['COMFYUI_URL'].TrimEnd('/') } else { 'http://127.0.0.1:8188' }
$comfyPath = $envVals['COMFYUI_PATH']

Write-Host ''
Write-Host '  OpenReel Studio' -ForegroundColor Magenta

if (-not (Test-Path (Join-Path $Root 'node_modules'))) {
  Write-Host '  First start: installing Node packages...'
  & npm install --no-audit --no-fund | Out-Host
}

# -- ComfyUI --
if (-not $NoComfyUI) {
  if (Test-Url "$comfyUrl/system_stats") {
    Write-Host "  ComfyUI already running at $comfyUrl" -ForegroundColor Green
  } elseif ($comfyPath -and (Test-Path (Join-Path $comfyPath 'main.py'))) {
    $comfyPort = ([Uri]$comfyUrl).Port
    # Portable ComfyUI ships its own Python next to the ComfyUI folder.
    $portablePy = Join-Path (Split-Path $comfyPath -Parent) 'python_embeded\python.exe'
    $ownVenv = if ($IsWin) { Join-Path $comfyPath 'venv\Scripts\python.exe' } else { Join-Path $comfyPath 'venv/bin/python' }
    $sharedVenv = if ($IsWin) { Join-Path $Root '.venv\Scripts\python.exe' } else { Join-Path $Root '.venv/bin/python' }
    $py = @($portablePy, $ownVenv, $sharedVenv) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $py) { $py = 'python' }
    $extra = if (Test-Path $portablePy) { '--windows-standalone-build' } else { '' }
    # No NVIDIA GPU -> run ComfyUI on the CPU unless COMFYUI_ARGS says otherwise (e.g. --directml for AMD).
    $comfyArgs = $envVals['COMFYUI_ARGS']
    if (-not $comfyArgs -and -not (Get-Command 'nvidia-smi' -ErrorAction SilentlyContinue) -and $IsWin) { $comfyArgs = '--cpu' }
    $extra = "$extra $comfyArgs".Trim()
    Write-Host "  Starting ComfyUI from $comfyPath"
    Start-Window 'ComfyUI' "`"$py`" -s main.py --listen 127.0.0.1 --port $comfyPort $extra" $comfyPath
    Wait-Url "$comfyUrl/system_stats" 180 'ComfyUI' | Out-Null
  } else {
    Write-Host '  ComfyUI is not running. Start ComfyUI to enable local AI video generation.' -ForegroundColor Yellow
    Write-Host '  (Set COMFYUI_PATH in .env so start.bat can launch it. The local Python engine is used meanwhile.)' -ForegroundColor DarkGray
  }
}

# -- Web server --
if (Test-Url "$appUrl/api/settings") {
  Write-Host "  Server already running at $appUrl" -ForegroundColor Green
} else {
  Start-Window 'OpenReel Studio server' 'node server.js' $Root
  Wait-Url "$appUrl/api/settings" 60 'OpenReel server' | Out-Null
}

if (-not $NoBrowser) { Start-Process $appUrl }
Write-Host "  Open $appUrl in your browser. Close the server window to stop." -ForegroundColor Green
Write-Host ''
