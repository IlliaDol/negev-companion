$ErrorActionPreference = 'Continue'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'Negev-Chan Local Server'
$data = Join-Path $project 'data'
$stopSignal = Join-Path $data 'stop.signal'
New-Item -ItemType Directory -Path $data -Force | Out-Null
# This is the only stop marker. It deliberately does not touch state.json or usage.json.
Set-Content -LiteralPath $stopSignal -Value (Get-Date).ToString('o') -Encoding ascii
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

$projectProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and $_.CommandLine -like "*$project*" -and ($_.CommandLine -like '*bot.js*' -or $_.CommandLine -like '*runner.ps1*')
}

# Older runners launched the child as plain "bot.js", so also use the lock
# file to stop the exact bot process that belongs to this project.
$lockedPid = 0
try { $lockedPid = [int]((Get-Content -Raw -LiteralPath (Join-Path $data 'negev.lock') | ConvertFrom-Json).pid) } catch { }
$lockedProcess = if ($lockedPid -gt 0) {
  Get-CimInstance Win32_Process -Filter "ProcessId = $lockedPid" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -like '*bot.js*' }
}

@($projectProcesses) + @($lockedProcess) | Where-Object { $_ } | Sort-Object ProcessId -Unique | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

# Do not report success while the old runner is still shutting down. This
# avoids a fast restart racing the stop marker and accidentally reusing it.
$deadline = (Get-Date).AddSeconds(10)
do {
  $remaining = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine -like "*$project*" -and ($_.CommandLine -like '*bot.js*' -or $_.CommandLine -like '*runner.ps1*')
  }
  if (-not $remaining -or (Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 250
} while ($true)
Write-Host 'Negev-chan local server stopped. Memory, usage, and sleep state were not deleted.'
