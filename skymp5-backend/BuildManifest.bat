@echo off
setlocal

:: ============================================================
::   SkyRP manifest builder. Double-click to run.
::   Scans a reference MO2 install and writes the launcher
::   install manifest via scripts\compile-manifest.js.
::   When it finishes, send back data\install-manifest.json
::   and data\modlist.json.
:: ============================================================

set "BACKEND_DIR=%~dp0"
if "%BACKEND_DIR:~-1%"=="\" set "BACKEND_DIR=%BACKEND_DIR:~0,-1%"

echo.
echo === SkyRP manifest builder ===
echo.

:: Must sit next to scripts\compile-manifest.js
if not exist "%BACKEND_DIR%\scripts\compile-manifest.js" (
    echo [ERROR] scripts\compile-manifest.js not found next to this file.
    echo Keep this .bat inside the skymp5-backend folder and share the whole folder.
    pause
    exit /b 1
)

:: Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js was not found on PATH.
    echo Install the LTS version from https://nodejs.org and re-run this script.
    pause
    exit /b 1
)
for /f "delims=" %%v in ('node --version') do echo Found Node.js %%v

:: 7-Zip: a full install can read .rar archives, the bundled 7za cannot
set "SEVENZIP="
if defined SKYRP_7Z if exist "%SKYRP_7Z%" set "SEVENZIP=%SKYRP_7Z%"
if not defined SEVENZIP if exist "%ProgramFiles%\7-Zip\7z.exe" set "SEVENZIP=%ProgramFiles%\7-Zip\7z.exe"
if not defined SEVENZIP if exist "%ProgramFiles(x86)%\7-Zip\7z.exe" set "SEVENZIP=%ProgramFiles(x86)%\7-Zip\7z.exe"
if defined SEVENZIP goto :have_7z

:: No full 7-Zip: fall back to the bundled 7za from npm
if exist "%BACKEND_DIR%\node_modules\7zip-bin" goto :warn_7za
echo Installing the bundled 7-Zip helper...
pushd "%BACKEND_DIR%"
call npm install 7zip-bin
if errorlevel 1 (
    popd
    echo [ERROR] npm install failed - see output above.
    pause
    exit /b 1
)
popd
:warn_7za
echo [WARNING] Full 7-Zip not found. Any .rar downloads will be skipped and
echo their mods inlined into the manifest, which bloats it. Installing 7-Zip
echo from https://7-zip.org first is strongly recommended.
goto :sevenzip_done
:have_7z
set "SKYRP_7Z=%SEVENZIP%"
echo Found 7-Zip: %SEVENZIP%
:sevenzip_done

:: MO2 root: first argument, or prompt
set "MO2=%~1"
if defined MO2 goto :mo2_given
echo.
echo Enter the path to the reference MO2 folder
echo (the one containing mods\, downloads\ and profiles\):
set /p "MO2=MO2 folder: "
:mo2_given
if not defined MO2 (
    echo [ERROR] No MO2 folder given.
    pause
    exit /b 1
)
set "MO2=%MO2:"=%"
if not exist "%MO2%\mods" (
    echo [ERROR] "%MO2%\mods" not found - that does not look like an MO2 folder.
    pause
    exit /b 1
)

:: Game root: second argument, or prompt (optional, for skse64 loader files)
set "GAME=%~2"
if defined GAME goto :game_given
echo.
echo Enter the Skyrim SE game folder to capture skse64 loader files
echo (press Enter to skip):
set /p "GAME=Game folder: "
:game_given
if not defined GAME goto :game_done
set "GAME=%GAME:"=%"
if not exist "%GAME%" (
    echo [ERROR] "%GAME%" does not exist.
    pause
    exit /b 1
)
:game_done

:: Profile: third argument, or prompt, defaults to SkyRP
set "PROFILE=%~3"
if defined PROFILE goto :profile_given
echo.
echo Enter the ModOrganizer profile name
echo (press Enter for SkyRP):
set /p "PROFILE=Profile: "
:profile_given
if not defined PROFILE set "PROFILE=SkyRP"

echo.
echo MO2 root:  %MO2%
if defined GAME echo Game root: %GAME%
echo Profile:   %PROFILE%
echo.
echo Building manifest - large modlists can take a while...
echo.

pushd "%BACKEND_DIR%"
if defined GAME (
    node scripts\compile-manifest.js --mo2 "%MO2%" --game "%GAME%" --profile "%PROFILE%"
) else (
    node scripts\compile-manifest.js --mo2 "%MO2%" --profile "%PROFILE%"
)
if errorlevel 1 (
    popd
    echo.
    echo [ERROR] Manifest build failed - see output above.
    pause
    exit /b 1
)
popd

echo.
echo === Done ===
echo Send these two files back:
echo   %BACKEND_DIR%\data\install-manifest.json
echo   %BACKEND_DIR%\data\modlist.json
pause
