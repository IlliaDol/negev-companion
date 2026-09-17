$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'Negev-Chan Local Server'
$runner = Join-Path $project 'runner.ps1'
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$startupLauncher = Join-Path $startup 'Negev-Chan Local Server.lnk'
$powershell = (Get-Command powershell.exe).Source
$action = New-ScheduledTaskAction -Execute $powershell -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

try {
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Keeps the private Negev-chan Telegram bot running and restarts it after crashes.' -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Write-Host "Installed and started: $taskName"
} catch {
  if ($_.Exception.Message -notmatch 'Access is denied|0x80070005|Unauthorized') { throw }
  New-Item -ItemType Directory -Path $startup -Force | Out-Null
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($startupLauncher)
  $link.TargetPath = $powershell
  $link.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
  $link.WorkingDirectory = $project
  $link.Description = 'Starts the local Negev-chan supervisor when this Windows user logs in.'
  $link.IconLocation = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe,0"
  $link.Save()
  $runnerArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
  Start-Process -FilePath $powershell -ArgumentList $runnerArguments -WorkingDirectory $project -WindowStyle Hidden
  Write-Host 'Windows denied Scheduled Task registration for this non-administrator account.' -ForegroundColor Yellow
  Write-Host "Installed a per-user Startup launcher instead: $startupLauncher"
  Write-Host 'It still starts at your login, restarts the bot after crashes, and needs no administrator rights.'
}
Write-Host "Logs: $(Join-Path $project 'logs')"
