@echo off
setlocal

cd /d "%~dp0"
call npm.cmd start

if errorlevel 1 (
    echo.
    echo [ERROR] Launcher failed to start - see output above.
    pause
)
