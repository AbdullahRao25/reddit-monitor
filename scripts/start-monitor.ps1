#requires -version 5.1
<#
  One-click launcher: runs the monitor on this machine.

  Double-click "Start Monitor.cmd" in the folder above rather than calling this
  directly. It installs dependencies and rebuilds the dashboard only when they
  are missing or stale, starts the API, and opens the browser once the port
  answers. The server lives for as long as this window stays open; Ctrl+C or
  closing the window stops it.

  Switches:
    -NoBrowser        start the server without opening a browser tab
    -Rebuild          force a dashboard rebuild even if it looks current
    -Tunnel <target>  also open the relay reverse tunnel to <user@host>
                      (see docker-compose.tunnel.yml). A target saved in
                      scripts/relay-host.txt is used automatically.
#>
[CmdletBinding()]
param(
  [switch]$NoBrowser,
  [switch]$Rebuild,
  [string]$Tunnel
)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $PSScriptRoot
Set-Location $AppRoot

function Write-Step($text) { Write-Host "  $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  $text" -ForegroundColor Green }
function Write-Note($text) { Write-Host "  $text" -ForegroundColor Yellow }

function Fail($text) {
  Write-Host ''
  Write-Host "  $text" -ForegroundColor Red
  Write-Host ''
  exit 1
}

# The port is whatever server/.env says, so this keeps working if PORT changes.
$port = 4000
$envFile = Join-Path $AppRoot 'server\.env'
if (Test-Path $envFile) {
  $match = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
  if ($match) { $port = [int]$match.Matches[0].Groups[1].Value }
} else {
  Write-Note 'server\.env is missing, so the dashboard will show the setup checklist.'
  Write-Note 'Copy server\.env.example to server\.env and fill it in.'
}
$url = "http://127.0.0.1:$port"

function Test-Port($p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { $client.Connect('127.0.0.1', $p); return $true }
  catch { return $false }
  finally { $client.Dispose() }
}

Write-Host ''
Write-Host '  Reddit account monitor' -ForegroundColor White
Write-Host ''

# Already up: don't fight over the port, just bring the window forward.
if (Test-Port $port) {
  Write-Ok "Already running on $url"
  if (-not $NoBrowser) { Start-Process $url }
  Start-Sleep -Seconds 2
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail 'Node.js is not on PATH. Install it from https://nodejs.org (version 20 or newer), then try again.'
}

if (-not (Test-Path (Join-Path $AppRoot 'node_modules'))) {
  Write-Step 'Installing dependencies (first run only, takes a minute)...'
  npm install
  if ($LASTEXITCODE -ne 0) { Fail 'npm install failed. The messages above say why.' }
}

# Rebuild the dashboard only when something it is built from is newer than it.
$distIndex = Join-Path $AppRoot 'client\dist\index.html'
$needBuild = $Rebuild.IsPresent -or -not (Test-Path $distIndex)
if (-not $needBuild) {
  $sources = @(Get-ChildItem (Join-Path $AppRoot 'client\src') -Recurse -File)
  foreach ($name in @('index.html', 'vite.config.js', 'package.json')) {
    $path = Join-Path $AppRoot "client\$name"
    if (Test-Path $path) { $sources += Get-Item $path }
  }
  $newest = $sources | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($newest -and $newest.LastWriteTime -gt (Get-Item $distIndex).LastWriteTime) {
    Write-Step "Dashboard changed ($($newest.Name)), rebuilding..."
    $needBuild = $true
  }
} elseif (-not $Rebuild.IsPresent) {
  Write-Step 'No dashboard build yet, building it...'
}
if ($needBuild) {
  if ($Rebuild.IsPresent) { Write-Step 'Rebuilding the dashboard...' }
  npm run build
  if ($LASTEXITCODE -ne 0) { Fail 'The dashboard build failed. The messages above say why.' }
}

# Relay mode: this machine does the Reddit requests, the VM only terminates TLS.
$relayFile = Join-Path $PSScriptRoot 'relay-host.txt'
if (-not $Tunnel -and (Test-Path $relayFile)) {
  $Tunnel = ((Get-Content $relayFile) -join "`n").Trim()
}
$ssh = $null
if ($Tunnel) {
  Write-Step "Opening the relay tunnel to $Tunnel ..."
  $ssh = Start-Process ssh -PassThru -ArgumentList @(
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-R', "${port}:127.0.0.1:$port",
    $Tunnel
  )
}

# Open the browser from a hidden helper once the port accepts a connection, so
# the tab never lands on a refused request. A TCP check works whether or not
# sign-in is required (/api/status answers 401 until you are signed in).
if (-not $NoBrowser) {
  $probe = "for (`$i = 0; `$i -lt 90; `$i++) { try { `$c = New-Object System.Net.Sockets.TcpClient; `$c.Connect('127.0.0.1', __PORT__); `$c.Close(); Start-Process '__URL__'; break } catch { Start-Sleep -Milliseconds 400 } }"
  $probe = $probe.Replace('__PORT__', "$port").Replace('__URL__', $url)
  Start-Process powershell -WindowStyle Hidden -ArgumentList @('-NoProfile', '-Command', $probe) | Out-Null
}

Write-Host ''
Write-Ok "Starting the API on $url"
Write-Note 'Keep this window open. Ctrl+C (or closing it) stops the monitor.'
Write-Host ''

try {
  npm start
} finally {
  if ($ssh -and -not $ssh.HasExited) {
    Write-Host ''
    Write-Step 'Closing the relay tunnel.'
    $ssh.Kill()
  }
}
