$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$startupLauncher = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Negev-Chan Local Server.lnk'
Unregister-ScheduledTask -TaskName 'Negev-Chan Local Server' -Confirm:$false -ErrorAction SilentlyContinue
if (Test-Path -LiteralPath $startupLauncher) { Remove-Item -LiteralPath $startupLauncher -Force }
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and $_.CommandLine -like "*$project*" -and ($_.CommandLine -like '*bot.js*' -or $_.CommandLine -like '*runner.ps1*')
} | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host 'Negev-chan local startup removed. Memory and usage were not deleted.'
