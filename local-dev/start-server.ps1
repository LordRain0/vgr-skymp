# Starts the local offline game server.
#   Game traffic: UDP 7777        Web UI / manifest: http://localhost:3000
# CWD must be build\dist\server - server-settings.json, gamemode.js, data/ and
# the world/ file database are all resolved relative to the process CWD.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'sync-gamemode.ps1')
$repo = Split-Path $PSScriptRoot -Parent
Set-Location (Join-Path $repo 'build\dist\server')
node dist_back\skymp5-server.js
