$ErrorActionPreference = 'Continue'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe was not found on PATH' }
$data = Join-Path $project 'data'
$stopSignal = Join-Path $data 'stop.signal'
New-Item -ItemType Directory -Path $data -Force | Out-Null

while (-not (Test-Path -LiteralPath $stopSignal)) {
  # Use the absolute script path so status/stop can reliably identify this
  # project's child process even when Windows reports only "bot.js".
  $bot = Join-Path $project 'bot.js'
  $process = Start-Process -FilePath $node -ArgumentList @("`"$bot`"") -WorkingDirectory $project -PassThru -WindowStyle Hidden
  while (-not $process.HasExited -and -not (Test-Path -LiteralPath $stopSignal)) { Start-Sleep -Seconds 2 }
  if (Test-Path -LiteralPath $stopSignal) {
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    break
  }
  if ($process.ExitCode -eq 0) { Start-Sleep -Seconds 3 } else { Start-Sleep -Seconds 8 }
}
