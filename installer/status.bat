@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo ============================================================
echo   Autopilot Jump Zero - Status
echo ============================================================
echo.

node "install.js" --status %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%

:nonode
echo.
echo [ERROR] Node.js was not found in PATH.
echo.
pause
exit /b 1