# Starts the local backend API with auto-restart on file edits.
#   API: http://localhost:4000   Dashboard: :4002   WS relay: :7778
# Refuses to start if skymp5-backend\.env holds the PROD config (safety net for
# after someone restores the prod .env from W:\SkyMPRepos\_env-backups).
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$backend = Join-Path $repo 'skymp5-backend'
$envText = Get-Content (Join-Path $backend '.env') -Raw
if ($envText -notmatch '(?m)^SERVER_OFFLINE_MODE=true') {
    Write-Error "skymp5-backend\.env is not the LOCAL config (SERVER_OFFLINE_MODE=true not set). Refusing to start against prod settings - see local-dev\README.md."
}
if ($envText -match '(?m)^CLIENT_ZIP_URL=|^SERVER_ADDRESS=\S|api\.vengefulrealms\.com') {
    Write-Error "skymp5-backend\.env contains prod-looking values (CLIENT_ZIP_URL / SERVER_ADDRESS / vengefulrealms URLs). Refusing to start - see local-dev\README.md."
}
Set-Location $backend
npm run dev
