param(
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$TaskName = 'TimeKeeper Codex Usage Bridge'
$ScriptPath = Join-Path $PSScriptRoot 'run-codex-usage-bridge.ps1'

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath -Check

$UserId = if ($env:USERDOMAIN) {
  "$env:USERDOMAIN\$env:USERNAME"
} else {
  $env:USERNAME
}
$Action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn
$RepeatTrigger = New-ScheduledTaskTrigger `
  -Once `
  -At (Get-Date).Date `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$Principal = New-ScheduledTaskPrincipal `
  -UserId $UserId `
  -LogonType Interactive `
  -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
  -Hidden

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger @($LogonTrigger, $RepeatTrigger) `
  -Principal $Principal `
  -Settings $Settings `
  -Force | Out-Null

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
}

Write-Output "Installed scheduled task: $TaskName"
if ($NoStart) {
  Write-Output 'The task will start at next logon and then repeat every 5 minutes.'
} else {
  Write-Output 'The task was started and will repeat every 5 minutes.'
}
