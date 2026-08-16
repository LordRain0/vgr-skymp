@echo off
setlocal

cd /d "%~dp0"

echo Installing dependencies...
call npm.cmd ci
if errorlevel 1 goto failed

echo.
echo Dependencies installed.
pause
exit /b 0

:failed
echo.
echo Dependency install failed.
pause
exit /b 1
