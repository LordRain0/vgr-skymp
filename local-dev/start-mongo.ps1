# Starts the local MongoDB (6.0.29, C:\mongodb-sp) if it isn't already running.
# Loopback only, auth enabled. Idempotent - safe to run every time.
# Admin credentials: see your local notes (authSource=admin, local only - never committed).
$ErrorActionPreference = 'Stop'
$bin = 'C:\mongodb-sp\mongodb-win32-x86_64-windows-6.0.29\bin'
if (Get-NetTCPConnection -LocalPort 27017 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host 'MongoDB already listening on 27017.'
    return
}
if (-not (Test-Path "$bin\mongod.exe")) {
    Write-Error "mongod.exe not found under $bin"
}
Start-Process -FilePath "$bin\mongod.exe" -ArgumentList '--config', "$bin\mongod.cfg" -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if (Get-NetTCPConnection -LocalPort 27017 -State Listen -ErrorAction SilentlyContinue) {
        Write-Host 'MongoDB started on 127.0.0.1:27017.'
        return
    }
}
Write-Error "MongoDB did not come up - check C:\mongodb-sp\log\mongod.log"
