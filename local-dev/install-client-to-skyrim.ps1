# Installs THIS repo's client files into the Skyrim install and points them at
# the local offline server (127.0.0.1:7777).
#
# WARNING: the Skyrim install currently contains a DIFFERENT community's SkyMP
# client (Keizaal - dl.keizaal.com). This script backs it up on first run;
# restore-skyrim-client.ps1 puts it back so you can play there again.
$ErrorActionPreference = 'Stop'
$skyrim = 'S:\SteamLibrary\steamapps\common\Skyrim Special Edition'
$repo = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path (Join-Path $skyrim 'SkyrimSE.exe'))) {
    Write-Error "Skyrim not found at $skyrim"
}

# Client files source. A source only qualifies as the BASE if it is complete
# (TS bundle + SkyrimPlatform.dll + MpClientPlugin.dll) - a yarn-only build of
# skymp5-client produces just the TS bundle and must be overlaid on a full base,
# never installed alone (that would leave the previous fork's DLLs in place).
function Test-CompleteClient($root) {
    (Test-Path (Join-Path $root 'Data\Platform\Plugins\skymp5-client.js')) -and
    (Test-Path (Join-Path $root 'Data\SKSE\Plugins\SkyrimPlatform.dll')) -and
    (Test-Path (Join-Path $root 'Data\SKSE\Plugins\MpClientPlugin.dll'))
}
$distClient = Join-Path $repo 'build\dist\client'
$bucketRoot = Join-Path $repo 'build\client-files\root'
if (Test-CompleteClient $distClient) { $srcRoot = $distClient }
elseif (Test-CompleteClient $bucketRoot) { $srcRoot = $bucketRoot }
else { Write-Error 'No complete client files found (build\dist\client or build\client-files\root). Build first.' }

# One-time backup of the pristine pre-VGR state (never overwritten afterwards)
$backup = Join-Path $skyrim 'VGR-local-client-backup'
if (-not (Test-Path $backup)) {
    New-Item -ItemType Directory $backup | Out-Null
    if (Test-Path (Join-Path $skyrim 'Data\Platform')) {
        Copy-Item (Join-Path $skyrim 'Data\Platform') (Join-Path $backup 'Platform') -Recurse
    }
    if (Test-Path (Join-Path $skyrim 'Data\SKSE\Plugins')) {
        Copy-Item (Join-Path $skyrim 'Data\SKSE\Plugins') (Join-Path $backup 'SKSE-Plugins') -Recurse
    }
    Write-Host "Backed up existing (Keizaal) client to $backup"
}

# Replace the Platform tree wholesale so no stale foreign plugins survive,
# then overlay everything else (SKSE dlls etc.) on top of Data
Remove-Item (Join-Path $skyrim 'Data\Platform') -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $srcRoot 'Data\*') (Join-Path $skyrim 'Data\') -Recurse -Force

# Overlay newer partial outputs on top of the base:
# 1) a yarn-built TS bundle from build\dist\client (if it wasn't already the base)
if (($srcRoot -ne $distClient) -and (Test-Path (Join-Path $distClient 'Data'))) {
    Copy-Item (Join-Path $distClient 'Data\*') (Join-Path $skyrim 'Data\') -Recurse -Force
    Write-Host 'Overlaid fresh TS bundle from build\dist\client'
}
# 2) the working-tree in-game UI (what the cmake vgr_frontend_client_ui target copies verbatim)
$ui = Join-Path $repo 'vgr-frontend'
if (Test-Path $ui) {
    $uiDest = Join-Path $skyrim 'Data\Platform\UI'
    New-Item -ItemType Directory -Force $uiDest | Out-Null
    Copy-Item (Join-Path $ui '*') $uiDest -Recurse -Force
    Write-Host 'Overlaid vgr-frontend working tree into Data\Platform\UI'
}

# LiveKit voice dlls belong next to SkyrimSE.exe
foreach ($dll in 'livekit.dll', 'livekit_ffi.dll') {
    $p = Join-Path $srcRoot $dll
    if (Test-Path $p) { Copy-Item $p $skyrim -Force }
}

# Offline client settings (JSON despite the .txt extension).
# gameData.profileId = the integer identity in the local world DB; the launcher
# is bypassed entirely, so this file is the whole auth story.
# server-info-ignore avoids a 5s gateway.skymp.net fallback lookup on connect.
$settings = @'
{
  "server-ip": "127.0.0.1",
  "server-port": 7777,
  "master": "",
  "server-master-key": null,
  "gameData": { "profileId": 1 },
  "server-info-ignore": true,
  "ignoreLoadOrderMismatch": true
}
'@
$pluginsDir = Join-Path $skyrim 'Data\Platform\Plugins'
New-Item -ItemType Directory -Force $pluginsDir | Out-Null
# BOM-less UTF-8 (PS 5.1's -Encoding utf8 adds a BOM that breaks the client's JSON parse)
[System.IO.File]::WriteAllText((Join-Path $pluginsDir 'skymp5-client-settings.txt'), $settings, [System.Text.UTF8Encoding]::new($false))
Write-Host "VGR client installed from $srcRoot"
Write-Host "Offline settings written. Start the local server, then launch:"
Write-Host "  `"$skyrim\skse64_loader.exe`""
