@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo ============================================================
echo   Autopilot Jump Zero - Build distribution packages
echo ============================================================
echo.

node "tools\build-package.js"
set RC=%ERRORLEVEL%
echo.
echo ------------------------------------------------------------
echo   Exit code: %RC%
echo.
pause
exit /b %RC%

:nonode
echo.
echo [ERROR] Node.js was not found in PATH.
echo.
pause
exit /b 1