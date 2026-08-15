# Regenerates the admin-panel item/ability/NPC catalogs from the server's
# load order. Run whenever the load order changes (it shifts runtime formIds).
# Plugins come from the server data dir (all 174); .strings names come from the
# client game copy's vanilla BSA (the server data dir ships no .strings).
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$bsa = 'W:\VengefulRealms\skyrim\Data\Skyrim - Interface.bsa'
if (-not (Test-Path $bsa)) {
    Write-Error "Vanilla strings BSA not found at $bsa - point -strings at a full client game copy's 'Skyrim - Interface.bsa'."
}
node (Join-Path $repo 'tools\build_catalogs.js') `
    --settings (Join-Path $repo 'build\dist\server\server-settings.json') `
    --data (Join-Path $repo 'build\dist\server\data') `
    --strings $bsa `
    --out (Join-Path $repo 'vgr-frontend\js\data') `
    --validate
Write-Host "Catalogs written to vgr-frontend\js\data\ - commit them (build output, shipped with the UI)."
