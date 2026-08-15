@echo off
setlocal EnableDelayedExpansion
::  Install the game server (and LiveKit voice) as Windows services via nssm,
::  so the Server Manager's Console tab can start/stop/restart them.
::  Run as Administrator. Safe to re-run: existing services are reconfigured.
::
::  The game server currently runs manually via C:\skymp\server\launch_server.bat;
::  this replaces that with a supervised service that auto-restarts on crash and
::  logs to C:\logs\gameserver.log (the manager tails and rotates it).

net session >nul 2>&1
if errorlevel 1 (
    echo Run this as Administrator.
    pause
    exit /b 1
)

set "NSSM=C:\tools\nssm\nssm.exe"
if not exist "%NSSM%" set "NSSM=nssm"

set "SERVER_DIR=C:\skymp\server"
set "LOG_DIR=C:\logs"
if not "%~1"=="" set "SERVER_DIR=%~1"

for /f "delims=" %%i in ('where node') do set "NODE_EXE=%%i" & goto :gotnode
echo [ERROR] node.exe not found on PATH.
pause
exit /b 1
:gotnode

if not exist "%SERVER_DIR%\dist_back\skymp5-server.js" (
    echo [ERROR] %SERVER_DIR%\dist_back\skymp5-server.js not found - pass the server dir as an argument.
    pause
    exit /b 1
)
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

echo Installing/updating VgrGameServer (%SERVER_DIR%)...
"%NSSM%" status VgrGameServer >nul 2>&1
if errorlevel 1 "%NSSM%" install VgrGameServer "%NODE_EXE%" "dist_back/skymp5-server.js"
"%NSSM%" set VgrGameServer Application "%NODE_EXE%"
"%NSSM%" set VgrGameServer AppParameters "dist_back/skymp5-server.js"
"%NSSM%" set VgrGameServer AppDirectory "%SERVER_DIR%"
"%NSSM%" set VgrGameServer AppStdout "%LOG_DIR%\gameserver.log"
"%NSSM%" set VgrGameServer AppStderr "%LOG_DIR%\gameserver-err.log"
"%NSSM%" set VgrGameServer AppRotateFiles 1
"%NSSM%" set VgrGameServer AppRotateBytes 10485760
"%NSSM%" set VgrGameServer AppExit Default Restart
"%NSSM%" set VgrGameServer AppRestartDelay 5000
"%NSSM%" set VgrGameServer Start SERVICE_DEMAND_START
"%NSSM%" set VgrGameServer Description "Vengeful Realms SkyMP game server"

:: LiveKit: mirror start-livekit.bat (LIVEKIT_KEYS from livekit-keys.txt,
:: livekit-server.exe --bind 0.0.0.0 --dev).
set "LK_DIR=%SERVER_DIR%\LiveKit-Server\livekit_1.13.1_windows_amd64"
if exist "%LK_DIR%\livekit-server.exe" (
    echo Installing/updating VgrLiveKit (%LK_DIR%)...
    set /p LK_KEYS=<"%LK_DIR%\livekit-keys.txt"
    "%NSSM%" status VgrLiveKit >nul 2>&1
    if errorlevel 1 "%NSSM%" install VgrLiveKit "%LK_DIR%\livekit-server.exe"
    "%NSSM%" set VgrLiveKit Application "%LK_DIR%\livekit-server.exe"
    "%NSSM%" set VgrLiveKit AppParameters "--bind 0.0.0.0 --dev"
    "%NSSM%" set VgrLiveKit AppDirectory "%LK_DIR%"
    "%NSSM%" set VgrLiveKit AppEnvironmentExtra "LIVEKIT_KEYS=!LK_KEYS!"
    "%NSSM%" set VgrLiveKit AppStdout "%LOG_DIR%\livekit.log"
    "%NSSM%" set VgrLiveKit AppStderr "%LOG_DIR%\livekit-err.log"
    "%NSSM%" set VgrLiveKit AppRotateFiles 1
    "%NSSM%" set VgrLiveKit AppRotateBytes 10485760
    "%NSSM%" set VgrLiveKit AppExit Default Restart
    "%NSSM%" set VgrLiveKit Start SERVICE_DEMAND_START
    "%NSSM%" set VgrLiveKit Description "LiveKit voice media server for Vengeful Realms"
) else (
    echo LiveKit not found at %LK_DIR% - skipping VgrLiveKit.
)

:: Voice agent: mirror start-voice-agent.bat (VOICE_AGENT_CONFIG env var).
set "VA_DIR=%SERVER_DIR%\LiveKit-Server"
if exist "%VA_DIR%\voice-agent.exe" (
    echo Installing/updating VgrVoiceAgent (%VA_DIR%)...
    "%NSSM%" status VgrVoiceAgent >nul 2>&1
    if errorlevel 1 "%NSSM%" install VgrVoiceAgent "%VA_DIR%\voice-agent.exe"
    "%NSSM%" set VgrVoiceAgent Application "%VA_DIR%\voice-agent.exe"
    "%NSSM%" set VgrVoiceAgent AppDirectory "%VA_DIR%"
    "%NSSM%" set VgrVoiceAgent AppEnvironmentExtra "VOICE_AGENT_CONFIG=%VA_DIR%\voice-agent-config.json"
    "%NSSM%" set VgrVoiceAgent AppStdout "%LOG_DIR%\voice-agent.log"
    "%NSSM%" set VgrVoiceAgent AppStderr "%LOG_DIR%\voice-agent-err.log"
    "%NSSM%" set VgrVoiceAgent AppRotateFiles 1
    "%NSSM%" set VgrVoiceAgent AppRotateBytes 10485760
    "%NSSM%" set VgrVoiceAgent AppExit Default Restart
    "%NSSM%" set VgrVoiceAgent Start SERVICE_DEMAND_START
    "%NSSM%" set VgrVoiceAgent Description "Proximity voice agent for Vengeful Realms"
) else (
    echo voice-agent.exe not found at %VA_DIR% - skipping VgrVoiceAgent.
)

echo.
echo Done. Services are installed but NOT started - use the Server Manager
echo Console tab (or: nssm start VgrGameServer) when you want them running.
echo The game server was previously started via launch_server.bat; from now on
echo start it through the service so only one copy runs at a time.
pause
