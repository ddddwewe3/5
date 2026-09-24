@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Collecting diagnostics... (keep ComfyUI and the video engine running while this runs)
py scripts\diagnose.py --comfyui "%USERPROFILE%\ComfyUI"
start "" notepad "%~dp0diagnose-report.txt"
echo.
echo The report opened in Notepad. Select all (Ctrl+A), copy (Ctrl+C) and paste it in the chat.
pause
