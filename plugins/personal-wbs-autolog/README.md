# personal-wbs-autolog

An optional companion to [personal-wbs](../../README.md) for **Claude Code**. It remembers which sessions ended, so their work can be logged to your WBS ledger later, even when you forgot to ask during the session.

| Part | What it does |
|---|---|
| `SessionEnd` hook → `scripts/enqueue_pointer.py` | Appends `{session_id, time, cwd, transcript_path}` to `queue.jsonl` in the plugin's data folder. Never reads the conversation, never uses the network, exits 0 at once. |
| `SessionStart` hook (startup) → `scripts/queue_note.py` | When sessions are queued, adds one factual line to the new session's context, at most once a day. |
| `wbs-autolog-drain` skill | When you agree, reads the queued sessions' transcripts on your computer, logs their concrete results with the `wbs-tracker` rules, and removes them from the queue. |
| `wbs-collector` agent | A read-only helper (Sonnet, at most 40 turns, no file-editing tools) that returns candidate rows for one source × month window or a few queued sessions. It never writes the ledger. |

It needs the core `personal-wbs` plugin (declared as a dependency) and `python3` on your PATH.

## Install

```
/plugin marketplace add Jisung-Pacific/personal-wbs
/plugin install personal-wbs-autolog@personal-wbs
```

Hooks and agents load in Claude Code and Cowork; the claude.ai chat app ignores them (https://claude.com/docs/plugins/platform-support).

## What is stored, where, and for how long

- Only the four fields above, in `~/.claude/plugins/data/<plugin id>/queue.jsonl`, plus `done.jsonl` (sessions already logged, with the row codes) and `note_state.json` (the day of the last note). The transcripts stay where Claude Code keeps them; this plugin never copies them.
- Nothing is sent anywhere. The scripts are short; read them before installing.
- Uninstalling the plugin deletes its data folder (unless you pass `--keep-data`); deleting `queue.jsonl` empties the queue at any time.

## When it runs

- At the end of every Claude Code session (the `SessionEnd` hook; Claude Code gives these hooks a short time budget, and the script needs well under a second).
- At the start of a new session, only to print the one-line note when sessions are waiting.
- The transcripts are read only when you run or approve the `wbs-autolog-drain` skill, in a session on the same computer.

The privacy policy of the package is in [PRIVACY.md](../../PRIVACY.md); security reporting in [SECURITY.md](../../SECURITY.md).
