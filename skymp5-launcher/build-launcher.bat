@echo off
setlocal

cd /d "%~dp0"

if not exist node_modules\.package-lock.json (
  echo Dependencies are not installed.
  echo Run install-dependencies.bat first, then run this file again.
  goto failed
)

echo Building launcher...
call npm.cmd run build:win
if errorlevel 1 goto failed

echo.
echo Done. Installer should be at:
echo %~dp0..\build\launcher\SkyrimRoleplayLauncher.exe
echo Version file should be at:
echo %~dp0..\build\launcher\launcher-version.txt
pause
exit /b 0

:failed
echo.
echo Build failed.
pause
exit /b 1
