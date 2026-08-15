@echo off
:: Ran by win-acme after each certificate renewal so nginx picks up the new pems
:: -s reload can fail across sessions, fall back to a full service restart
"C:\nginx\nginx.exe" -p "C:\nginx" -s reload
if errorlevel 1 (
    net stop vengefulrealmsNginx
    net start vengefulrealmsNginx
)
