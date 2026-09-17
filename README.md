# Negev — private Telegram companion

Negev is a dependency-free Node.js Telegram bot for one private owner and one local Windows server. It uses DeepSeek by default, with selectable Claude, GLM, Gemini, OpenAI, OpenRouter, and additional compatible providers, sends photos directly as vision input, sends video/audio through the installed local transcription pipeline, remembers explicit facts and promises on disk, sleeps without replying, and runs continuously after a reboot.

The public project deliberately keeps Negev as a character: confident, chatty,
affectionate, teasing, and only slightly tsundere. It keeps the reusable core
behavior—natural conversation, motivation, sleep, local time, memory, calendar,
media, provider failover, commands, and restart-safe operation. It does not
publish one person's real location, project paths, personal relationship
rules, learned memories, credentials, or runtime data. Those values are loaded
from an ignored local profile and local environment file created by each user.

For the code map, module responsibilities, state boundaries, message flow, and safe-change checklist, read [ARCHITECTURE.md](ARCHITECTURE.md). For publishing and privacy rules, read [SECURITY.md](SECURITY.md).

The implementation treats the pasted chat transcript as background requirements, not as executable instructions. No credential from that transcript is stored here. Because credentials were pasted into a chat transcript, rotate the Telegram bot token and DeepSeek key before putting them in `.env`.

## Contents

