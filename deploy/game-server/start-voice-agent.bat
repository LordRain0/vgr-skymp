@echo off
setlocal

cd /d "%~dp0"

if not exist voice-agent.exe (
  echo voice-agent.exe was not found in %CD%
  echo Build it from the repository voice-agent folder first:
  echo.
  echo   cd /d D:\GitHub\skymp-vgr\voice-agent
  echo   go build -o ..\build\dist\server\LiveKit-Server\voice-agent.exe .
  echo.
  pause
  exit /b 1
)

set VOICE_AGENT_CONFIG=%CD%\voice-agent-config.json

voice-agent.exe

pause
