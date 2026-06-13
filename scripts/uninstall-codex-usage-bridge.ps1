$ErrorActionPreference = 'Stop'
$TaskName = 'TimeKeeper Codex Usage Bridge'

try {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
} catch {
  # The task may not be running.
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output "Uninstalled scheduled task: $TaskName"
