# Copies the VGR gamemode into the built server directory.
# Needed because the cmake build writes an EMPTY gamemode.js (BUILD_GAMEMODE=OFF
# fetches the upstream gamemode, not VGR's), and vgr-gamemode/gamemode.js
# resolves gamemode_extensions/ from the server's working directory.
# Re-run after every cmake build and after editing gamemode_extensions/*.js
# (extension edits also need a server restart - they are require()-cached).
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $repo 'build\dist\server'
if (-not (Test-Path (Join-Path $dist 'dist_back\skymp5-server.js'))) {
    Write-Error "No built server at $dist - run the cmake build first (see local-dev\README.md)."
}
Copy-Item (Join-Path $repo 'vgr-gamemode\gamemode.js') (Join-Path $dist 'gamemode.js') -Force
Remove-Item (Join-Path $dist 'gamemode_extensions') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $repo 'vgr-gamemode\gamemode_extensions') $dist -Recurse -Force
Write-Host "Gamemode synced to $dist"
