$ErrorActionPreference = 'Stop'
$TaskName = 'TimeKeeper Codex Usage Bridge'

& schtasks.exe /End /TN $TaskName 2>$null | Out-Null
& schtasks.exe /Delete /TN $TaskName /F | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "Failed to delete scheduled task: $TaskName"
}
Write-Output "Uninstalled scheduled task: $TaskName"
