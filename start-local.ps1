$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'Negev-Chan Local Server'
$data = Join-Path $project 'data'
$stopSignal = Join-Path $data 'stop.signal'
$runner = Join-Path $project 'runner.ps1'
$startupLauncher = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Negev-Chan Local Server.lnk'
New-Item -ItemType Directory -Path $data -Force | Out-Null

# If start follows stop immediately, wait for the old runner to disappear
# before removing its stop marker. Otherwise the runner could miss the marker
# and continue, making the command claim a restart that never happened.
$running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and $_.CommandLine -like "*$project*" -and $_.CommandLine -like '*runner.ps1*'
}
if ($running -and -not (Test-Path -LiteralPath $stopSignal)) {
  Write-Host 'Negev-chan local server is already running. Existing memory and usage were kept.'
  exit 0
}
if ($running) {
  $deadline = (Get-Date).AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 250
    $running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -and $_.CommandLine -like "*$project*" -and $_.CommandLine -like '*runner.ps1*'
    }
    if (-not $running -or (Get-Date) -ge $deadline) { break }
  } while ($true)
}
if ($running) {
  $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
}
if (Test-Path -LiteralPath $stopSignal) { Remove-Item -LiteralPath $stopSignal -Force }

try { $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop }
catch {
  if (Test-Path -LiteralPath $startupLauncher) {
    $running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -and $_.CommandLine -like "*$project*" -and $_.CommandLine -like '*runner.ps1*'
    }
    if (-not $running) {
      $runnerArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
      Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList $runnerArguments -WorkingDirectory $project -WindowStyle Hidden
    }
    Write-Host 'Negev-chan local server started through the per-user Startup launcher. Existing memory and usage were kept.'
    exit 0
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $project 'install-24-7.ps1')
  exit $LASTEXITCODE
}
Start-ScheduledTask -TaskName $taskName
Write-Host 'Negev-chan local server started. Existing memory and usage were kept.'
