@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "%USERPROFILE%\ComfyUI\venv" (echo [X] ComfyUI is not installed. Double-click install-windows.bat first. & pause & exit /b 1)
if not exist "%~dp0image-to-video\backend\.venv" (echo [X] Not installed yet. Double-click install-windows.bat first. & pause & exit /b 1)

echo Starting 3 windows: ComfyUI, video engine, website. Keep them open while you use the site.
start "1 - ComfyUI (AI)" cmd /k "cd /d %USERPROFILE%\ComfyUI && venv\Scripts\python.exe main.py --listen 127.0.0.1 --port 8188"
start "2 - Video engine" cmd /k "cd /d %~dp0image-to-video\backend && .venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000"
start "3 - Website" cmd /k "cd /d %~dp0 && npm start"

echo Waiting for everything to start...
timeout /t 20 /nobreak >nul
start "" http://localhost:3000/studio
echo The studio is open in your browser: http://localhost:3000/studio
echo If the dot is orange, wait 1 minute and press F5 (ComfyUI loads slowly the first time).
pause
