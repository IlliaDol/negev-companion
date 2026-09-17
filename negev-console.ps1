[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Command = ''
)

$ErrorActionPreference = 'Continue'
$project = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $project 'data'
$logs = Join-Path $project 'logs'
$location = 'configured local area'
$envFile = Join-Path $project '.env'
if (Test-Path -LiteralPath $envFile) {
  $locationLine = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*NEGEV_LOCATION\s*=' } | Select-Object -First 1
  if ($locationLine) { $location = (($locationLine -split '=', 2)[1]).Trim().Trim('"').Trim("'") }
}
$taskName = 'Negev-Chan Local Server'

function Show-Title {
  Write-Host ''
  Write-Host '========================================' -ForegroundColor DarkCyan
  Write-Host '  NEGEV-CHAN LOCAL CONTROL CENTER' -ForegroundColor Cyan
  Write-Host '========================================' -ForegroundColor DarkCyan
  Write-Host "  folder: $project" -ForegroundColor DarkGray
  Write-Host ''
}

function Show-Help {
  Write-Host 'all terminal commands:' -ForegroundColor Yellow
  Write-Host '  start       start the local server and keep it running'
  Write-Host '  stop        stop the local server without deleting memory'
  Write-Host '  restart     stop and start again, preserving all data'
  Write-Host '  status      show current time, timezone, task, heartbeat, and queues'
  Write-Host '  logs        show the latest server log entries'
  Write-Host '  memory      show saved facts, promises, tasks, and queue counts'
  Write-Host '  usage       show lifetime provider calls, tokens, and cost'
  Write-Host '  doctor      check Node, credentials, pipeline, task, and data folders'
  Write-Host '  test        run the complete local self-test suite'
  Write-Host '  shortcuts   create or refresh the four Desktop controls'
  Write-Host '  providers   list providers, models, active selection, and key counts'
  Write-Host '  provider-use choose the active provider and model, then restart'
  Write-Host '  provider-add add any custom API (arbitrary URL, auth, body, response, and usage mapping)'
  Write-Host '  provider-key add another provider API key with hidden input'
  Write-Host '  config      open the local .env file without printing secrets'
  Write-Host '  help        print this command list again'
  Write-Host '  exit        close this control center (the server is unchanged)'
  Write-Host ''
  Write-Host 'Telegram commands the bot accepts:' -ForegroundColor Yellow
  Write-Host '  /start, !start, /help, !help, /commands, !commands'
  Write-Host '  /talk, !talk (keep talking with a fresh topic)'
  Write-Host '  /clear yes, !clear yes (clear recorded chat messages and short-term context)'
  Write-Host '  /forgetall yes, !forgetall yes (erase learned memory, keep the built-in core)'
  Write-Host '  /caring, !caring, /tsundere, !tsundere, /playful, !playful, /warm, !warm'
  Write-Host '  /normal, !normal, /soft, !soft, /mood [style|auto], !mood [style|auto]'
  Write-Host '  /remember, !remember, /forget, !forget, /promises, !promises, /tasks, !tasks, /calendar, !calendar, /done, !done'
  Write-Host '  /status, !status, /sleep, !sleep, /mute [minutes], !mute [minutes], /unmute, !unmute'
  Write-Host '  !token, /token, !tokens, /tokens, /usage, !usage, /cost, !cost, /spend, !spend'
  Write-Host '  !tokenall, /tokenall, !estimateall, /estimateall (exact cumulative ledger)'
  Write-Host '  !estimate, /estimate (rough text, picture, and memory planning)'
  Write-Host '  !force message, /force message (answers immediately, even during sleep, mute, or waiting mode)'
  Write-Host '  text, captions, pictures, image documents, static stickers, video, voice, audio, and links'
  Write-Host ''
  Write-Host 'You can also run one command directly:' -ForegroundColor DarkGray
  Write-Host '  powershell -ExecutionPolicy Bypass -File .\negev-console.ps1 status' -ForegroundColor DarkGray
  Write-Host ''
}

