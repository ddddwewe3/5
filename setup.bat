@echo off
rem OpenReel Studio installer - checks and installs Node.js, FFmpeg, Python/PyTorch, ComfyUI, models and TTS.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
