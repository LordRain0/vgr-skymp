@echo off
rem ════════════════════════════════════════════════════════════════════════════
rem  VGR local offline test: starts the game server AND Skyrim, no launcher.
rem  One-time prerequisites (see local-dev\README.md):
rem    - server built (cmake) -> build\dist\server exists
rem    - modlist installed once via the launcher (MO2 mode), OR the client
rem      installed directly via install-client-to-skyrim.ps1 (direct mode)
rem ════════════════════════════════════════════════════════════════════════════
setlocal
rem REPO is derived from this script's location; the machine-specific paths
rem below can be overridden via environment variables before launching.
set "REPO=%~dp0.."
if not defined MO2_DIR set "MO2_DIR=W:\VengefulRealms\MO2"
if not defined MO2_PROFILE set "MO2_PROFILE=VengefulRealms"
if not defined MO2_EXE_TITLE set "MO2_EXE_TITLE=SKSE"
if not defined SKYRIM_DIR set "SKYRIM_DIR=S:\SteamLibrary\steamapps\common\Skyrim Special Edition"

if not exist "%REPO%\build\dist\server\dist_back\skymp5-server.js" (
    echo [!] No built server at build\dist\server - run the cmake build first ^(local-dev\README.md^).
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [!] node.exe is not on PATH. The local server AND the settings writer
    echo     need Node.js - without it the game silently keeps its old ^(prod^)
    echo     settings and connects to the LIVE server. Install Node.js first.
    pause
    exit /b 1
)

echo [1/3] Starting local MongoDB (if installed and not already running)...
if exist "C:\mongodb-sp" powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\local-dev\start-mongo.ps1"

echo [2/3] Starting game server (UDP 7777, web UI http://localhost:3000)...
rem -NoExit keeps the window open if the server crashes so the error is readable
start "VGR local server" powershell -NoProfile -NoExit -ExecutionPolicy Bypass -File "%REPO%\local-dev\start-server.ps1"

echo [3/3] Launching Skyrim...
if exist "%MO2_DIR%\mods\Vengeful Realms - Client\Platform\Plugins\skymp5-client.js" (
    echo     via MO2 profile "%MO2_PROFILE%" - full modlist active
    powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\local-dev\write-offline-client-settings.ps1" -Mo2Dir "%MO2_DIR%"
    findstr /C:"127.0.0.1" "%MO2_DIR%\mods\Vengeful Realms - Client\Platform\Plugins\skymp5-client-settings.txt" >nul 2>&1
    if errorlevel 1 (
        echo [!] SETTINGS WRITE FAILED - the client settings file does not point at
        echo     127.0.0.1. Launching now would connect to the LIVE server. Aborting.
        pause
        exit /b 1
    )
    rem overlay working-tree client bundle + in-game UI so dev edits reach the game
    if exist "%REPO%\build\dist\client\Data\Platform\Plugins\skymp5-client.js" (
        copy /Y "%REPO%\build\dist\client\Data\Platform\Plugins\skymp5-client.js" "%MO2_DIR%\mods\Vengeful Realms - Client\Platform\Plugins\skymp5-client.js" >nul
        echo     overlaid dev skymp5-client.js from build\dist\client
    )
    if exist "%REPO%\vgr-frontend\index.html" (
        xcopy /E /Y /Q "%REPO%\vgr-frontend\*" "%MO2_DIR%\mods\Vengeful Realms - Client\Platform\UI\" >nul
        echo     overlaid vgr-frontend working tree into mod UI
    )
    start "" "%MO2_DIR%\ModOrganizer.exe" -p "%MO2_PROFILE%" "moshortcut://:%MO2_EXE_TITLE%"
) else if exist "%SKYRIM_DIR%\Data\Platform\Plugins\skymp5-client.js" (
    echo     direct skse64_loader from "%SKYRIM_DIR%" - no modlist
    powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO%\local-dev\write-offline-client-settings.ps1" -SkyrimDir "%SKYRIM_DIR%"
    findstr /C:"127.0.0.1" "%SKYRIM_DIR%\Data\Platform\Plugins\skymp5-client-settings.txt" >nul 2>&1
    if errorlevel 1 (
        echo [!] SETTINGS WRITE FAILED - the client settings file does not point at
        echo     127.0.0.1. Launching now would connect to the LIVE server. Aborting.
        pause
        exit /b 1
    )
    start "" /D "%SKYRIM_DIR%" "%SKYRIM_DIR%\skse64_loader.exe"
) else (
    echo [!] No client installed yet. Either:
    echo       - run the launcher once to install the modlist into "%MO2_DIR%" ^(MO2 mode^), or
    echo       - run local-dev\install-client-to-skyrim.ps1 ^(direct mode^)
    pause
    exit /b 1
)
echo Done. Server runs in its own window - close it or Ctrl+C to stop.
endlocal
