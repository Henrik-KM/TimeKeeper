param(
  [switch]$Check,
  [switch]$RefreshRuntime
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$NodeCommand = Get-Command node -ErrorAction Stop

if ($Check) {
  Write-Output "Node: $($NodeCommand.Source)"
  Write-Output "Repo: $RepoRoot"
  Write-Output "Codex bridge runtime: $(Join-Path $RepoRoot 'scripts\codex-bridge-runtime.mjs')"
  exit 0
}

Set-Location $RepoRoot
$RuntimeArguments = @("--repo-root=$RepoRoot")
if ($RefreshRuntime) { $RuntimeArguments += '--refresh-runtime' }
& $NodeCommand.Source "scripts\codex-bridge-runtime.mjs" @RuntimeArguments
exit $LASTEXITCODE
