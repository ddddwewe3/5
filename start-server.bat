@echo off
rem Starts only the OpenReel Studio web server (backend + UI) in this window.
title OpenReel Studio server
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Run setup.bat first.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing Node packages...
  call npm install --no-audit --no-fund
)
if not exist .env copy .env.example .env >nul
echo Starting OpenReel Studio on http://localhost:3000  (Ctrl+C to stop)
node server.js
pause
