@echo off
node dist_back/skymp5-server.js
set "SERVER_EXIT=%ERRORLEVEL%"
echo [%DATE% %TIME%] Server exited with code %SERVER_EXIT%>>server-exits.log
echo Server exit code: %SERVER_EXIT%
pause