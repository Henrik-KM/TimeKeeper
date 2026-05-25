param(
  [string]$DataFile,
  [string]$BackupDir,
  [string]$ExtraSites,
  [string]$Host,
  [switch]$ListenOnLan,
  [switch]$NoFirewallRule,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$TaskName = 'TimeKeeper Focus Blocker'
$ScriptPath = Join-Path $PSScriptRoot 'run-focus-blocker.ps1'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$ConfigDir = Join-Path $RepoRoot '.tmp'
$ConfigPath = Join-Path $ConfigDir 'focus-blocker.config.json'

$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$PrincipalCheck = New-Object Security.Principal.WindowsPrincipal($Identity)
$IsAdmin = $PrincipalCheck.IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
if (-not $IsAdmin) {
  throw 'Run this installer from PowerShell as Administrator.'
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ScriptPath -Check

if ($DataFile -and $BackupDir) {
  throw 'Use either -DataFile or -BackupDir, not both.'
}
if ($Host -and $ListenOnLan) {
  throw 'Use either -Host or -ListenOnLan, not both.'
}

if ($DataFile) {
  $DataFile = (Resolve-Path $DataFile).Path
}
if ($BackupDir) {
  $BackupDir = (Resolve-Path $BackupDir).Path
}
$ResolvedHost = $null
if ($ListenOnLan) {
  $ResolvedHost = '0.0.0.0'
} elseif ($Host) {
  $ResolvedHost = $Host
}
if ($DataFile -or $BackupDir -or $ExtraSites -or $ResolvedHost) {
  New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
  $Config = [ordered]@{}
  if ($DataFile) {
    $Config.dataFile = $DataFile
  }
  if ($BackupDir) {
    $Config.backupDir = $BackupDir
  }
  if ($ExtraSites) {
    $Config.extraSites = $ExtraSites
  }
  if ($ResolvedHost) {
    $Config.host = $ResolvedHost
  }
  $Config | ConvertTo-Json | Set-Content -Path $ConfigPath -Encoding utf8
  Write-Output "Wrote focus blocker config: $ConfigPath"
}

if ($ResolvedHost -eq '0.0.0.0' -and -not $NoFirewallRule) {
  $RuleName = 'TimeKeeper Focus Blocker 8766'
  if (Get-Command New-NetFirewallRule -ErrorAction SilentlyContinue) {
    $ExistingRule = Get-NetFirewallRule `
      -DisplayName $RuleName `
      -ErrorAction SilentlyContinue
    if (-not $ExistingRule) {
      New-NetFirewallRule `
        -DisplayName $RuleName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort 8766 `
        -Profile Private | Out-Null
      Write-Output "Added Windows Firewall rule: $RuleName"
    } else {
      Write-Output "Windows Firewall rule already exists: $RuleName"
    }
  } else {
    Write-Output 'New-NetFirewallRule is unavailable; allow inbound TCP 8766 on private networks manually.'
  }
}

$UserId = if ($env:USERDOMAIN) {
  "$env:USERDOMAIN\$env:USERNAME"
} else {
  $env:USERNAME
}
$Action = New-ScheduledTaskAction `
  -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Principal = New-ScheduledTaskPrincipal `
  -UserId $UserId `
  -LogonType Interactive `
  -RunLevel Highest
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -Hidden

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Principal $Principal `
  -Settings $Settings `
  -Force | Out-Null

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
}

Write-Output "Installed scheduled task: $TaskName"
if (Test-Path $ConfigPath) {
  Write-Output "Config: $ConfigPath"
} else {
  Write-Output 'No backup data file configured. Localhost webhooks will work only when the app is run locally.'
}
if ($ResolvedHost -eq '0.0.0.0') {
  Write-Output 'LAN mode enabled. Open http://<this-PC-LAN-IP>:8766/ on the Android phone.'
  $LanAddresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' }
  foreach ($Address in $LanAddresses) {
    Write-Output "Candidate phone URL: http://$($Address.IPAddress):8766/"
  }
}
if ($NoStart) {
  Write-Output 'The task will start at next logon.'
} else {
  Write-Output 'The task was started. Check /focus/status or Task Scheduler history if needed.'
}
