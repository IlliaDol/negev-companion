# Private Telegram companion architecture

This document is the map for a person or AI changing the project. The bot is intentionally dependency-free and keeps all durable data in `data/`.

## Runtime flow

```text
bot.js
  ├─ Telegram long polling          telegram-api.js
  ├─ owner and command gates        commands.js
  ├─ message normalization          media.js / links.js
  │   └─ local document conversion  optional NEGEV_DOCUMENT_PIPELINE
  ├─ conversation state             conversation.js
  ├─ durable memory and calendar    memory.js / store.js
  ├─ timing and sleep windows       timing.js
  ├─ reply generation               persona.js / style.js / provider-client.js
  ├─ exact usage accounting         usage.js
  └─ scheduled work                 overnight, delayed, reminder, proactive queues
```

`bot.js` is the coordinator. Business rules belong in the named module beside them; Telegram HTTP belongs in `telegram-api.js`; provider-specific request formats belong in `provider-client.js` and `providers.js`.

## Module responsibilities

| File | Responsibility | Keep out of it |
| --- | --- | --- |
| `bot.js` | lifecycle, ownership, orchestration, queues, scheduling | provider request formats and low-level Telegram HTTP |
| `telegram-api.js` | authenticated Telegram calls and bounded media downloads | conversation or memory decisions |
| `media.js` | attachment detection, local transcription/OCR, optional document-to-Markdown conversion, and bounded evidence | model or state changes |
| `conversation.js` | topic, intent, energy, open loops, callbacks, motivation follow-through | API calls and durable fact parsing |
| `memory.js` | explicit facts, promises, tasks, calendar dates, rolling history | model persona or Telegram transport |
| `timing.js` | local time, sleep windows, delays, waiting and mood drift | persistent state writes |
| `persona.js` | core voice and prompt construction | interpreting Telegram commands |
| `style.js` | bubble splitting and final human-style formatting | model calls or state changes |
| `provider-client.js` | provider request/response adapters | selecting or storing provider configuration |
| `providers.js` | provider catalog, selection, and key metadata | raw secret values in returned objects |
| `store.js` | state schema, atomic saves, backup recovery, logs | feature-specific business logic |
| `usage.js` | provider-reported token/cost ledger and estimates | prompt content or credentials |
| `commands.js` | user-facing Telegram help text | command execution |

## State boundaries

- `data/state.json` contains owner identity, rolling chat history, explicit memory, calendar items, queues, mood, sleep notices, and conversation state.
- `data/state.previous.json` is the last valid snapshot and is used for recovery after an interrupted write.
- `data/usage.json` is the append-only-style usage ledger. It survives chat clears and memory resets.
- `.env` contains secrets and local configuration. Never copy secrets into source, logs, tests, archives, or documentation.
- `NEGEV_DOCUMENT_PIPELINE` points to an optional local converter. Its path and any converter credentials stay in `.env`; converter output is temporary, bounded, labeled as evidence, and removed after processing.
- `logs/` contains operational events. Log IDs, modes, and counts—not API keys or prompt secrets.

## Message decision order

Every incoming private-owner message follows this order:

1. Verify private-chat ownership and record the Telegram update offset.
2. Recognize a command. Bang and slash prefixes use the same command parser.
3. Keep `/mute`, `/unmute`, and `/force` semantics explicit before normal reply gates.
4. Observe conversation intent, topic, energy, open loops, date references, and memory.
5. Queue ordinary messages during sleep, mute, waiting mode, or a human delay as appropriate.
6. Build bounded media/link evidence and a private prompt context.
7. Call the selected provider and record its exact usage result.
8. Split, send, bind usage, record assistant history, and save state only after delivery.

The important invariant is delivery-first bookkeeping: a reminder, queue item, or promise is not marked handled when a send fails. Failed sends remain recoverable.

## Scheduler order

The scheduler runs every ten seconds in this order:

1. update heartbeat;
2. send bedtime/wake notices when their local window is reached;
3. process the overnight queue after waking;
4. process delayed replies;
5. process due calendar reminders;
6. process proactive conversation messages.

Sleep, mute, and the user's request for space pause proactive work. `/force` is the deliberate one-message override and still records normal history and usage.

## Safe change checklist

When changing a feature:

1. Put the rule in the narrowest responsible module.
2. Preserve old state with `store.js` defaults; never reset existing arrays during migration.
3. Add a focused self-test for the edge case and keep the test dependency-free.
4. Run `node --check` for every JavaScript file and `node selftest.js`.
5. Restart with `powershell -ExecutionPolicy Bypass -File .\negev-console.ps1 restart` so the running local process uses the change.
6. Verify with `powershell -ExecutionPolicy Bypass -File .\negev-console.ps1 status`.

Do not use destructive Git commands or delete `data/` while debugging. A chat reset is a product action, not a development shortcut.