function Invoke-ControlScript([string]$name) {
  $path = Join-Path $project $name
  if (-not (Test-Path -LiteralPath $path)) {
    Write-Host "missing control script: $name" -ForegroundColor Red
    return
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $path
  if ($LASTEXITCODE -ne 0) { Write-Host "control action exited with code $LASTEXITCODE" -ForegroundColor Red }
}

function Show-Providers {
  & node (Join-Path $project 'provider-manager.js') list
  if ($LASTEXITCODE -ne 0) { Write-Host "provider listing exited with code $LASTEXITCODE" -ForegroundColor Red }
}

function Set-DotEnvValue([string]$name, [string]$value) {
  $envFile = Join-Path $project '.env'
  $lines = if (Test-Path -LiteralPath $envFile) { @(Get-Content -LiteralPath $envFile) } else { @() }
  $pattern = '^\s*' + [regex]::Escape($name) + '\s*='
  $updated = @()
  $found = $false
  foreach ($line in $lines) {
    if ($line -match $pattern) { $updated += "$name=$value"; $found = $true }
    else { $updated += $line }
  }
  if (-not $found) { $updated += "$name=$value" }
  Set-Content -LiteralPath $envFile -Value $updated -Encoding UTF8
}

function Read-HiddenSecret([string]$prompt) {
  $secure = Read-Host $prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Get-ProviderKeyEnvironment([string]$providerId) {
  $json = & node (Join-Path $project 'provider-manager.js') key-env $providerId
  if ($LASTEXITCODE -ne 0 -or -not $json) { Write-Host 'could not resolve that provider' -ForegroundColor Red; return $null }
  try { return ($json | ConvertFrom-Json) } catch { Write-Host 'provider metadata was invalid' -ForegroundColor Red; return $null }
}

function Add-ProviderKey([string]$providerId = '', [switch]$SkipRestart) {
  if (-not $providerId) { $providerId = Read-Host 'provider id' }
  $keyInfo = Get-ProviderKeyEnvironment $providerId
  if (-not $keyInfo) { return }
  $aliasText = if (@($keyInfo.keyAliases).Count) { "; aliases: $(@($keyInfo.keyAliases) -join ', ')" } else { '' }
  Write-Host "key variables: $($keyInfo.keyEnv) and $($keyInfo.keysEnv)$aliasText" -ForegroundColor DarkGray
  $slot = Read-Host "type 'primary' to replace the primary slot, or press Enter to add another key"
  $target = $keyInfo.keyEnv
  if ($slot.Trim().ToLowerInvariant() -ne 'primary') {
    $number = 1
    do {
      $target = "$($keyInfo.keyEnv)_$number"
      $number++
    } while (Get-EnvValue $target)
  }
  $secret = Read-HiddenSecret "API key for $target (hidden)"
  if (-not $secret) { Write-Host 'no key entered; nothing changed' -ForegroundColor Yellow; return }
  Set-DotEnvValue $target $secret
  Write-Host "saved $target without printing the secret" -ForegroundColor Green
  if (-not $SkipRestart) { Restart-Server }
}

function Select-Provider {
  Show-Providers
  $providerId = Read-Host 'active provider id'
  $modelName = Read-Host 'model name (blank uses the first configured model)'
  if (-not $providerId) { Write-Host 'provider selection cancelled' -ForegroundColor Yellow; return }
  if ($modelName) { & node (Join-Path $project 'provider-manager.js') use $providerId $modelName }
  else { & node (Join-Path $project 'provider-manager.js') use $providerId }
  if ($LASTEXITCODE -eq 0) { Restart-Server }
  else { Write-Host "provider selection exited with code $LASTEXITCODE" -ForegroundColor Red }
}

function Add-CustomProvider {
  $providerId = Read-Host 'provider id (letters, numbers, _ or -)'
  $label = Read-Host 'display name'
  $baseUrl = Read-Host 'base URL (for example https://example.com/v1)'
  $protocol = Read-Host 'protocol: openai / anthropic / gemini / custom (blank = openai)'
  if (-not $protocol) { $protocol = 'openai' }
  $keyEnv = Read-Host 'primary key environment variable (blank = <ID>_API_KEY)'
  $modelName = Read-Host 'model name'
  Write-Host 'Enter USD per million token rates. Leave a rate blank if unknown; usage will remain visible but cost will be marked unpriced.' -ForegroundColor DarkGray
  $inputRate = Read-Host 'fresh input USD/M'
  $cacheRate = Read-Host 'cached input USD/M'
  $outputRate = Read-Host 'output USD/M'
  $cacheWriteRate = Read-Host 'cache-write USD/M (blank if not applicable or unknown)'

  $requestUrl = ''
  $requestMethod = 'POST'
  $queryParams = $null
  $bodyType = 'json'
  $authLocation = ''
  $authQueryParam = ''
  $authQueryPrefix = ''
  $authHeader = ''
  $authPrefix = ''
  $contentType = ''
  $responsePath = ''
  $responsePaths = $null
  $responseType = ''
  $modelPath = ''
  $usagePath = ''
  $usageInputPath = ''
  $usageCachedPath = ''
  $usageOutputPath = ''
  $usageCacheWritePath = ''
  $requestTemplate = $null
  $headers = $null
  if ($protocol.Trim().ToLowerInvariant() -eq 'custom') {
    Write-Host 'Custom mapping is optional. Paths use dot notation or brackets, for example choices[0].message.content or usage.input_tokens.' -ForegroundColor DarkGray
    Write-Host 'Template placeholders: {{model}}, {{messages}}, {{prompt}}, {{system}}, {{userMessage}}, {{maxTokens}}, {{temperature}}, and {{apiKey}}.' -ForegroundColor DarkGray
    $requestMethod = Read-Host 'HTTP method (blank = POST)'
    if (-not $requestMethod) { $requestMethod = 'POST' }
    $requestUrl = Read-Host 'full request URL (blank = base URL/chat/completions)'
    $queryText = Read-Host 'query parameters JSON, for example {"version":"1","key":"{{apiKey}}"} (blank = none)'
    if ($queryText) {
      try { $queryParams = $queryText | ConvertFrom-Json -ErrorAction Stop }
      catch { Write-Host 'query parameters are not valid JSON; nothing changed' -ForegroundColor Red; return }
    }
    $authLocation = Read-Host 'API-key location: header / query / none (blank = header)'
    if (-not $authLocation) { $authLocation = 'header' }
    $authQueryParam = Read-Host 'API-key query parameter name (only for query auth; blank = key)'
    if (-not $authQueryParam -and $authLocation.Trim().ToLowerInvariant() -eq 'query') { $authQueryParam = 'key' }
    $authQueryPrefix = Read-Host 'API-key query prefix (blank = none)'
    $authHeader = Read-Host 'API-key header (blank = Authorization; type none for no header)'
    $authPrefix = Read-Host 'API-key prefix (blank = Bearer plus a space)'
    $bodyType = Read-Host 'request body type: json / text (blank = json)'
    if (-not $bodyType) { $bodyType = 'json' }
    $contentType = Read-Host 'request content type (blank = application/json; type none to omit)'
    $responseType = Read-Host 'response type: json / text (blank = json)'
    $responsePath = Read-Host 'response text path, or fallback paths separated by | (blank = choices.0.message.content; text APIs can use blank)'
    if ($responsePath -and $responsePath.Contains('|')) {
      $responsePaths = @($responsePath.Split('|') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      $responsePath = $responsePaths[0]
    }
    $modelPath = Read-Host 'response model path (blank = model)'
    $usagePath = Read-Host 'usage object path (blank = usage)'
    $usageInputPath = Read-Host 'usage input-token path (blank = prompt_tokens)'
    $usageCachedPath = Read-Host 'usage cached-token path (blank = cached_tokens)'
    $usageOutputPath = Read-Host 'usage output-token path (blank = completion_tokens)'
    $usageCacheWritePath = Read-Host 'usage cache-write path (blank = none)'
    $headersText = Read-Host 'additional JSON headers, for example {"X-Project":"negev"} (blank = none; never put secrets here)'
    if ($headersText) {
      try { $headers = $headersText | ConvertFrom-Json -ErrorAction Stop }
      catch { Write-Host 'headers are not valid JSON; nothing changed' -ForegroundColor Red; return }
    }
    $templateText = Read-Host 'request JSON template (blank = default OpenAI-shaped body; use {{prompt}} for text-only APIs)'
    if ($templateText) {
      try { $requestTemplate = $templateText | ConvertFrom-Json -ErrorAction Stop }
      catch { Write-Host 'request template is not valid JSON; nothing changed' -ForegroundColor Red; return }
    }
  }
  $usageMap = [ordered]@{}
  if ($usageInputPath) { $usageMap.input = $usageInputPath }
  if ($usageCachedPath) { $usageMap.cached = $usageCachedPath }
  if ($usageOutputPath) { $usageMap.output = $usageOutputPath }
  if ($usageCacheWritePath) { $usageMap.cacheWrite = $usageCacheWritePath }
  if ($usageMap.Count -eq 0) { $usageMap = $null }
  $settings = [ordered]@{
    id = $providerId; label = $label; baseUrl = $baseUrl; keyEnv = $keyEnv; model = $modelName; protocol = $protocol
    rates = [ordered]@{ input = $inputRate; cache = $cacheRate; output = $outputRate; cacheWrite = $cacheWriteRate }
    requestMethod = $requestMethod; requestUrl = $requestUrl; queryParams = $queryParams; bodyType = $bodyType; requestTemplate = $requestTemplate
    authLocation = $authLocation; authQueryParam = $authQueryParam; authQueryPrefix = $authQueryPrefix; authHeader = $authHeader; authPrefix = $authPrefix
    contentType = $contentType; responsePath = $responsePath; responsePaths = $responsePaths; responseType = $responseType
    modelPath = $modelPath; usagePath = $usagePath; usageMap = $usageMap; headers = $headers
  }
  $settingsJson = $settings | ConvertTo-Json -Depth 20 -Compress
  & node (Join-Path $project 'provider-manager.js') add-json $settingsJson
  if ($LASTEXITCODE -ne 0) { Write-Host "provider creation exited with code $LASTEXITCODE" -ForegroundColor Red; return }
  Add-ProviderKey $providerId -SkipRestart
  $makeActive = Read-Host 'make this provider active now? (y/n)'
  if ($makeActive.Trim().ToLowerInvariant() -eq 'y') {
    & node (Join-Path $project 'provider-manager.js') use $providerId $modelName
  }
  Restart-Server
}

function Start-Server { Invoke-ControlScript 'start-local.ps1' }
function Stop-Server { Invoke-ControlScript 'stop-local.ps1' }
function Restart-Server {
  Stop-Server
  Start-Sleep -Seconds 1
  Start-Server
}

function Show-Status { Invoke-ControlScript 'status-local.ps1' }

function Show-Logs {
  if (-not (Test-Path -LiteralPath $logs)) { Write-Host 'no logs yet'; return }
  $latest = Get-ChildItem -LiteralPath $logs -Filter '*.log' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { Write-Host 'no logs yet'; return }
  Write-Host "latest log: $($latest.Name)" -ForegroundColor DarkGray
  Get-Content -LiteralPath $latest.FullName -Tail 50
}

function Read-Json([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try { return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json) } catch { return $null }
}

function Show-Memory {
  $state = Read-Json (Join-Path $data 'state.json')
  if (-not $state) { Write-Host 'memory has not been created yet'; return }
  Write-Host "owner: $($state.ownerUserId)"
  if ($state.waitingForUser.active) { Write-Host 'conversation: waiting for him to write back' } else { Write-Host 'conversation: active' }
  Write-Host "history entries: $(@($state.history).Count)"
  Write-Host "facts: $(@($state.facts).Count)"
  Write-Host "open promises: $(@($state.promises | Where-Object status -eq 'open').Count)"
  Write-Host "open tasks: $(@($state.tasks | Where-Object status -eq 'open').Count)"
  Write-Host "overnight queue: $(@($state.overnight).Count)"
  Write-Host "scheduled replies: $(@($state.scheduledReplies).Count)"
  Write-Host "calendar entries: $(@($state.calendar | Where-Object status -eq 'open').Count)"
  Write-Host ''
  Write-Host 'recent saved facts:' -ForegroundColor Yellow
  @($state.facts) | Select-Object -Last 10 | ForEach-Object { Write-Host "  - $($_.value)" }
  Write-Host 'open promises and tasks:' -ForegroundColor Yellow
  @($state.promises + $state.tasks) | Where-Object status -eq 'open' | Select-Object -Last 10 |
    ForEach-Object { Write-Host "  - $($_.type): $($_.value)" }
  Write-Host 'upcoming calendar dates:' -ForegroundColor Yellow
  @($state.calendar | Where-Object status -eq 'open' | Sort-Object dueAt | Select-Object -First 10) |
    ForEach-Object { Write-Host "  - $($_.dueDate) $($_.value)" }
}

function Show-Usage {
  $usage = Read-Json (Join-Path $data 'usage.json')
  if (-not $usage) { Write-Host 'usage has not been recorded yet'; return }
  $t = $usage.totals
  Write-Host 'AI provider usage ledger' -ForegroundColor Yellow
  Write-Host "model calls: $($t.calls)"
  Write-Host "input: $($t.input) tokens ($($t.cached) cached / $($t.fresh) fresh)"
  Write-Host "output: $($t.output) tokens"
  Write-Host "total: $($t.input + $t.output) tokens"
  $costUnits = if ($null -ne $t.costUnits) { [decimal]$t.costUnits } else { [decimal]$t.cost * [decimal]1000000000000 }
  $exactCost = ($costUnits / [decimal]1000000000000).ToString('0.000000000000', [Globalization.CultureInfo]::InvariantCulture)
  Write-Host ("cost: `$" + $exactCost)
  Write-Host 'Use !token in Telegram for the exact cost of one replied-to message.' -ForegroundColor DarkGray
}

function Get-EnvValue([string]$name) {
  $file = Join-Path $project '.env'
  if (Test-Path -LiteralPath $file) {
    $line = Get-Content -LiteralPath $file | Where-Object { $_ -match "^\s*$name\s*=\s*(.+)\s*$" } | Select-Object -First 1
    if ($line -and $line -match "^\s*$name\s*=\s*(.+)\s*$") { return $Matches[1].Trim() }
  }
  $processValue = [Environment]::GetEnvironmentVariable($name, 'Process')
  if ($processValue) { return $processValue.Trim() }
  $userValue = [Environment]::GetEnvironmentVariable($name, 'User')
  if ($userValue) { return $userValue.Trim() }
  return ''
}

function Show-Doctor {
  Write-Host 'local health check' -ForegroundColor Yellow
  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $nodeStatus = if ($node) { 'OK - ' + (& node --version).Trim() } else { 'MISSING' }
  Write-Host "node: $nodeStatus"
  $envFile = Join-Path $project '.env'
  $envStatus = if (Test-Path -LiteralPath $envFile) { 'found' } else { 'MISSING - copy .env.example to .env' }
  $telegramStatus = if (Get-EnvValue 'TELEGRAM_BOT_TOKEN') { 'configured' } else { 'missing' }
  $deepSeekPrimary = Get-EnvValue 'DEEPSEEK_API_KEY'
  $deepSeekPool = Get-EnvValue 'DEEPSEEK_API_KEYS'
  $deepSeekNumbered = @(Get-Content -LiteralPath $envFile -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*DEEPSEEK_API_KEY_\d+\s*=\s*(.+)\s*$' -and $Matches[1].Trim() })
  $deepSeekKeyCount = @(@($deepSeekPrimary) + @($deepSeekPool -split '[,;\r\n]') + $deepSeekNumbered).Where({ $_ -and $_.ToString().Trim() }).Count
  $deepSeekStatus = if ($deepSeekKeyCount -gt 0) { "configured ($deepSeekKeyCount key slot(s))" } else { 'missing' }
  Write-Host "local .env: $envStatus"
  Write-Host "Telegram token: $telegramStatus"
  Write-Host "DeepSeek key pool: $deepSeekStatus"
  $pipeline = Join-Path ($env:LOCALAPPDATA) 'Programs\whisper-pipeline\transcribe.bat'
  $pipelineLive = Join-Path ($env:LOCALAPPDATA) 'Programs\whisper-pipeline\LIVE\transcribe.bat'
  $pipelineStatus = if ((Test-Path -LiteralPath $pipelineLive) -or (Test-Path -LiteralPath $pipeline)) { 'found' } else { 'not found - photos still work, video/audio transcription will not' }
  $dataStatus = if (Test-Path -LiteralPath $data) { 'ready' } else { 'will be created on start' }
  Write-Host "media pipeline: $pipelineStatus"
  $documentPipeline = Get-EnvValue 'NEGEV_DOCUMENT_PIPELINE'
  $documentPipelineStatus = if ($documentPipeline -and (Test-Path -LiteralPath $documentPipeline)) { 'found - documents, OCR, and Markdown conversion enabled' } else { 'not configured - plain-text fallback only' }
  Write-Host "document pipeline: $documentPipelineStatus"
  Write-Host "data folder: $dataStatus"
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $taskStatus = if ($task) { $task.State } else { 'not installed - start will install it' }
  Write-Host "24/7 task: $taskStatus"
  $startupLauncher = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Negev-Chan Local Server.lnk'
  $launcherStatus = if (Test-Path -LiteralPath $startupLauncher) { 'installed' } else { 'not installed' }
  Write-Host "per-user startup fallback: $launcherStatus"
  Write-Host "timezone: $([TimeZoneInfo]::Local.Id)"
  Write-Host "home location: $location"
}

function Run-Test { & node (Join-Path $project 'selftest.js') }

function Create-Shortcuts { Invoke-ControlScript 'create-desktop-shortcuts.ps1' }

function Open-Config {
  $envFile = Join-Path $project '.env'
  if (-not (Test-Path -LiteralPath $envFile)) {
    Write-Host "No .env exists yet. Copy .env.example to .env, then use config again." -ForegroundColor Yellow
    return
  }
  Start-Process notepad.exe -ArgumentList "`"$envFile`""
  Write-Host 'Opened .env. Secrets were not printed in this console.'
}

$script:exitRequested = $false

function Execute-Command([string]$selection) {
  switch ($selection.Trim().ToLowerInvariant()) {
    { $_ -in @('start', 'run', 'up') } { Start-Server; break }
    { $_ -in @('stop', 'down') } { Stop-Server; break }
    { $_ -in @('restart', 'reboot') } { Restart-Server; break }
    { $_ -in @('status', 'state', 's') } { Show-Status; break }
    { $_ -in @('logs', 'log', 'tail') } { Show-Logs; break }
    { $_ -in @('memory', 'mem') } { Show-Memory; break }
    { $_ -in @('usage', 'cost') } { Show-Usage; break }
    { $_ -in @('doctor', 'health', 'check') } { Show-Doctor; break }
    { $_ -in @('test', 'tests') } { Run-Test; break }
    { $_ -in @('shortcuts', 'desktop') } { Create-Shortcuts; break }
    { $_ -in @('providers', 'provider', 'models') } { Show-Providers; break }
    { $_ -in @('provider-use', 'use-provider', 'select-provider') } { Select-Provider; break }
    { $_ -in @('provider-add', 'add-provider') } { Add-CustomProvider; break }
    { $_ -in @('provider-key', 'add-key') } { Add-ProviderKey; break }
    { $_ -in @('config', 'env') } { Open-Config; break }
    { $_ -in @('help', '?', 'commands') } { Show-Help; break }
    { $_ -in @('exit', 'quit', 'q') } { $script:exitRequested = $true; break }
    '' { Show-Help; break }
    default { Write-Host "unknown command: $selection" -ForegroundColor Red; Show-Help; break }
  }
}

if ($Command) {
  Show-Title
  Execute-Command $Command
  exit 0
}

Show-Title
Show-Help
while (-not $script:exitRequested) {
  $selection = Read-Host 'negev'
  Execute-Command $selection
  Write-Host ''
}
Write-Host 'control center closed. the server was not changed.' -ForegroundColor DarkGray
