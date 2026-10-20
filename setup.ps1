# shapez CE - Multiplayer (unofficial fork): setup and update for Windows
#
# Installs the tools needed to build the game, downloads (or updates) the code,
# builds the game, puts a shortcut on the desktop and starts the game.
#
# First time and every update, paste this into PowerShell:
#   irm https://raw.githubusercontent.com/Xeenon77/shapez-community-edition-multiplayer/master/setup.ps1 | iex
#
# Or run this file from the game folder:
#   powershell -ExecutionPolicy Bypass -File setup.ps1

param(
    # Where the game is put
    [string]$InstallDir = (Join-Path $HOME "shapez-community-edition-multiplayer"),
    # Where the code comes from
    [string]$RepoUrl = "https://github.com/Xeenon77/shapez-community-edition-multiplayer.git",
    # Don't start the game at the end
    [switch]$NoStart,
    # Don't create the desktop shortcut
    [switch]$NoShortcut
)

$ErrorActionPreference = "Stop"

# Started from a game folder that was cloned by hand: update that one
if (-not $PSBoundParameters.ContainsKey("InstallDir") -and $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot ".git"))) {
    $InstallDir = $PSScriptRoot
}

function Write-Step([string]$Text) {
    Write-Host ""
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Stop-Setup([string]$Text) {
    Write-Host ""
    Write-Host "Setup stopped: $Text" -ForegroundColor Red
    Write-Host "See the Troubleshooting section of the README, or run the command again." -ForegroundColor Red
    throw $Text
}

# Makes tools that were just installed usable without opening a new PowerShell
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $wingetLinks = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"
    $env:Path = "$machine;$user;$wingetLinks"
}

function Test-Command([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-Tool([string]$Command, [string]$WingetId, [string]$Label) {
    if (Test-Command $Command) {
        Write-Host "    $Label is installed"
        return
    }
    Write-Host "    Installing $Label ..."
    winget install --id $WingetId -e --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
    Update-SessionPath
    if (-not (Test-Command $Command)) {
        Stop-Setup "$Label could not be installed. Try it by hand: winget install --id $WingetId -e"
    }
}

# Runs a native command and retries it (downloads sometimes fail on weak connections)
function Invoke-Checked([string]$What, [scriptblock]$Command, [int]$Attempts = 1) {
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        & $Command
        if ($LASTEXITCODE -eq 0) {
            return
        }
        if ($attempt -lt $Attempts) {
            Write-Host "    $What failed, trying again ($attempt/$Attempts) ..." -ForegroundColor Yellow
            Start-Sleep -Seconds 3
        }
    }
    Stop-Setup "$What failed (exit code $LASTEXITCODE)."
}

Write-Host "shapez CE - Multiplayer: setup" -ForegroundColor Green
Write-Host "This takes about 10 to 15 minutes the first time, updates are faster."

# ---- 1. Tools
Write-Step "Checking the tools (Git, Node.js 22, Java, FFmpeg)"
if (-not (Test-Command "winget")) {
    Stop-Setup "winget is missing. Install 'App Installer' from the Microsoft Store and run this again."
}
Update-SessionPath
Install-Tool "git" "Git.Git" "Git"
Install-Tool "node" "OpenJS.NodeJS.22" "Node.js 22"
Install-Tool "java" "EclipseAdoptium.Temurin.21.JRE" "Java"
Install-Tool "ffmpeg" "Gyan.FFmpeg" "FFmpeg"

$nodeVersion = (& node --version)
if (-not $nodeVersion.StartsWith("v22")) {
    Write-Host "    Note: Node.js $nodeVersion is installed, the game was tested with Node.js 22." -ForegroundColor Yellow
}

# ---- 2. Code
if (Test-Path (Join-Path $InstallDir ".git")) {
    Write-Step "Updating the code in $InstallDir"
    Invoke-Checked "Downloading the update" { git -C $InstallDir pull --ff-only } 3
} else {
    Write-Step "Downloading the code to $InstallDir"
    Invoke-Checked "Downloading the code" { git clone $RepoUrl $InstallDir } 3
}

# ---- 3. Build
$gameFolder = Join-Path $InstallDir "build_output\standalone\shapez-win32-x64"
$gameExe = Join-Path $gameFolder "shapezio.exe"

$running = Get-Process shapezio -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $gameExe }
if ($running) {
    Write-Host ""
    Write-Host "The game is running. Close it, then press Enter to continue." -ForegroundColor Yellow
    Read-Host | Out-Null
}

Push-Location $InstallDir
try {
    # npm.cmd instead of npm: the npm.ps1 shim is blocked by the default script policy
    Write-Step "Installing the build dependencies (this downloads a lot the first time)"
    Invoke-Checked "Installing the dependencies" { npm.cmd ci --no-fund --no-audit } 3
    Invoke-Checked "Installing the Electron dependencies" { npm.cmd ci --prefix electron --no-fund --no-audit } 3

    Write-Step "Building the game"
    Invoke-Checked "Building the game" { npm.cmd run package-win32-x64 }
} finally {
    Pop-Location
}

if (-not (Test-Path $gameExe)) {
    Stop-Setup "The build finished, but $gameExe is missing."
}

# ---- 4. Shortcut
if (-not $NoShortcut) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut((Join-Path $desktop "shapez Multiplayer.lnk"))
    $shortcut.TargetPath = $gameExe
    $shortcut.WorkingDirectory = $gameFolder
    $shortcut.Description = "shapez CE - Multiplayer (unofficial fork)"
    $shortcut.Save()
}

Write-Host ""
Write-Host "Done! Start the game with 'shapez Multiplayer' on your desktop." -ForegroundColor Green
Write-Host "To update later, run the same command again."

if (-not $NoStart) {
    Start-Process -FilePath $gameExe -WorkingDirectory $gameFolder
}
