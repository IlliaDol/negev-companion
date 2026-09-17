$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $project 'data'
$stateFile = Join-Path $data 'state.json'
$heartbeat = Join-Path $data 'heartbeat.json'
$location = 'configured local area'
$envFile = Join-Path $project '.env'
if (Test-Path -LiteralPath $envFile) {
  $locationLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*NEGEV_LOCATION\s*=' } | Select-Object -First 1
  if ($locationLine) { $location = (($locationLine -split '=', 2)[1]).Trim().Trim('"').Trim("'") }
}
$task = Get-ScheduledTask -TaskName 'Negev-Chan Local Server' -ErrorAction SilentlyContinue
$startupLauncher = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Negev-Chan Local Server.lnk'
$serverProcess = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and $_.CommandLine -like "*$project*" -and ($_.CommandLine -like '*bot.js*' -or $_.CommandLine -like '*runner.ps1*')
} | Select-Object -First 1
Write-Host "local time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"
Write-Host "timezone: $([TimeZoneInfo]::Local.Id)"
Write-Host "home location: $location"
if (Test-Path -LiteralPath $stateFile) {
  try {
    $mute = (Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json).mute
    if ($mute.until -and ([DateTime]$mute.until).ToUniversalTime() -gt [DateTime]::UtcNow) { Write-Host "mute: active until $($mute.until)" }
    else { Write-Host 'mute: off' }
  } catch { Write-Host 'mute: unreadable' }
} else { Write-Host 'mute: off' }
$taskStatus = if ($task) { $task.State } else { 'not installed' }
$launcherStatus = if (Test-Path -LiteralPath $startupLauncher) { 'installed' } else { 'not installed' }
$processStatus = if ($serverProcess) { "running (pid $($serverProcess.ProcessId))" } else { 'not running' }
Write-Host "scheduled task: $taskStatus"
Write-Host "per-user startup launcher: $launcherStatus"
Write-Host "server process: $processStatus"
$documentPipeline = ''
if (Test-Path -LiteralPath $envFile) {
  $documentLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*NEGEV_DOCUMENT_PIPELINE\s*=' } | Select-Object -First 1
  if ($documentLine) { $documentPipeline = (($documentLine -split '=', 2)[1]).Trim().Trim('"').Trim("'") }
}
$documentStatus = if ($documentPipeline -and (Test-Path -LiteralPath $documentPipeline)) { 'ready - documents and OCR enabled' } else { 'not configured - text fallback only' }
Write-Host "document pipeline: $documentStatus"
if (Test-Path -LiteralPath $heartbeat) {
  try { $h = Get-Content -Raw $heartbeat | ConvertFrom-Json; Write-Host "heartbeat: $($h.at)" } catch { Write-Host 'heartbeat: unreadable' }
} else { Write-Host 'heartbeat: not created yet' }
if (Test-Path -LiteralPath $stateFile) {
  try {
    $s = Get-Content -Raw $stateFile | ConvertFrom-Json
    Write-Host "owner: $($s.ownerUserId)"
    if ($s.waitingForUser.active) { Write-Host 'conversation: waiting for him to write back' } else { Write-Host 'conversation: active' }
    if ($s.conversation) {
      Write-Host "conversation topic: $($s.conversation.topic); intent: $($s.conversation.currentIntent); mode: $($s.conversation.mode)"
      Write-Host "open conversation loops: $(@($s.conversation.openLoops | Where-Object status -eq 'open').Count)"
    }
    Write-Host "memory: $(@($s.facts).Count) facts, $(@($s.promises | Where-Object status -eq 'open').Count) promises, $(@($s.tasks | Where-Object status -eq 'open').Count) tasks"
    Write-Host "queued overnight: $(@($s.overnight).Count)"
    Write-Host "scheduled replies: $(@($s.scheduledReplies).Count)"
  } catch { Write-Host 'state: unreadable' }
} else { Write-Host 'state: not created yet' }
