param(
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$NodeCommand = Get-Command node -ErrorAction Stop

if ($Check) {
  Write-Output "Node: $($NodeCommand.Source)"
  Write-Output "Repo: $RepoRoot"
  Write-Output "Focus blocker: $(Join-Path $RepoRoot 'scripts\focus-blocker.mjs')"
  exit 0
}

Set-Location $RepoRoot
& $NodeCommand.Source "scripts\focus-blocker.mjs"
exit $LASTEXITCODE
