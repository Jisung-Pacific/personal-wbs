---
name: wbs-sweep
description: Find work missing from the personal WBS ledger with an exhaustive, resumable sweep of every source × month window (Claude chats, ChatGPT export, GitHub, Google Drive, Gmail, Calendar, Slack, Notion, local folders), including the daily catch-up of the last 48 hours, the backfill expansion that walks back through older months after the bootstrap's 3-month first look, the range-row atomization pass and re-checks of undated rows. Use when asked to find unlogged work or backfill a year, and for scheduled daily collection runs.
license: MIT
---

# WBS sweep: exhaustive, resumable, recursive

A single pass always ends early, because one context runs out. This protocol never relies on one pass: every source × month is a **window** with a state in `coverage.csv`, every item already judged is recorded in `sweep_state.json`, and each run continues where the last one stopped. A year is finished only when every window is `complete` or `unavailable`.

The ledger's schema, coding rules and update procedure are in the `wbs-tracker` skill; follow them when you merge. Key rules repeated here: one row per concrete deliverable, decision or event, dated exactly from its source, with evidence pointers; never merge several outcomes into a range row; unknown dates stay blank; never guess.

## Files

`coverage.csv`, one row per window, in the ledger's language:

| English header | Korean header | Meaning |
|---|---|---|
| `year` | `연도` | year |
| `month` | `월` | `01` to `12` |
| `source` | `소스` | e.g. `Claude chats`, `ChatGPT export`, `GitHub`, `Google Drive`, `Gmail`, `Google Calendar`, `Slack`, `Notion`, `Local files` (Korean ledgers may name them `Claude 대화`, `ChatGPT 내보내기`, …) |
| `state` | `상태` | `not_started` / `partial` / `complete` / `unavailable` (Korean: `미착수` / `부분` / `완료` / `불가`) |
| `passes` | `패스 수` | how many passes have enumerated the window |
| `new_last_pass` | `최근 신규` | items the latest pass added |
| `last_checked` | `마지막 확인` | date of the latest pass |
| `memo` | `메모` | what was enumerated, e.g. "41 chats listed by ID, 2 new"; limits ("tool limit: …") |

`sweep_state.json`, kept next to the ledger and never shared (it lists item IDs):
```json
{"updated": "YYYY-MM-DD", "language": "en",
 "sources": {"claude": {"reviewed": {"<id8>": ["<verdict>", "<reviewed on>"]}},
             "chatgpt": {"export_date": "YYYY-MM-DD", "reviewed": {}},
             "github": {"<owner/repo>": {"commits_through": "YYYY-MM-DD", "prs_through": "YYYY-MM-DD"}},
             "drive": {"files_reviewed": []}, "gmail": {"through": ""}, "calendar": {"through": ""},
             "slack": {"through": ""}, "notion": {"pages_reviewed": []}, "local": {}},
 "keywords": {"queue": {"2026": []}, "searched": {"2026": []}},
 "undated": ["2025 5.1.2"],
 "log": [{"date": "YYYY-MM-DD", "windows": ["2026-03 GitHub"], "new": 0}]}
```
Verdicts: `<year> <code>` (covered by that row), `new:<code>` (added this run), `detail:<code>` (added evidence or a step to that row), `skip:<reason>` (no work: chit-chat, personal, out of scope, private), `seen:<pass>` (judged, not yet merged).

## Window states

- `not_started`: no pass yet.
- `partial`: swept, but the latest pass still found new items, there have been fewer than 2 passes, or the month is still running.
- `complete`: at least 2 passes, the latest found 0 new items, and the month is over. Only a fresh enumeration of the window can close it; re-judging earlier verdicts counts as a pass but never closes a window.
- `unavailable`: the source cannot be reached (no connector, history no longer kept, export not provided). Say why in the memo.
- A new item found in a `complete` window by any route reopens it to `partial`.
- A window that stays `partial` only because of a tool limit (memo starts with "tool limit") is re-checked once a month, not every run.
- On the first run of a new month, append that month's windows as `not_started`; on the first run of a new year, append the year.

## One run

1. **Load** `wbs.csv`, `coverage.csv`, `sweep_state.json` (create them if missing), and `plan.csv`.
2. **Pick windows** within the budget (default: at most 6 windows per run, at most 2 or 3 subagents at a time):
   1. Catch-up: the last 48 hours across every reachable source (always; this is the whole job of a daily scheduled run).
   2. Open windows of the current year (`partial`, then `not_started`), oldest month first.
   3. Backfill: after the bootstrap's first look the ledger holds only the last 90 days, so the windows beyond it are `not_started`. Go backwards: the last 12 months first, then earlier years newest first, newest month first. In **backfill mode** (the scheduled expansion run) this is the whole job: take the next N open windows (default 3), skip the catch-up if the daily run does it, and do not exceed one run's budget.
   New packages for an older year take that year's next free package number; existing codes never change.
