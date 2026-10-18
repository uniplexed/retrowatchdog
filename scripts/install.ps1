# RetroWatchdog installer for Windows: sets up and starts the docker compose
# stack in one folder, asking only what it cannot guess. Safe to run again: an
# existing .env is kept and the stack is updated in place.
#
# In PowerShell:
#   irm https://raw.githubusercontent.com/uniplexed/retrowatchdog/main/scripts/install.ps1 | iex
#
# Optional, set before running:
#   $env:RETROWATCHDOG_DIR       install folder         (default: %USERPROFILE%\retrowatchdog)
#   $env:RETROWATCHDOG_REF       git tag or branch      (default: v1.0.0)
#   $env:RETROWATCHDOG_NO_START  1 = write the files and stop before starting
# Non-interactive: $env:RETROWATCHDOG_YES = "1" plus any of PUBLIC_HOST,
#   COMPOSE_PROFILES (cex,ebay,vinted,wallapop), IGDB_CLIENT_ID, IGDB_SECRET,
#   EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, CEX_ALGOLIA_APP_ID, CEX_ALGOLIA_API_KEY,
#   APP_PASSWORD, RETROWATCHDOG_NO_BROWSER

$ErrorActionPreference = "Stop"

$Repo = "uniplexed/retrowatchdog"
$Ref = if ($env:RETROWATCHDOG_REF) { $env:RETROWATCHDOG_REF } else { "v1.0.0" }
if ($Ref -notmatch '^[A-Za-z0-9._/-]+$') { Fail "RETROWATCHDOG_REF may hold letters, digits, . _ / - only" }
$Dir = if ($env:RETROWATCHDOG_DIR) { $env:RETROWATCHDOG_DIR } else { Join-Path $env:USERPROFILE "retrowatchdog" }
$Raw = "https://raw.githubusercontent.com/$Repo/$Ref"
# the README section every source with legal conditions points at
$LawUrl = "https://github.com/uniplexed/retrowatchdog#about-the-sources-and-the-law"

function Say([string]$text) { Write-Host ""; Write-Host $text -ForegroundColor Cyan }
function Fail([string]$text) { Write-Host ""; Write-Host "Error: $text" -ForegroundColor Red; exit 1 }

$Unattended = $env:RETROWATCHDOG_YES -eq "1"

function Ask([string]$prompt, [string]$default = "") {
    if ($Unattended) { return $default }
    $label = if ($default) { "$prompt [$default]" } else { $prompt }
    $answer = Read-Host $label
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    return $answer.Trim()
}

function AskSecret([string]$prompt) {
    if ($Unattended) { return "" }
    $secure = Read-Host "$prompt (Enter to skip)" -AsSecureString
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
    return $plain
}

function YesNo([string]$prompt, [string]$default = "y") {
    $answer = Ask "$prompt (y/n)" $default
    return $answer -match '^[yY]'
}

# set KEY=VALUE in an env file, replacing a line (commented or not) that sets it
function Set-EnvValue([string]$file, [string]$key, [string]$value) {
    if (-not (Test-Path $file)) { New-Item -ItemType File -Path $file | Out-Null }
    $lines = @(Get-Content $file)
    $pattern = "^#? ?$([regex]::Escape($key))="
    $done = $false
    $out = foreach ($line in $lines) {
        if (-not $done -and $line -match $pattern) { $done = $true; "$key=$value" } else { $line }
    }
    if (-not $done) { $out = @($out) + "$key=$value" }
    # UTF-8 without a BOM: docker compose reads a BOM as part of the first key
    [IO.File]::WriteAllLines((Resolve-Path $file), [string[]]$out, (New-Object Text.UTF8Encoding $false))
}

Say "RetroWatchdog installer ($Ref)"

# ---- Docker -----------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    if ((Get-Command winget -ErrorAction SilentlyContinue) -and (YesNo "Docker Desktop is not installed. Install it now with winget?")) {
        winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
        Say "Docker Desktop is installed. Start it from the Start menu (Windows may ask you to restart first), wait until it says it is running, then run this installer again."
        exit 0
    }
    Fail "Docker Desktop is required: https://www.docker.com/products/docker-desktop/ . Install it, start it, and run this again."
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail "Docker is installed but not running. Start Docker Desktop, wait until it is ready, and run this again." }
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Fail "Docker Compose v2 is required (the 'docker compose' command); update Docker Desktop." }

