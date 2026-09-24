@echo off
rem Starts everything: ComfyUI (if installed), the OpenReel server, and opens the browser.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
if errorlevel 1 pause