3. **Enumerate each window completely, by ID**, with date-bounded listings paged to the end (see Sources). Diff the IDs against `sweep_state.json`; an item updated after it was judged counts as new (a continued chat, an edited file). Judge every unreviewed item with a work lens, from its listing whenever possible, and record a verdict for every ID. An item that serves an existing task (research for it, tool comparison before a purchase, formatting) is `detail:`, not `skip:`. Re-judge `skip:` verdicts that look like Q&A before closing a window: Q&A often serves a task.
4. **Snowball**: for every new item, take 2 to 5 distinctive terms (project, tool, file or organisation names) and search the other sources and the whole year for them; queue the windows of any unreviewed hit and push the terms onto `keywords.queue`. When no window is open, pop up to 20 queued terms per run as a cross-check. Enumeration by ID, not keyword search, is what closes a window.
5. **Merge** into wbs.csv with the wbs-tracker rules: dedupe against the whole year; the same result seen again only adds evidence; a new result of an existing task becomes a dated level-4 step or a new row; new tasks take the next free code. Date every row from the item that carries the result, and add its evidence pointer. Append events (`create`, `status`); events for work that happened before today are `estimated` = `Y`.
6. **Atomize and date** (below).
7. **Update coverage**: per window `passes` + 1, `new_last_pass`, `last_checked` = today, state by the rules above, memo = what was enumerated.
8. **Validate and publish**: `python3 <scripts>/validate.py <folder>` (0 errors), `python3 <scripts>/make_agent_files.py <folder>`, then publish the changed files to the ledger's location (see wbs-tracker).
9. **Report**, tersely, in the user's language: windows advanced, new rows (code and one line each), coverage per year (`complete` ÷ windows that are not `unavailable`), what is next. A scheduled daily or backfill run reports only what needs the user (questions, conflicts, failures); what was added is shown in the weekly review, not after each run. Stop when the budget is used or no window is open.

## Range-row atomization pass

Run it at the end of every run that merged rows, and as a full pass after a bootstrap or an import from an older ledger.
1. `python3 <scripts>/validate.py <folder> --atomize` lists the candidates: leaf rows whose dates span several days while the text lists several outcomes, rows with dates written inside the text, leaf rows longer than 31 days without dated steps, and rows with no or month-only dates.
2. For each, re-read the sources behind its evidence.
3. Split: items of one continuous piece of work become level-4 steps under the row (it becomes the parent and keeps its code, title and overall range), each with its own exact date and evidence; unrelated items become their own task rows. Move dated notes out of the task text into steps.
4. Replace month-only dates with the exact day from the source. A date you cannot find stays blank with `date_text` = `not recorded` (Korean `미기록`), and the row goes to `sweep_state.json` → `undated`.
5. Log a `correct` event per changed row (memo: "split into steps 1.2.3.1–1.2.3.4" or "date from the commit log").

## Undated rows

Each run, take up to 10 rows from `undated` and look for their date in every source (search by distinctive terms, check file metadata, commit dates, sent mail, calendar). Fill `start`, `end`, `start_month`, `date_text` when found (event `correct`, memo "date found: <evidence>") and drop the row from the list. Never estimate.

## Sources

- **Claude chats**: list chats with the date bounds of the window (e.g. `recent_chats` with `after`/`before`, paging with `before` until nothing is returned). The listing summaries are enough to judge most chats; open one only when they cannot tell. A keyword search costs much more and mostly re-finds covered chats, so keep it for snowballing. Project files and memory may hold dated project states that chats alone miss.
- **Claude Code**: session transcripts are local JSONL files under `~/.claude/projects/` (kept about 30 days by default); product work done there is better traced through the repositories.
- **GitHub**: list repositories with `gh repo list <owner> --limit 200`. Mine commits from all branches, because much work never reaches a merged PR: `git clone --bare --filter=blob:none <url>` into a scratch folder, then `git log --all --no-merges --since=<from> --until=<to> --format='%as|%h|%an|%s'`, keeping the user's own commits. Add merged PRs with `gh pr list --repo <owner/repo> --state merged --search "merged:<from>..<to>" --json number,title,mergedAt --limit 200`. Cluster commits into deliverables (feature, fix, release) dated by the last commit or the merge. Skip bot and batch repositories. Never check out, commit or push; delete the clones.
- **Google Drive**: per month, search the user's own files twice, by created time and by modified time, restricted to work file types (documents, spreadsheets, slides, PDF, notebooks, Markdown, archives); record file IDs. Output folders of experiments can hold thousands of files: skip caches, and keep the window `partial` until any skipped pages are read.
- **Gmail**: sent mail and confirmations per month (`in:sent after:YYYY/MM/DD before:YYYY/MM/DD`; "received", "submitted", "accepted", receipts). Record the work, never quote the mail.
- **Google Calendar**: events per month; talks, defences, interviews, deadlines. The event date is the row date.
- **Slack**: the user's own messages per month (`from:me after:… before:…`). Free workspaces keep about 90 days, so sweep at least monthly; older windows are `unavailable`.
- **Notion**: pages and database rows created or edited by the user in the window; note unreadable pages in the memo and keep the window `partial`.
- **Exports** (ChatGPT `conversations.json`, a Claude data export, other apps): enumerate by conversation ID and message time; a window is complete only up to the export date. Ask the user for a fresh export when a window needs one (memo "needs a new export").
- **Local folders**: files by modified time; Git repositories inside them by `git log`.

## Rules

- Never mark a window `complete` on a hunch: it needs 2+ passes, a finished month and 0 new items in the latest pass.
- Dedupe against the whole year, not just the window: work often appears weeks after it was planned.
- Sources are read-only: never send, edit, share or delete anything in a connected app. Do not write to the user's memory unless asked.
- Privacy: skip health and medical matters, dating and relationships, emotional counselling, account or card numbers, government IDs, secrets and other people's personal handles (use organisations or roles); leave out amounts of personal income, scholarships, prizes, transfers and property. Business costs, public prices and technical metrics are fine. Follow any `config,,privacy,…` row in plan.csv.
- On a publish conflict, read the live files again, keep rows other sessions added or changed, rebuild and publish again.

## Helper scripts

`validate.py` (add `--atomize` for the atomization list), `make_agent_files.py`, `reconcile.py`, all importing `wbs_schema.py` (Python 3, standard library only). Use the first folder that exists as `<scripts>`: `scripts/` next to this SKILL.md (`${CLAUDE_SKILL_DIR}/scripts` in Claude Code), `${CLAUDE_PLUGIN_ROOT}/scripts` (Claude Code plugin), or `scripts/` in a clone of the personal-wbs repository.
