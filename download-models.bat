@echo off
rem Downloads free open-source video models for ComfyUI. Usage: download-models.bat [--model ltxv-2b^|wan22-5b^|wan21-1.3b]
cd /d "%~dp0"
node scripts\download-models.js %*
pause
