@echo off
setlocal

cd /d "%~dp0"

set /p LIVEKIT_KEYS=<livekit-keys.txt

livekit-server.exe --bind 0.0.0.0 --dev

pause
