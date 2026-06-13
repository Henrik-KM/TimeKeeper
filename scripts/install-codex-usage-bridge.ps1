param(
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$TaskName = 'TimeKeeper Codex Usage Bridge'
$ScriptPath = Join-Path $PSScriptRoot 'run-codex-usage-bridge.ps1'

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath -Check

$ResolvedScriptPath = (Resolve-Path $ScriptPath).Path
$TaskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ResolvedScriptPath`""

& schtasks.exe `
  /Create `
  /TN $TaskName `
  /SC MINUTE `
  /MO 5 `
  /TR $TaskCommand `
  /F | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create scheduled task: $TaskName"
}

if (-not $NoStart) {
  & schtasks.exe /Run /TN $TaskName | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to start scheduled task: $TaskName"
  }
}

Write-Output "Installed scheduled task: $TaskName"
if ($NoStart) {
  Write-Output 'The task will repeat every 5 minutes.'
} else {
  Write-Output 'The task was started and will repeat every 5 minutes.'
}
