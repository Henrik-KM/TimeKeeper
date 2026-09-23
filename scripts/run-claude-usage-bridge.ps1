param(
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$NodeCommand = Get-Command node -ErrorAction Stop

if ($Check) {
  Write-Output "Node: $($NodeCommand.Source)"
  Write-Output "Repo: $RepoRoot"
  Write-Output "Claude bridge: $(Join-Path $RepoRoot 'scripts\claude-usage-bridge.mjs')"
  exit 0
}

Set-Location $RepoRoot
& $NodeCommand.Source "scripts\claude-usage-bridge.mjs"
exit $LASTEXITCODE
