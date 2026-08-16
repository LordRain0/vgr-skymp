@echo off
setlocal
cd /d "%~dp0"

if not exist ".env" (
  echo Missing voice-test\.env
  echo Copy .env.example to .env, then enter the server's LiveKit API key and secret.
  pause
  exit /b 1
)

if not exist "node_modules\@livekit\rtc-node" (
  echo Installing the official LiveKit test dependencies...
  call npm.cmd --cache ".npm-cache" install --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

echo.
echo Starting the VGR three-player voice test...
node src\three-player-test.mjs
set "result=%errorlevel%"
echo.
if "%result%"=="0" echo Test finished successfully.
if not "%result%"=="0" echo Test did not pass. See the result above.
pause
exit /b %result%
