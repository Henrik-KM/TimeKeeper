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
  if ($Config.relayUrl) {
    $env:TIMEKEEPER_FOCUS_RELAY_URL = [string]$Config.relayUrl
  }
  if ($Config.relayOwner) {
    $env:TIMEKEEPER_FOCUS_RELAY_OWNER = [string]$Config.relayOwner
  }
  if ($Config.relayRepo) {
    $env:TIMEKEEPER_FOCUS_RELAY_REPO = [string]$Config.relayRepo
  }
  if ($Config.relayPath) {
    $env:TIMEKEEPER_FOCUS_RELAY_PATH = [string]$Config.relayPath
  }
  if ($Config.relayBranch) {
    $env:TIMEKEEPER_FOCUS_RELAY_BRANCH = [string]$Config.relayBranch
  }
  if ($Config.relayToken) {
    $env:TIMEKEEPER_FOCUS_RELAY_TOKEN = [string]$Config.relayToken
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
  if ($env:TIMEKEEPER_FOCUS_RELAY_URL) {
    Write-Output "Relay URL: $env:TIMEKEEPER_FOCUS_RELAY_URL"
  }
  if ($env:TIMEKEEPER_FOCUS_RELAY_OWNER -and $env:TIMEKEEPER_FOCUS_RELAY_REPO) {
    Write-Output "Relay repo: $env:TIMEKEEPER_FOCUS_RELAY_OWNER/$env:TIMEKEEPER_FOCUS_RELAY_REPO"
    Write-Output "Relay path: $env:TIMEKEEPER_FOCUS_RELAY_PATH"
    Write-Output "Relay branch: $env:TIMEKEEPER_FOCUS_RELAY_BRANCH"
  }
  exit 0
}

Set-Location $RepoRoot
& $NodeCommand.Source "scripts\focus-blocker.mjs"
exit $LASTEXITCODE
