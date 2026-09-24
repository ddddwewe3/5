@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   Vesion - install (run once). This downloads about 20 GB.
echo ============================================================

where git >nul 2>nul || (echo [X] Git is missing. Install it from https://git-scm.com/download/win & pause & exit /b 1)
where py >nul 2>nul || (echo [X] Python is missing. Install Python 3.12 from https://www.python.org and tick "Add python.exe to PATH" & pause & exit /b 1)
where npm >nul 2>nul || (echo [X] Node.js is missing. Install the LTS version from https://nodejs.org & pause & exit /b 1)

echo.
echo [1/3] Installing ComfyUI and the free Wan 2.2 model...
powershell -ExecutionPolicy Bypass -File "%~dp0scripts\setup-comfyui.ps1" || (echo [X] ComfyUI setup failed. Send a screenshot of this window. & pause & exit /b 1)

echo.
echo [2/3] Installing the video engine...
cd /d "%~dp0image-to-video\backend"
if not exist .venv py -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt || (echo [X] Engine install failed. & pause & exit /b 1)

echo.
echo [3/3] Installing the website...
cd /d "%~dp0"
call npm install || (echo [X] npm install failed. & pause & exit /b 1)

echo.
echo ============================================================
echo   Done! Now double-click start-windows.bat
echo ============================================================
pause
