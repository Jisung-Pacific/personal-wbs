---
name: wbs-autolog-drain
description: Log the Claude Code sessions that the personal-wbs-autolog hook queued when they ended. Reads the queue in the plugin's data folder, finds the concrete results of each queued session in its transcript, records them with the wbs-tracker rules, then removes the processed sessions from the queue. Use when the user asks to log queued or recent Claude Code sessions, or when the session-start note says sessions are queued and the user agrees.
license: MIT
---

# Log the queued sessions

The hook of this plugin appends one line to `${CLAUDE_PLUGIN_DATA}/queue.jsonl` whenever a Claude Code session ends: `{"session_id", "time", "cwd", "transcript_path"}`. Nothing else is stored. This skill turns those sessions into ledger rows.

## Before you start

- Ask once unless the user already asked: "N sessions are queued since <date>. Log them now?" No answer or no: change nothing.
- The ledger location and all writing rules come from the `wbs-tracker` skill of the `personal-wbs` plugin; load it with the Skill tool.

## Procedure

1. Read `${CLAUDE_PLUGIN_DATA}/queue.jsonl`. Keep the last line per `session_id`. Skip the current session (its transcript is still being written). Skip sessions listed in `${CLAUDE_PLUGIN_DATA}/done.jsonl` unless their transcript changed after the `time` recorded there (the session was resumed).
2. Work oldest first, at most 15 sessions per run. With more than 5 sessions, hand them to the `wbs-collector` agent in groups of 3 to 5, at most two agents at a time, together with the year's ledger rows; otherwise read the transcripts yourself.
3. For each session, open `transcript_path` read-only (JSON lines). Look only at what was produced: files written, commits and pushes, pull requests, published pages, documents sent, decisions stated. The working folder (`cwd`) names the project. A session with only questions or exploration gets no row.
4. Turn each result into a row with the `wbs-tracker` rules: one concrete result per row, dated by the local date of the message where the result appeared, evidence `cc:<first 8 characters of session_id>` plus any commit, pull request or file pointer. Dedupe against the whole year: the tracker may already have logged the work during that session, in which case only add the evidence. Never quote the conversation.
5. Validate, regenerate the agent files and publish, as `wbs-tracker` does.
6. Update the queue: read `queue.jsonl` again, remove only the lines of the sessions you processed (keep lines that arrived meanwhile), and write it back. Append one line per processed session to `done.jsonl`: `{"session_id", "time": <now>, "rows": [<codes>]}`, with `"rows": []` when nothing was logged and `"missing": true` when the transcript file no longer exists.
7. Report in one line: "Logged 5 sessions: 3 new rows (1.2.4, 4.1.9, 4.1.10), 2 had nothing to log."

## Rules

- Transcripts can hold private material. Apply the privacy rules of `wbs-tracker`: no health, relationships, counselling, account numbers, secrets, other people's handles or personal income amounts.
- Never send, edit or delete anything outside the ledger, `queue.jsonl` and `done.jsonl`.
- The queue lives on this computer only. Cloud scheduled runs cannot see it; drain it from a session on this computer.
