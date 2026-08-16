# Restores the Skyrim install's original (pre-VGR, Keizaal) SkyMP client from
# the backup taken by install-client-to-skyrim.ps1.
$ErrorActionPreference = 'Stop'
$skyrim = 'S:\SteamLibrary\steamapps\common\Skyrim Special Edition'
$backup = Join-Path $skyrim 'VGR-local-client-backup'
if (-not (Test-Path $backup)) {
    Write-Error "No backup found at $backup - nothing to restore."
}
Remove-Item (Join-Path $skyrim 'Data\Platform') -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path (Join-Path $backup 'Platform')) {
    Copy-Item (Join-Path $backup 'Platform') (Join-Path $skyrim 'Data\Platform') -Recurse
}
if (Test-Path (Join-Path $backup 'SKSE-Plugins')) {
    # /MIR removes VGR-added dlls and restores the originals exactly
    robocopy (Join-Path $backup 'SKSE-Plugins') (Join-Path $skyrim 'Data\SKSE\Plugins') /MIR /NJH /NJS /NDL /NFL | Out-Null
    if ($LASTEXITCODE -ge 8) { Write-Error "robocopy failed with exit code $LASTEXITCODE" }
}
Write-Host "Restored the pre-VGR client from $backup"
exit 0
