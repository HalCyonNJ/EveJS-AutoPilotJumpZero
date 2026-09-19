@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo ============================================================
echo   Autopilot Jump Zero - Installer
echo ============================================================
echo.
echo   Usage:
echo     install.bat --server "C:\path\to\EveJS"
echo     install.bat --server "C:\path\to\EveJS" --dry-run
echo     install.bat --server "C:\path\to\EveJS" --docker-only
echo     install.bat --server "C:\path\to\EveJS" --native-only
echo.
echo   Registers the preload for both deployments when both are found:
echo     Docker  docker/entrypoint.sh
echo     Native  StartServer.bat
echo.
echo   Files that are about to change are backed up under
echo   ^<EveJS root^>\_autopilotjumpzero-backup\ by default.
echo.
echo   If --server is omitted the installer auto-detects the EveJS root.
echo.
echo ------------------------------------------------------------
echo.

node "install.js" %*
set RC=%ERRORLEVEL%
echo.
echo ------------------------------------------------------------
echo   Exit code: %RC%
if not "%RC%"=="0" echo   (non-zero = failed, see messages above)
echo.
pause
exit /b %RC%

:nonode
echo.
echo [ERROR] Node.js was not found in PATH.
echo         This package needs Node.js 18 or newer.
echo         Download: https://nodejs.org/
echo.
pause
exit /b 1