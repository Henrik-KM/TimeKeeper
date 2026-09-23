param(
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$TaskName = 'TimeKeeper Claude Usage Bridge'
$ScriptPath = Join-Path $PSScriptRoot 'run-claude-usage-bridge.ps1'
$HiddenLauncherPath = Join-Path $PSScriptRoot 'run-claude-usage-bridge-hidden.vbs'

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath -Check

$ResolvedHiddenLauncherPath = (Resolve-Path $HiddenLauncherPath).Path
$TaskCommand = "wscript.exe //B //Nologo `"$ResolvedHiddenLauncherPath`""

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
