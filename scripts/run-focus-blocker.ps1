param(
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$NodeCommand = Get-Command node -ErrorAction Stop
$ConfigPath = Join-Path $RepoRoot '.tmp\focus-blocker.config.json'

if (Test-Path $ConfigPath) {
  $Config = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json
  if ($Config.dataFile) {
    $env:TIMEKEEPER_DATA_FILE = [string]$Config.dataFile
  }
  if ($Config.backupDir) {
    $env:TIMEKEEPER_BACKUP_DIR = [string]$Config.backupDir
  }
  if ($Config.extraSites) {
    $env:TIMEKEEPER_FOCUS_EXTRA_SITES = [string]$Config.extraSites
  }
  if ($Config.host) {
    $env:TIMEKEEPER_FOCUS_HOST = [string]$Config.host
  }
}

if ($Check) {
  Write-Output "Node: $($NodeCommand.Source)"
  Write-Output "Repo: $RepoRoot"
  Write-Output "Focus blocker: $(Join-Path $RepoRoot 'scripts\focus-blocker.mjs')"
  if ($env:TIMEKEEPER_DATA_FILE) {
    Write-Output "Data file: $env:TIMEKEEPER_DATA_FILE"
  }
  if ($env:TIMEKEEPER_BACKUP_DIR) {
    Write-Output "Backup dir: $env:TIMEKEEPER_BACKUP_DIR"
  }
  if ($env:TIMEKEEPER_FOCUS_HOST) {
    Write-Output "Host: $env:TIMEKEEPER_FOCUS_HOST"
  }
  exit 0
}

Set-Location $RepoRoot
& $NodeCommand.Source "scripts\focus-blocker.mjs"
exit $LASTEXITCODE
