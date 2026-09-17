$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell

function New-NegevShortcut([string]$name, [string]$script, [string]$description, [bool]$keepOpen = $false) {
  $link = $shell.CreateShortcut((Join-Path $desktop "$name.lnk"))
  $link.TargetPath = (Get-Command powershell.exe).Source
  $flags = if ($keepOpen) { '-NoProfile -NoExit' } else { '-NoProfile' }
  $link.Arguments = "$flags -ExecutionPolicy Bypass -File `"$(Join-Path $project $script)`""
  $link.WorkingDirectory = $project
  $link.Description = $description
  $link.IconLocation = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe,0"
  $link.Save()
}

New-NegevShortcut 'Negev - Start local server' 'start-local.ps1' 'Start Negev-chan and keep it running after crashes.'
New-NegevShortcut 'Negev - Stop local server' 'stop-local.ps1' 'Stop Negev-chan without deleting memory or usage.'
New-NegevShortcut 'Negev - Status' 'status-local.ps1' 'Show local time, server, memory, and queue status.' $true
New-NegevShortcut 'Negev - Control Center' 'negev-console.ps1' 'Open the terminal control center for start, stop, logs, memory, usage, tests, and health checks.'
Write-Host "Desktop controls created in $desktop"
