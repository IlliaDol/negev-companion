# Security and privacy

This project is designed to keep credentials and personal companion settings local while still allowing a reusable Negev character core to be published.

- Never commit `.env`, `persona.local.json`, `data/`, `logs/`, `outputs/`, or `work/`.
- Copy `persona.local.example.json` to `persona.local.json` and put personal voice, location, timezone, relationship details, and project paths there.
- Keep generated Windows `.lnk` files local. They contain machine-specific absolute paths; publish the shortcut-generation script instead.
- Keep API keys in `.env` or the operating system environment, never in source, tests, prompts, logs, screenshots, or archives.
- Run `npm run public-audit` before creating a commit or uploading anything.
- If a key was pasted into a chat, screenshot, terminal, or repository, revoke and rotate it immediately.

The public repository may contain Negev's name, general voice, slight tsundere style, generic slang examples, and non-manipulative relationship guidance. It must not contain a user's real location, personal projects, learned memory, private conversation, private schedule, or credentials. A local profile is configuration, not part of the project source.
