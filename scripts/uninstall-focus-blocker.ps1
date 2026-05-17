$ErrorActionPreference = 'Stop'
$TaskName = 'TimeKeeper Focus Blocker'
$FirewallRuleName = 'TimeKeeper Focus Blocker 8766'

try {
  Invoke-WebRequest `
    -UseBasicParsing `
    -Uri 'http://127.0.0.1:8766/focus/stop' `
    -TimeoutSec 2 | Out-Null
} catch {
  # The helper may not be running; uninstall can continue.
}

try {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
} catch {
  # The task may not be running.
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
if (Get-Command Remove-NetFirewallRule -ErrorAction SilentlyContinue) {
  Remove-NetFirewallRule `
    -DisplayName $FirewallRuleName `
    -ErrorAction SilentlyContinue
}
Write-Output "Uninstalled scheduled task: $TaskName"
