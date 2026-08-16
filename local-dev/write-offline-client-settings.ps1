# Writes the offline-mode client settings file (JSON despite the .txt name).
# MO2 mode:    goes into the 'Vengeful Realms - Client' mod (the launcher strips
#              the leading 'Data', MO2's VFS maps it back to Data\Platform\Plugins).
# Direct mode: goes into <SkyrimDir>\Data\Platform\Plugins.
#
# Also ensures the local server has a gamemode-script signing key and pins its
# public key here - without this the client silently rejects ALL server-sent
# gamemode JS (UI manager, menus, property scripts) with 'no signature found'.
param(
    [string]$Mo2Dir,
    [string]$SkyrimDir,
    [int]$Port = 7777,
    [int]$ProfileId = 1
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent

if ($Mo2Dir) {
    $pluginsDir = Join-Path $Mo2Dir 'mods\Vengeful Realms - Client\Platform\Plugins'
} elseif ($SkyrimDir) {
    $pluginsDir = Join-Path $SkyrimDir 'Data\Platform\Plugins'
} else {
    Write-Error 'Pass -Mo2Dir <MO2 root> or -SkyrimDir <game dir>.'
}

# Ensure local signing key exists server-side; get {keyId, pub} for pinning.
# NEVER die here: a failed key step must still write the 127.0.0.1 settings,
# otherwise the game keeps whatever file exists (often the launcher's PROD
# settings) and silently connects to the live server.
$srvSettings = Join-Path $repo 'build\dist\server\server-settings.json'
$keyInfo = $null
if (-not (Test-Path $srvSettings)) {
    Write-Warning "No built server at $srvSettings - writing settings WITHOUT server-public-keys (gamemode menus won't work until the server exists and this reruns)."
} elseif (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Warning "node.exe is not on PATH - writing settings WITHOUT server-public-keys. Install Node.js; the local server itself cannot run without it either."
} else {
    try {
        $keyInfo = node (Join-Path $PSScriptRoot 'ensure-server-key.js') $srvSettings | ConvertFrom-Json
    } catch {
        Write-Warning "Signing-key setup failed ($($_.Exception.Message)) - writing settings WITHOUT server-public-keys (gamemode menus won't work, but the client will still point at 127.0.0.1)."
    }
}

$settings = [ordered]@{
    'server-ip'               = '127.0.0.1'
    'server-port'             = $Port
    'master'                  = ''
    'server-master-key'       = $null
    'gameData'                = [ordered]@{ profileId = $ProfileId }
    'server-info-ignore'      = $true
    'ignoreLoadOrderMismatch' = $true
}
if ($keyInfo) {
    $settings['server-public-keys'] = [ordered]@{ $keyInfo.keyId = $keyInfo.pub }
}

$json = $settings | ConvertTo-Json -Depth 5
New-Item -ItemType Directory -Force $pluginsDir | Out-Null
# BOM-less UTF-8: PS 5.1's -Encoding utf8 writes a BOM, which breaks the
# client's JSON.parse of this file ("Unexpected token" on game start).
[System.IO.File]::WriteAllText((Join-Path $pluginsDir 'skymp5-client-settings.txt'), $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Offline client settings written to $pluginsDir\skymp5-client-settings.txt (profileId $ProfileId, port $Port, signing key: $(if ($keyInfo) { $keyInfo.keyId } else { 'NONE' }))"