# ---- Files ------------------------------------------------------------------
Say "Installing into $Dir"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
Set-Location $Dir
try {
    Invoke-WebRequest -UseBasicParsing "$Raw/docker-compose.yml" -OutFile "docker-compose.yml"
    Invoke-WebRequest -UseBasicParsing "$Raw/.env.example" -OutFile ".env.example"
} catch { Fail "Could not download the files from $Raw." }

$firstRun = -not (Test-Path ".env")
if ($firstRun) {
    Copy-Item ".env.example" ".env"

    # ---- Questions (first run only; edit .env afterwards to change them) --------
    $guess = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress
    if (-not $guess) { $guess = "localhost" }
    if ($env:PUBLIC_HOST) { $guess = $env:PUBLIC_HOST }
    $hostName = Ask "Name or IP address other devices will use to open the app (localhost for this computer only)" $guess
    Set-EnvValue ".env" "PUBLIC_HOST" $hostName

    Say "Price sources (plugins). Each one is optional."
    Write-Host "Read the legal notes before you say yes to a source marked (legal notes):"
    Write-Host "  $LawUrl"
    $profiles = @()
    if (YesNo "CeX (UK, Spain, Ireland shops; needs CeX's public search key; legal notes)" "n") { $profiles += "cex" }
    if (YesNo "eBay (5 markets; needs your free eBay developer keys)") { $profiles += "ebay" }
    if (YesNo "Vinted UK, France, Germany, Spain and Ireland (private sellers; legal notes)" "n") { $profiles += "vinted" }
    if (YesNo "Wallapop Spain, Italy and Portugal (private sellers; legal notes)" "n") { $profiles += "wallapop" }
    if ($env:COMPOSE_PROFILES) { $profiles = @($env:COMPOSE_PROFILES -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
    Set-EnvValue ".env" "COMPOSE_PROFILES" ($profiles -join ",")

    if ($profiles -contains "cex") {
        New-Item -ItemType File -Force -Path ".env.cex" | Out-Null
        $id = if ($env:CEX_ALGOLIA_APP_ID) { $env:CEX_ALGOLIA_APP_ID } else { Ask "CeX Algolia application id (Enter to set later in .env.cex)" }
        $key = if ($env:CEX_ALGOLIA_API_KEY) { $env:CEX_ALGOLIA_API_KEY } else { AskSecret "CeX Algolia search-only key" }
        if ($id) { Set-EnvValue ".env.cex" "CEX_ALGOLIA_APP_ID" $id }
        if ($key) { Set-EnvValue ".env.cex" "CEX_ALGOLIA_API_KEY" $key }
    }
    if ($profiles -contains "ebay") {
        New-Item -ItemType File -Force -Path ".env.ebay" | Out-Null
        $id = if ($env:EBAY_CLIENT_ID) { $env:EBAY_CLIENT_ID } else { Ask "eBay client id (Enter to set later in .env.ebay)" }
        $secret = if ($env:EBAY_CLIENT_SECRET) { $env:EBAY_CLIENT_SECRET } else { AskSecret "eBay client secret" }
        if ($id) { Set-EnvValue ".env.ebay" "EBAY_CLIENT_ID" $id }
        if ($secret) { Set-EnvValue ".env.ebay" "EBAY_CLIENT_SECRET" $secret }
    }

    Say "Game catalogue (IGDB, free at dev.twitch.tv). Optional: without it search only finds games already imported."
    $igdbId = if ($env:IGDB_CLIENT_ID) { $env:IGDB_CLIENT_ID } else { Ask "IGDB client id (Enter to skip)" }
    if ($igdbId) {
        Set-EnvValue ".env" "IGDB_CLIENT_ID" $igdbId
        Set-EnvValue ".env" "IGDB_SECRET" $(if ($env:IGDB_SECRET) { $env:IGDB_SECRET } else { AskSecret "IGDB secret" })
    }

    Say "Password. The app has no accounts: anyone who can reach it can change it."
    $password = if ($env:APP_PASSWORD) { $env:APP_PASSWORD } else { AskSecret "Choose a password for the app" }
    if ($password) {
        # on stdin, not as an argument: an argument is visible in the process list
        $hash = ($password | docker run --rm -i caddy:2-alpine caddy hash-password | Select-Object -Last 1).Trim()
        Set-EnvValue ".env" "APP_USER" "retro"
        # a bcrypt hash holds "$": compose would read it as a variable, so each one is doubled
        Set-EnvValue ".env" "APP_PASSWORD_HASH" ($hash -replace '\$', '$$$$')
    } else {
        Write-Host "No password set. Only run it on a network where everyone may use it."
    }
}

# ---- Images: the release this installer installs, on every run --------------
# A release tag (v1.2.3) pins the app to 1.2.3 and each plugin to the version
# it was released with; any other ref keeps the
# compose defaults (:latest, the newest build of main).
if ($Ref -match '^v(\d.*)$') {
    $version = $Matches[1]
    # the plugins this release was tested with; each has its own version
    $images = [ordered]@{
        API_IMAGE = "retrowatchdog-api:$version"; WEB_IMAGE = "retrowatchdog-web:$version"
        CEX_PLUGIN_IMAGE = "retrowatchdog-cex-plugin:1.0.0"; EBAY_PLUGIN_IMAGE = "retrowatchdog-ebay-plugin:1.0.0"
        VINTED_SIDECAR_PLUGIN_IMAGE = "retrowatchdog-vinted-sidecar-plugin:1.0.0"
        WALLAPOP_SIDECAR_PLUGIN_IMAGE = "retrowatchdog-wallapop-sidecar-plugin:1.0.0"
    }
    foreach ($key in $images.Keys) { Set-EnvValue ".env" $key "ghcr.io/uniplexed/$($images[$key])" }
}

# ---- Start ------------------------------------------------------------------
if ($env:RETROWATCHDOG_NO_START -eq "1") {
    Say "Files are ready in $Dir. Edit .env, then in that folder: docker compose pull; docker compose up -d"
    exit 0
}
Say "Downloading and starting RetroWatchdog (this can take a few minutes the first time)"
docker compose pull
if ($LASTEXITCODE -ne 0) { Fail "Could not download the images. Check the internet connection and try again." }
docker compose up -d --remove-orphans
if ($LASTEXITCODE -ne 0) { Fail "Could not start the app. If ports 80 or 443 are in use by another program (IIS, Skype, another web server), stop it and try again." }

$hostName = ((Get-Content ".env" | Where-Object { $_ -match '^PUBLIC_HOST=' }) -replace '^PUBLIC_HOST=', '')
if (-not $hostName) { $hostName = "localhost" }
Say "Waiting for the app to answer"
# any answer from the app through the web container counts (200, 401 behind the
# password, 308 to https); no answer or a proxy error means it is still starting
for ($i = 0; $i -lt 60; $i++) {
    $status = 0
    try {
        $status = [int](Invoke-WebRequest -UseBasicParsing "http://localhost/api/settings/currencies" -TimeoutSec 2 -MaximumRedirection 0 -ErrorAction Stop).StatusCode
    } catch {
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    }
    if ($status -ne 0 -and @(502, 503, 504) -notcontains $status) { break }
    Start-Sleep -Seconds 2
}

Say "Done"
Write-Host "Open:         https://$hostName   (or http://$hostName)"
Write-Host "Certificate:  https://$hostName/root.crt - install it once on each device to remove the browser warning."
Write-Host "Next steps:   Settings > Plugins: review and approve each plugin."
Write-Host "              Settings > Markets: switch on the markets you want."
Write-Host "Files:        $Dir  (.env holds your settings; keep it private)"
Write-Host "Update later: run this installer again, or in that folder: docker compose pull; docker compose up -d"
if ($env:RETROWATCHDOG_NO_BROWSER -ne "1") { Start-Process "http://localhost" }
