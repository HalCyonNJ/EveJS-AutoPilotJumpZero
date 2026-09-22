@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

echo ============================================================
echo   Autopilot Jump Zero - Uninstall / Rollback
echo ============================================================
echo.
echo   Usage:
echo     uninstall.bat --server "C:\path\to\EveJS"
echo     uninstall.bat --server "C:\path\to\EveJS" --dry-run
echo     uninstall.bat --server "C:\path\to\EveJS" --keep-files
echo.
echo   Removes the preload from both deployments and archives the mod
echo   folder under ^<EveJS root^>\_beta-autopilotjumpzero-backup\.
echo.
echo ------------------------------------------------------------
echo.

node "uninstall.js" %*
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
echo         This package needs Node.js 18 or newer.
echo         Download: https://nodejs.org/
echo.
pause
exit /b 1