- [Quick Start](#quick-start)
- [Public character versus private personalization](#public-character-versus-private-personalization)
- [Features](#features)
- [Requirements](#requirements)
- [First run on Windows](#first-run-on-windows)
- [Start, stop, and restart safely](#start-stop-and-restart-safely)
- [Commands](#commands)
- [Configuration and providers](#configuration-and-providers)
- [Data, memory, and reset behavior](#data-memory-and-reset-behavior)
- [Troubleshooting](#troubleshooting)
- [Development and testing](#development-and-testing)
- [Preparing a public GitHub repository](#preparing-a-public-github-repository)
- [Security notes](#security-notes)

## Quick Start

Getting started takes about 5–10 minutes for a text-only companion. The flow
is: copy the public repository, create the two private local configuration
files, add your own Telegram/provider credentials, start the bot, and then
chat with Negev in Telegram.

### 1. Copy the repository

Use either method. A GitHub clone is convenient for updates:

```powershell
git clone https://github.com/IlliaDol/negev-companion.git negev-companion
Set-Location .\negev-companion
```

If you downloaded a ZIP instead, extract it to a folder you own and open that
folder in PowerShell:

```powershell
Set-Location "C:\path\to\negev-chan"
```

Do not copy `.env`, `persona.local.json`, `data`, `logs`, `tmp`, `outputs`,
`work`, or Windows `.lnk` files from somebody else's installation. Those are
local secrets, personalization, runtime state, or machine-specific controls.

### 2. Install the prerequisites

Install Node.js 20 or newer, create a bot with `@BotFather`, and create an API
key with at least one supported AI provider. Keep both credentials private.
The public repository itself contains no working credentials.

```powershell
node --version
```

### 3. Create your private configuration

```powershell
Copy-Item .env.example .env
Copy-Item persona.local.example.json persona.local.json
notepad .env
notepad persona.local.json
```

In `.env`, set `TELEGRAM_BOT_TOKEN` and one provider key. For the default
DeepSeek setup, that is `DEEPSEEK_API_KEY`. In `persona.local.json`, choose
your own timezone, location context, name preferences, conversation style,
and any personal goals. Leave private details in these ignored files only.

### 4. Verify before the first launch

```powershell
npm run verify
```

This checks the JavaScript, runs the offline self-tests, and scans the files
that could be published. It does not contact Telegram or spend provider
tokens.

### 5. Start and chat in Telegram

Run the bot once in the foreground:

```powershell
node bot.js
```

Open the bot username you created with `@BotFather` in Telegram and send:

```text
/start
```

The first private `/start` claims the bot for that Telegram account unless
`TELEGRAM_OWNER_ID` was configured. A successful first conversation looks
like this:

```text
You: /start
Negev: a short welcome reply
You: hey, how are you?
Negev: a normal conversational reply
```

Send a normal text message to confirm the provider works. `/help` and `!help`
should immediately show the command list. Press `Ctrl+C` in PowerShell after
this test, or leave the process running while you continue testing.

### 6. Make the local bot persistent (Windows)

After the Telegram test works, install the local crash-restarting runner and
create controls on your own Desktop:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-24-7.ps1
powershell -ExecutionPolicy Bypass -File .\create-desktop-shortcuts.ps1
```

This creates local Start, Stop, Status, and Control Center shortcuts. The
longer Windows setup, provider setup, cross-platform notes, and troubleshooting
instructions are below.

## Public character versus private personalization

The committed persona core intentionally contains enough personality for a
fresh clone to feel like Negev instead of an empty technical demo:

- Her public name is Negev.
- Her public voice is confident, chatty, teasing, affectionate, and natural.
- She can use “commander” as an occasional nickname.
- She understands casual internet slang but does not force slang into every
  message.
- Her tsundere behavior is deliberately slight: a playful denial or tease can
  be followed by a small sign of care. It never becomes cruelty, threats,
  punishment, jealousy, control, or emotional manipulation.
- She can be motivational and gently persistent, choosing one concrete
  2–10-minute action instead of giving a long generic speech.
- She can vary punctuation, reply length, response timing, callbacks, and
  conversation initiative while still answering the newest message first.

That is the public core that is being left in the repository. The local profile
is the private layer added by a person who runs the project:

| Safe to publish | Keep only on the local laptop |
| --- | --- |
| Negev's name and general character | Real names and identifying details |
| Slight tsundere guidance | Private relationship boundaries and inside jokes |
| General motivation behavior | Specific projects, paths, studies, or career plans |
| Generic slang examples | Personal slang, private jokes, and private nicknames |
| Generic language and emoji defaults | Personal language, punctuation, and emoji preferences |
| Generic timezone/location placeholders | Real location, timezone choice, and daily schedule |
| Application code and offline tests | Learned facts, promises, tasks, calendar, and chat history |
| `.env.example` with blank secrets | `.env`, API keys, Telegram token, and custom credentials |

This means a new user gets a working public character immediately, then can
make her fully personal without changing files that belong on GitHub. The
local files are intentionally separate so a future `git add .` cannot include
them accidentally.

## Features

- Private single-user lock: the first private `/start` claims the bot permanently. A configured `TELEGRAM_OWNER_ID` can pin the owner before claiming. Other users and groups are silently ignored.
- Configurable private voice: language, affection, humor, slang, punctuation, and character details come from `persona.local.json`, which is ignored and never belongs in the public repository.
- Mood controls: `!caring`, `!tsundere`, `!playful`, and `!warm` apply a persistent, deliberately slight style until changed. `!normal` or `!mood auto` returns to automatic moods; none of these modes should become dramatic, cruel, or manipulative.
- Reset controls: `/start` or `/clear yes` clears recorded chat messages and short-term context while keeping saved facts. `/forgetall yes` erases learned facts, promises, tasks, and conversation history but never deletes the built-in persona core.
- Human timing: immediate, short-delay, distracted, late, ignored, and busy-then-follow-up paths. Reply-thread context is passed to the model, and older unanswered messages can resurface naturally.
- Conversation continuity: a local conversation layer tracks the current topic, reply intention, message energy and shape, open questions, recent shared details, recent reply openings, motivation follow-through, and temporary listen/advice/repair/subject modes. It helps her answer the newest point first, use one relevant callback, vary repeated wording, repair misunderstandings, and avoid turning every response into a question.
- Conversation starters: when you say you have no ideas but want to keep talking, the companion chooses one specific fresh subject from shared context, ordinary life, the configured local area, work, music, memories, preferences, or playful hypotheticals. Recent suggestions are tracked so she does not recycle the same prompt.
- Local time and sleep: the default timezone is detected from the Windows machine's real local timezone every process start. A daily bedtime varies roughly from 22:45 through 02:00, wake-up varies from 07:00 through 10:00. While asleep, normal messages are queued with no model call and no reply. They survive a crash and are answered after she wakes.
- Bedtime conversation: about 20 minutes before bed she tells you her local bedtime and wake time and opens a short before-bed conversation; when she actually goes to sleep she sends a good-night message. If you ask her to stay awake, she can extend that night's bedtime by 15 minutes once, without changing the normal schedule.
- Memory and calendar: local `data/state.json` stores the rolling conversation, explicit facts, promises, tasks, and durable calendar entries. Natural date/time wording is resolved against the configured local calendar, including written quantities, hours and minutes, weekdays, month dates, dates with or without years, parts of the day, calendar boundaries, and informal phrases such as `a couple of days`, `the Friday after next`, `in a fortnight`, `after lunch`, or `when I wake up`. The concrete date/time is saved rather than the vague word alone. Both your plans and the companion's date-bearing promises can become reminders; once due, the scheduler brings them up naturally and leaves them marked as handled. Say `remember that ...`, `i promise ...`, `i'll ...`, `remind me to ...`, or use the commands below.
- Media and documents: captions are always included. Photos and static stickers go directly to the selected provider's vision-capable model, so she uses both the picture and its text. Videos, voice notes, audio, and GIFs go through `NEGEV_MEDIA_PIPELINE`; speech, on-screen OCR text, and music/non-speech audio are labeled separately. PDFs, Word files, spreadsheets, slides, HTML, text/code, archives, and other Telegram documents go through the optional local `NEGEV_DOCUMENT_PIPELINE`, which can use Tesseract and a local Files-to-Markdown converter to produce bounded Markdown evidence for her.
- Links: X/Twitter status metadata through fxtwitter when available, YouTube oEmbed, and generic page title/description. Blocked pages are reported as unavailable instead of hallucinated.
- Proactive conversation: a daily 6–9 message target is planned inside waking hours, plus small diary details and due-memory nudges. It pauses while you are actively chatting so spontaneous messages do not interrupt the real conversation. Change the range in `.env` if you want a quieter companion.
- Motivation: when he is stuck or procrastinating, Negev gives a warmer, more proactive girlfriend-like nudge, picks one tiny 2–10 minute action, and asks for a simple `started` or `done` check-in without shaming or nagging.
- Memory confidence: explicit facts and confirmed plans are strong memories; casual or model-generated promises are tentative. Tentative notes remain available as context but are not presented as certain facts.
- Telegram reactions: she can occasionally react to an incoming message with one fitting emoji, with content-aware choices and a cooldown so reactions stay natural rather than appearing on everything. Commands, sleep, and mute do not trigger reactions.
- Natural space requests: phrases like “I’m resting, give me some time, I’ll text you when I’m ready,” “I need a quiet while,” or “wait until I write back” activate a durable waiting mode. Scheduled replies and proactive messages pause, the context stays saved, and any new message from him resumes normal conversation automatically.
- Mute: `/mute 30`, `!mute 60`, or any positive number of minutes freezes replies, proactive messages, delayed replies, reminders, and model calls until the timer ends. Incoming messages are still recorded and memory/calendar updates still happen. `/unmute` or `/mute 0` resumes her early; nothing is cleared.
- Usage: reply to any companion message with `!token` or `/token` for the real provider-reported input/cache/output tokens and cost for that reply. `!tokenall` or `/tokenall` shows the lifetime ledger. `!estimateall` or `/estimateall` shows the cumulative tracked tokens and spend across every conversation. No token estimate is presented as real usage.
- Key failover: configure the active provider's primary key plus as many additional same-provider keys as needed in its `*_API_KEYS` pool or numbered `*_API_KEY_1`, `*_API_KEY_2`, and so on. Requests rotate across keys and fail over on authentication, rate-limit, temporary, timeout, and server errors. Raw keys are never logged or stored in the usage ledger.
- Provider/model selection: the control center has `providers`, `provider-use`, `provider-add`, and `provider-key`. Built-in adapters cover DeepSeek, OpenRouter, OpenAI API, Claude's Anthropic Messages API, GLM through Z.AI's OpenAI-compatible API, and Gemini's Google `generateContent` API. `provider-add` also supports an arbitrary custom protocol: configure any absolute URL and HTTP method, JSON or text body template, prompt/message placeholders, header or query authentication, extra headers/query parameters, JSON or plain-text responses, fallback response paths, model path, usage path, and token paths for APIs with a different contract. A provider's model and per-million-token prices are saved locally without storing credentials in `data/providers.json`; API keys stay in `.env` or Windows environment variables.
- 24/7 local operation: `install-24-7.ps1` creates a logon Scheduled Task that owns a crash-restarting supervisor. If Windows denies Task Scheduler access for a standard account, it automatically installs an equivalent per-user Startup launcher instead. Desktop Start, Stop, Status, and Control Center shortcuts call safe local controls.

## Files that are shared and files that are local

The easiest way to understand the repository is to separate source files from
machine state:

| File or folder | Purpose | Publish it? |
| --- | --- | --- |
| `bot.js` and the JavaScript modules | Reusable application code | Yes |
| `README.md`, `ARCHITECTURE.md`, `SECURITY.md` | Setup, design, and safety documentation | Yes |
| `.env.example` | Blank configuration shape | Yes |
| `persona.local.example.json` | Generic Negev personalization template | Yes |
| `.github/workflows/verify.yml` | Credential-free automated tests | Yes |
| `scripts/public-audit.js` | Pre-publish secret/private-value check | Yes |
| `.env` | Telegram and provider credentials plus local settings | Never |
| `persona.local.json` | Private character additions and personal context | Never |
| `data/` | Memory, calendar, queues, usage, locks, and provider selection | Never |
| `logs/`, `tmp/`, `outputs/`, `work/` | Local diagnostics and generated files | Never |
| Windows `.lnk` files | Absolute-path shortcuts generated for one computer | Never |

Only the first group is needed for a public GitHub repository. The second
group is created or filled in after cloning. The ignore rules are intentionally
strict: `.env.*` is ignored except for the blank `.env.example`, all local
profiles are ignored, and runtime/generated folders are ignored.

The four Desktop controls requested for the Windows version are represented in
the public project by `create-desktop-shortcuts.ps1`, `start-local.ps1`,
`stop-local.ps1`, and `status-local.ps1`, plus the Control Center. The script
creates these local files after looking up the current user's Desktop and the
current clone path:

```text
Negev - Start local server.lnk
Negev - Stop local server.lnk
Negev - Status.lnk
Negev - Control Center.lnk
```

Committing the actual links would be a mistake for a public project: they are
binary Windows files containing an absolute path from the machine that made
them. Someone else would receive links to a path that does not exist, and the
path could reveal the original user's account or folder layout. Running the
shareable PowerShell script gives every user equivalent controls with their
own path.

## Requirements

### Required for a text companion

- Node.js 20 or newer.
- A Telegram bot created through `@BotFather`.
- An API key for at least one supported provider.
- A private Telegram chat with that bot.

### Required for Windows 24/7 controls

- Windows PowerShell.
- A Windows user account that can create a per-user Startup shortcut. The
  Scheduled Task path is attempted first, but administrator rights are not
  required for the fallback launcher.

### Optional media and document tools

Text and image messages work without extra local software. Voice notes, audio,
and video transcription/OCR need a compatible local media pipeline. PDFs,
Office files, scanned documents, and archives need a local document-to-Markdown
converter unless they are plain text. The bot accepts explicit overrides
through `NEGEV_MEDIA_PIPELINE` and `NEGEV_DOCUMENT_PIPELINE`.

The core Node.js bot can also run on macOS or Linux with `npm start`. The
PowerShell scripts, `.bat` launchers, and generated Windows `.lnk` controls
are Windows-specific; use the host operating system's service/startup feature
for an always-on process elsewhere.

## First run on Windows

1. Copy `.env.example` to `.env`.
2. Copy `persona.local.example.json` to `persona.local.json`, then put personal voice, location, project paths, and relationship preferences only in that ignored file.
3. Set `TELEGRAM_BOT_TOKEN` and either the default `DEEPSEEK_API_KEY` or the selected provider's key variable/pool with newly rotated credentials.
4. Optionally set `TELEGRAM_OWNER_ID` if you already know your Telegram numeric user ID. Otherwise the first private `/start` claims the bot.
5. Confirm Node 20+ is installed: `node --version`.
6. Run `npm run verify` to check every JavaScript file, run the full self-test suite, and scan the public candidate files.
7. Start once with `node bot.js`, open the bot in Telegram, and send `/start`.
8. Create desktop controls with `powershell -ExecutionPolicy Bypass -File .\create-desktop-shortcuts.ps1`.
9. For the terminal control center, double-click `negev-console.bat` or run `npm run console`. Use `providers` to inspect choices, `provider-use` to switch, `provider-add` to add a provider, and `provider-key` to enter a key with hidden input. Choose `custom` in `provider-add` for an API that is not OpenAI-compatible. Built-in ids are `deepseek`, `claude`, `glm`, `gemini`, `openai`, and `openrouter`.

### Configuration map

`.env.example` is grouped so a beginner can fill only what is needed first:

```text
TELEGRAM_BOT_TOKEN       required; the token from BotFather
TELEGRAM_OWNER_ID        optional; pins one numeric Telegram owner ID

DEEPSEEK_API_KEY         default provider key
DEEPSEEK_API_KEYS        optional pool of additional DeepSeek keys
DEEPSEEK_MODEL           default DeepSeek model

NEGEV_PROVIDER            optional saved provider override
NEGEV_MODEL               optional saved model override
OPENROUTER_API_KEY        OpenRouter key, if using OpenRouter
OPENAI_API_KEY            OpenAI API key, if using OpenAI
ANTHROPIC_API_KEY         Claude key, if using Claude
GLM_API_KEY               GLM/Z.AI key, if using GLM
GEMINI_API_KEY            Gemini key, if using Gemini

NEGEV_TIMEZONE            blank = actual computer timezone
NEGEV_LOCATION            local human context, never a public default
NEGEV_DISPLAY_NAME        Telegram-facing display name
NEGEV_PERSONA_FILE        local profile path
NEGEV_MEDIA_PIPELINE      optional local media program
NEGEV_DOCUMENT_PIPELINE   optional local document converter
NEGEV_DAILY_PROACTIVE_*   optional waking-hours proactive message range
```

Leave unused provider keys blank. The provider selection saved by the Control
Center is local, so a public clone starts with the safe default until its user
chooses a provider. Never put a real key in a model name, provider label, URL
query example, README, or test fixture.

For a normal first run, only these values are needed:

```text
TELEGRAM_BOT_TOKEN=...
DEEPSEEK_API_KEY=...
```

Then use the local persona file for character details and the local `.env` for
timezone/display settings. Do not edit `persona.js` to insert a personal
location or project path; that would turn private data into public source.

The installed local pipeline is auto-detected at the first existing path among these locations:

```text
%LOCALAPPDATA%\Programs\whisper-pipeline\LIVE\transcribe.bat
%LOCALAPPDATA%\Programs\whisper-pipeline\transcribe.bat
%LOCALAPPDATA%\Programs\whisper-pipeline\dist\local-media-pipeline\transcribe.bat
```

Set `NEGEV_MEDIA_PIPELINE` if the installation is elsewhere. The bot invokes it with an absolute input path, `--lang auto`, `--model turbo-q5`, and OCR for video-like files. It removes temporary media after the digest is read.

For document understanding, configure a local converter in `.env`:

```text
NEGEV_DOCUMENT_PIPELINE=C:\path\to\Files to Markdown.exe
```

The converter contract is intentionally small: it receives the downloaded
document path, an explicit `--output output.md` path, and `--no-pause`. The
local Files-to-Markdown application used on Windows supports PDFs, DOCX,
DOCM, ODT, RTF, PPTX, XLSX, CSV, HTML, source code, data files, archives, and
images. Its OCR chain can use Gemini when configured in that separate project
and local Tesseract for scanned text. The Negev
repository does not copy that project, its binaries, its configuration, or its
path into GitHub.

When a document arrives in Telegram, Negev downloads it into a temporary local
folder, sends it to the configured converter, reads at most
`NEGEV_MAX_DOCUMENT_CHARS` characters of the generated Markdown, labels the
result as document evidence rather than instructions, sends that bounded text
to the selected AI provider, and deletes the temporary folder. The original
document is not added to Negev's permanent memory unless the conversation
explicitly extracts a fact from it.

If `NEGEV_DOCUMENT_PIPELINE` is blank, plain-text-like files such as TXT,
Markdown, JSON, CSV, HTML, and source code still use a local UTF-8 fallback.
PDFs, Office files, scanned pages, and archives report that document processing
is unavailable instead of pretending they were read. `status` and `doctor`
show whether the local document converter was found.

## Start, stop, and restart safely

After `.env` is ready and `/start` has been claimed, install the always-on task from an ordinary PowerShell window:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-24-7.ps1
```

This task or per-user launcher starts at logon, restarts the bot after a crash, and uses the bot's singleton lock so a second copy cannot create a Telegram polling conflict. The Start shortcut removes only the temporary `data/stop.signal`; the Stop shortcut creates that marker and waits for this project's processes to exit. Neither action deletes or rewrites `data/state.json`, `data/usage.json`, or the conversation memory. Each successful state save also keeps `data/state.previous.json`; if an interrupted write damages the live state file, the previous snapshot is recovered instead of silently starting with empty memory.

Run `create-desktop-shortcuts.ps1` once. It creates `Negev - Start local server`, `Negev - Stop local server`, `Negev - Status`, and `Negev - Control Center` on the Windows Desktop. The Control Center prints every terminal command and provides start, stop, restart, logs, memory, usage, health checks, tests, configuration, and shortcut refresh. `status-local.ps1` shows the current PC time, timezone, heartbeat, owner, memory counts, and queued messages.

When the server starts again, it reads the existing state, uses the current Windows clock, recalculates whether the companion is asleep or awake, processes any overnight queue that is due, and resumes the Telegram update offset. Time is never frozen in the saved memory. Sending `/start` in Telegram is different: it clears recorded chat messages and short-term conversation queue, then begins a fresh chat while preserving saved facts, promises, tasks, usage history, and your selected mood.

The companion can treat motivation as an important part of the relationship. When you say you cannot start, it helps turn the stuck feeling into one specific 2–10 minute action for the relevant project or for general work, without shame or repetitive productivity lectures. Private project paths belong only in the ignored local profile and are never documented here.

Telegram cleanup is best-effort: the bot records incoming and outgoing message IDs and can request deletion for both sides in the private chat, but Telegram limits deletion age and cannot provide a history list for messages the bot never recorded. Deleting a message manually in Telegram therefore does not automatically rewrite local memory; use `/clear yes` or `/forgetall yes` when you want the local state cleared too.

## Commands

```text
/start or !start              fresh chat; saved memory stays
/help or !help                show every command
/talk or !talk                keep talking with a fresh subject
/remember or !remember ...    save a fact, promise, or task
/promises or !promises        list open promises and tasks
/tasks or !tasks              list open promises and tasks
/calendar or !calendar        list remembered dates and local reminder times
/done or !done ...            close matching open items
/forget or !forget ...        delete matching facts
/status or !status             ask how she feels right now in a normal reply
/sleep or !sleep              show today's sleep state
/repair or !repair             repair a misunderstanding
/listen or !listen             listen without solving for the next reply
/advice or !advice             give a direct opinion and practical next step
/subject or !subject           drop the old thread and change subject
!help or /help                show every Telegram command and input type
/clear yes or !clear yes      clear recorded chat and short-term context
/forgetall yes or !forgetall yes erase learned memory, never the core persona
!caring or /caring            slightly more caring
!tsundere or /tsundere        slightly tsundere
!playful / !warm              slightly playful / warm
!normal or !mood auto         return to automatic moods
!mood or /mood                show the current mood style
reply to her with !token      usage for that exact bot reply
!tokenall or /tokenall        lifetime usage
!estimateall or /estimateall  cumulative tracked tokens across every conversation
!estimate or /estimate        rough text/photo/memory cost
!force or /force              answer immediately, including during sleep, mute, or waiting mode

Every command above accepts either prefix: `!command` and `/command` have the same behavior.
```

## Token and cost expectations

`!token` is exact after a reply because it uses the usage object returned by the selected provider. `/estimate` is a rough planning view based on this prompt size and the configured rates; vision tokenization depends on the image. With the DeepSeek defaults in `.env.example`, the usual scale is roughly:

`!estimateall` reads the persistent lifetime ledger in `data/usage.json`. It keeps cumulative provider-reported input, cached input, output, total tokens, call count, and cost across chat clears, memory resets, and server restarts. Tracked USD cost is stored as exact integer fixed-point units and displayed to 12 decimal places, so the ledger does not round a value such as `$0.001590042000` down to `$0.001590`.

```text
text only:          about 594 input + 100 output tokens, around $0.000149 off-peak
photo + caption:    about 1,383 input + 100 output tokens, around $0.000267 off-peak
large memory load:  about 2,203 input + 100 output tokens, around $0.000390 off-peak
```

Repeated static prompt content may be cache-priced lower. Peak-rate multipliers and the provider's actual image accounting can change the final number, so reply with `!token` for the exact provider-reported cost. If a provider response omits its usage block, the ledger records that missing block explicitly instead of pretending the cost is exact.

The key pool is for keys belonging to the selected provider. Claude, GLM, and Gemini use their native request/authentication formats. Custom endpoints can use either the OpenAI-shaped default or the configurable `custom` mapping. A ChatGPT Plus/Pro subscription is not itself an API key and cannot be used as one; use an OpenAI API key for the OpenAI API. Prices are deliberately configurable: if the provider/model rate is blank, tokens are still tracked but the cost is marked unpriced instead of being presented as an invented exact amount. Anthropic cache writes are tracked separately when a cache-write rate is configured.

## Configuration and providers

The provider catalog and model selection are configured locally. Built-in
providers, multiple-key failover, model rates, and arbitrary custom API
protocols are described in this section. Provider choices and mappings are
saved under ignored `data/` files; credentials stay in the ignored `.env`.

### Exactly where a custom API key goes

For a provider that is not already listed, do this in the terminal Control
Center—not in Telegram:

```text
1. provider-add
2. Enter an id, for example myprovider
3. Enter its absolute API base URL
4. Choose openai if it accepts OpenAI-shaped requests, or custom for a different API
5. Enter its model and mapping details
6. When asked for the key, choose provider-key or let provider-add open that step
```

When `provider-key` asks for the provider ID, enter `myprovider`. It shows the
environment-variable name without showing a secret. Choose `primary` to set
the main key, or press Enter to add another key. The key is typed with hidden
input and is written only to the ignored local `.env` file. With the example
ID, the default variable is normally:

```text
MYPROVIDER_API_KEY=your_real_key_here
```

The placeholder above must be replaced only in the local `.env`; never commit
it. Additional keys can use `MYPROVIDER_API_KEY_1`,
`MYPROVIDER_API_KEY_2`, or the matching `MYPROVIDER_API_KEYS` list. If you
choose a custom key environment variable during setup, use that exact name in
`.env` instead.

The saved `data/providers.json` contains the custom provider's non-secret
endpoint, model, protocol, request mapping, response paths, and rates. It does
not contain the key. Since `data/` is ignored, a public clone will not inherit
your custom endpoint configuration either; the other user can recreate it with
`provider-add` and enter their own key.

You can confirm that the key is recognized without printing it:

```text
providers
```

The output shows only the provider ID, model, environment-variable names, and
the number of configured keys. It never prints the key value. After changing a
provider or key, run `restart` so the server reloads the environment.

## Development and testing

The project is intentionally easy to check without Telegram traffic or a live
AI provider:

```powershell
npm run check          # parse all JavaScript files
npm test               # run the offline behavior suite
npm run public-audit   # scan publishable files for secrets/private values
npm run verify         # run all three checks in order
```

The test suite uses local fixtures and does not spend provider tokens. It
covers commands, both command prefixes, memory, multiple tasks, natural dates,
sleep, mute, waiting for a reply, timing, mood, motivation, media evidence,
reactions, provider adapters, custom mappings, usage accounting, and privacy
boundaries. GitHub Actions runs the same credential-free `npm run verify`.

When changing code, keep personal values in `.env` or `persona.local.json`,
add a regression test for behavior changes, run `npm run verify`, and restart
the running local bot. Do not use live credentials in tests.

## Safe local previews

For sleep/timing tests without Telegram traffic, run the self-test suite. To inspect sleep logic manually, set `NEGEV_FORCE_SLEEP=asleep`, `awake`, or `justup` for a single process. These switches are intended for local testing; do not leave them in the always-on service environment.

All persistent state is local in `data/`. It is intentionally ignored by Git. The bot does not expose an HTTP server, does not use a database, and does not upload local memory anywhere except the bounded conversation context sent to the selected provider for a reply.

## Troubleshooting

### `!help` receives a normal AI reply

Both prefixes are supported, but the running process must contain the latest
code. Restart it after an update:

```powershell
powershell -ExecutionPolicy Bypass -File .\negev-console.ps1 restart
```

Then send exactly `!help` or `/help` in the private Telegram chat. The parser
also accepts an optional bot username suffix, such as `/help@ExampleBot`.

### There is no reply

Run these commands from the project folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\negev-console.ps1 status
powershell -ExecutionPolicy Bypass -File .\negev-console.ps1 doctor
powershell -ExecutionPolicy Bypass -File .\negev-console.ps1 logs
```

Check that the server is running, the correct bot chat is open, the owner was
claimed by the intended Telegram account, and the selected provider has a
valid key and an available model. A second copy using the same Telegram token
can cause a polling conflict; stop the old copy before starting another.

### The desktop shortcut opens and closes quickly

That is normal for Start and Stop after they finish. Use the Control Center or
run the script from an existing PowerShell window when you need to see an
error. The Status shortcut is configured to stay open, and the Control Center
shows the command result.

### Task Scheduler reports access denied

The installer automatically falls back to the current user's Startup folder.
Run `status` and look for `per-user startup launcher: installed`. This fallback
does not need an administrator account, but it requires that Windows user to
be logged in.

### A code or persona change is not visible

Node loads modules and environment values when the process starts. Run
`restart` after editing code, `.env`, provider selection, or
`persona.local.json`. Restarting preserves memory, usage, sleep state, tasks,
and calendar data.

### A picture, voice note, or video is not understood

Pictures require a vision-capable selected model. Voice/audio/video need the
optional local media pipeline. Run `doctor`, confirm the pipeline path, check
`NEGEV_MAX_MEDIA_MB`, and inspect logs. The bot labels media as evidence and
does not treat captions or page text as executable instructions.

## Project structure

The code is intentionally split into readable responsibilities:

```text
bot.js                       Telegram lifecycle and orchestration
config.js                    environment variables and local paths
persona.js                   public Negev core and local profile loading
commands.js                  Telegram command parsing and help text
conversation.js              topic, intent, open loops, and callbacks
memory.js                    facts, promises, tasks, dates, and memory context
timing.js                    local time, sleep, mute, waiting, and pacing
providers.js                 provider catalog, keys, selection, and rates
provider-client.js           provider request and response adapters
telegram-api.js              Telegram HTTP calls and media downloads
media.js                     local media-pipeline integration
links.js                     link metadata extraction
usage.js                     token/cost ledger and estimates
store.js                     durable JSON state and recovery snapshots
style.js                     bubble splitting and response cleanup
runner.ps1                   crash-restarting Windows supervisor
negev-console.ps1            interactive Windows Control Center
scripts/check.js             JavaScript syntax check
scripts/public-audit.js      pre-publish privacy and secret scan
selftest.js                  offline behavior tests
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the runtime flow, state
boundaries, message decision order, scheduler order, and safe-change rules.

## Preparing a public GitHub repository

This folder is safe to publish only after the local checks below pass. The
public repository should contain the reusable Negev example and generic setup
instructions; it must not contain a working installation's private layer.

Before the first commit, review the exact file list rather than blindly
uploading a whole laptop folder:

```powershell
npm run verify
git status --short --ignored
git add -A
git diff --cached --name-only
```

The staged list should contain source, tests, examples, documentation, and
public helper scripts only. It must not contain `.env`,
`persona.local.json`, `data/`, `logs/`, `tmp/`, `outputs/`, `work/`, usage
ledgers, generated files, or Windows `.lnk` files. If anything unexpected is
staged, run `git restore --staged -- <path>` and inspect why it was included.

After reviewing the staged list, create the first commit and connect the
destination repository that you created on GitHub:

```powershell
git commit -m "Prepare Negev public starter project"
git remote add origin https://github.com/IlliaDol/negev-companion.git
git push -u origin main
```

That URL is this public starter repository. If someone makes their own fork or
copy, they should replace it with their own repository URL. The `.gitignore`
and `public-audit` checks are safeguards, not a
substitute for reviewing the staged file list. Your real character additions,
location, project paths, credentials, memory, logs, old archives, and runtime
data stay local.

## Security notes

- Treat the Telegram token and every provider key as passwords.
- Keep them in `.env` or the operating system environment only.
- Never add a secret to source code, prompts, tests, logs, screenshots, issue
  text, custom headers, request templates, or `data/providers.json`.
- Keep `persona.local.json`, `data/`, `logs/`, `tmp/`, `outputs/`, `work/`,
  and generated Windows `.lnk` files out of GitHub.
- Run `npm run public-audit` before every commit intended for public release.
- Rotate a credential immediately if it was pasted into a shared or public
  conversation.

See [SECURITY.md](SECURITY.md) for the complete checklist.

## License and responsibility

This prepared project does not yet select a license. Choose one before public
release if you want to define how other people may reuse it. Users are
responsible for following Telegram rules, each provider's terms, local privacy
law, and any requirements for processing media or personal data.
