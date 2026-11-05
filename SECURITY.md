# Security policy

## Reporting a problem

Report security issues privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (private vulnerability reporting). If that is unavailable, open an issue that says only that you have a security report, without details, and the maintainer will arrange a private channel. Please do not post exploit details in public issues.

You can expect an acknowledgement within a week. Fixes are released as a new version with a note in the changelog of the README.

## What the core plugin can do

`personal-wbs` (the plugin at the repository root) contains only:

- **Agent Skills** (`skills/*/SKILL.md`): instructions that Claude follows. They tell Claude to read your sources, write the ledger files to the place you chose, and never send, edit, share or delete anything in a connected app.
- **Python scripts** (`scripts/`): standard library only, no network calls, no subprocesses. They read and write the ledger folder you pass them.
- **Evals** (`evals/`): test cases that run only when you run `claude plugin eval`.

The core plugin has **no hooks, no MCP servers, no agents, no executables on the PATH (`bin/`) and no network access of its own**. It cannot run anything unless Claude runs it in your session, under your permission settings.

## The optional autolog plugin

`plugins/personal-wbs-autolog` is a separate plugin that you install only if you want it. It adds:

- a `SessionEnd` hook (and a `SessionStart` note) running a Python standard-library script that appends `{session_id, time, cwd, transcript_path}` to a file in the plugin's own data folder (`${CLAUDE_PLUGIN_DATA}/queue.jsonl`). The script never reads conversation content and never uses the network;
- a read-only collector agent and a skill that logs the queued sessions when you ask.

Hooks run on your machine with your user's permissions; read `plugins/personal-wbs-autolog/scripts/` before installing.

## What to keep private

- `sweep_state.json` lists the IDs of everything a sweep reviewed. Never publish it; it is in `.gitignore`.
- Ledgers should live in a private location (a private repository, a private artifact or a local folder).
- `validate.py` warns when an e-mail address, @handle, phone number or account-like number appears in the ledger.

## Supported versions

Only the latest release on `main` receives fixes.
