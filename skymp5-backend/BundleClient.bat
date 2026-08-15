@echo off
setlocal

:: ============================================================
::   SkyRP client bundle builder. Double-click to run.
::   Rebuilds build\client-files\skymp-client.zip from the
::   already-built client output in build\dist\client.
::   This does not compile the SkyMP client.
:: ============================================================

set "BACKEND_DIR=%~dp0"
if "%BACKEND_DIR:~-1%"=="\" set "BACKEND_DIR=%BACKEND_DIR:~0,-1%"
set "REPO_DIR=%BACKEND_DIR%\.."
set "CLIENT_DIST=%REPO_DIR%\build\dist\client"
set "CLIENT_DATA=%CLIENT_DIST%\Data"
set "ZIP_PATH=%REPO_DIR%\build\client-files\skymp-client.zip"
set "VERSION_FILE=%BACKEND_DIR%\data\files-version.json"

echo.
echo === SkyRP client bundle builder ===
echo.

if not exist "%BACKEND_DIR%\scripts\populate-files.js" (
    echo [ERROR] scripts\populate-files.js not found.
    echo Keep this .bat inside the skymp5-backend folder.
    pause
    exit /b 1
)

if not exist "%BACKEND_DIR%\scripts\merge-files.js" (
    echo [ERROR] scripts\merge-files.js not found.
    echo Keep this .bat inside the skymp5-backend folder.
    pause
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found on PATH.
    echo Install the LTS version from https://nodejs.org and re-run this script.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo Found Node.js %%v

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm was not found on PATH.
    echo Install Node.js with npm and re-run this script.
    pause
    exit /b 1
)

if not exist "%CLIENT_DATA%" (
    echo.
    echo [ERROR] Client build output not found:
    echo   %CLIENT_DATA%
    echo.
    echo Rebuild the client first, then run this bundler again.
    pause
    exit /b 1
)

if not exist "%BACKEND_DIR%\node_modules" (
    echo.
    echo Installing backend npm dependencies...
    pushd "%BACKEND_DIR%"
    call npm install
    if errorlevel 1 (
        popd
        echo.
        echo [ERROR] npm install failed - see output above.
        pause
        exit /b 1
    )
    popd
)

echo.
echo Client source:
echo   %CLIENT_DIST%
echo Output zip:
echo   %ZIP_PATH%
echo Version file:
echo   %VERSION_FILE%
echo.
echo Bundling client files...
echo.

pushd "%BACKEND_DIR%"
if exist "%ZIP_PATH%" del /f /q "%ZIP_PATH%"

node scripts\populate-files.js
if errorlevel 1 (
    popd
    echo.
    echo [ERROR] Client populate failed - see output above.
    pause
    exit /b 1
)

node scripts\merge-files.js
if errorlevel 1 (
    popd
    echo.
    echo [ERROR] Client zip build failed - see output above.
    pause
    exit /b 1
)
popd

if not exist "%ZIP_PATH%" (
    echo.
    echo [ERROR] Bundle command completed, but zip was not created:
    echo   %ZIP_PATH%
    pause
    exit /b 1
)

echo.
echo === Done ===
echo Created:
echo   %ZIP_PATH%
if exist "%VERSION_FILE%" echo Updated:
if exist "%VERSION_FILE%" echo   %VERSION_FILE%
pause
