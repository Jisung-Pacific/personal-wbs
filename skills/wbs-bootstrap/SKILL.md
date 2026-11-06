---
name: wbs-bootstrap
description: Build a personal work-breakdown ledger (wbs.csv) in stages. Start with a fast first look: collect only the last 3 months from the connected sources, agree a light taxonomy, import atomic, exactly dated rows with evidence, reconcile open tasks, and show a dashboard with three headline findings. Then ask how to continue: full power now (12 months, then all history, a lead session plus parallel Sonnet workers) or steady in the background (1-2 agents walking backwards a few windows per run). Either mode can pause, but collection always goes to the end, new work keeps being collected daily, and updates are shown weekly. Use when someone wants to start a WBS, work log or record of everything they have done, or to rebuild one.
license: MIT
---

# Bootstrap a personal WBS ledger

You build one ledger of everything the user has done, across all years, from the sources you can reach, and you leave it maintained by background runs. You build it in stages: a fast first look at the last 3 months so the user sees value within one session, then a choice of how fast to go back through the rest of the history. The ledger is **raw data first**: rows record what happened, when, and where the evidence is. Every summary, rollup, health check or topic map is computed later from those rows by the dashboard and the agent files, and never stored as a row.

Other skills in this package: `wbs-tracker` logs new work after each task and runs the weekly health check; `wbs-sweep` resumes the exhaustive sweep and runs the daily collection. Follow their rules once the ledger exists.

## What you produce

| File | Purpose |
|---|---|
| `wbs.csv` | the ledger, every year in one file, UTF-8 with BOM, 22 columns (source of truth) |
| `plan.csv` | goal list, focus packages, health-check dates, settings |
| `coverage.csv` | one row per year × month × source window: how completely it was swept |
| `events.csv` | append-only log of creations, status changes, corrections, moves |
| `sweep_state.json` | resumable sweep state: item IDs already judged, keyword queue (keep it private) |
| `summary.json`, `llms.txt` | generated files that let any agent answer questions about the ledger |
| `index.html` | the dashboard (`index.ko.html`, `index.zh-CN.html` for Korean and Chinese), computed in the browser from the CSV files |

## Ledger rules (read before writing any row)

**Atomic rows.** The ledger is never a summary.
- One row = one concrete deliverable, decision or event, with its own exact date (`YYYY-MM-DD`) taken from the source timestamp: message time, commit date, file created or modified time, e-mail sent time, event date.
- Never merge several items into a range row such as "10-10 ~ 10-13: did A, B, C". A date range is allowed only for one genuinely continuous piece of work (writing one chapter, one experiment run); its separately dated steps become level-4 child rows.
- Every row carries evidence pointers (`source:id`) so it can be re-verified.
- Unknown dates stay blank (`date_text` = `not recorded`) and are flagged for the sweep. Never guess a date, a deadline or an outcome, and never collapse dates to a month to look tidy. Mark unverified outcomes ("result unconfirmed").
- A later outcome of the same task (the score arrives, the paper is accepted) is a new dated row or step, not text appended to the old row.

**Language.** The ledger is kept in one language. English is the default for new users; Korean is fully supported. The header row tells every tool which one is used; write values and task text in that language. Chinese-speaking users keep English headers and may write task text in Chinese.

| File | English header (default) | Korean header |
|---|---|---|
| wbs.csv | `year,code,level,area,package,parent,task,start,end,date_text,start_month,status,key_result,source,due,importance,size,depends_on,blocker,last_progress,goal,evidence` | `연도,WBS,레벨,대분류,중분류,상위 작업,작업·산출물,시작일,종료일,일자(원문),시작월,상태,핵심성과,출처,마감일,중요도,크기,선행,막힘 사유,최근 진행일,목표,근거` |
| coverage.csv | `year,month,source,state,passes,new_last_pass,last_checked,memo` | `연도,월,소스,상태,패스 수,최근 신규,마지막 확인,메모` |
| plan.csv | `kind,year,target,note,decided,recheck` | `종류,연도,대상,내용,결정일,재검일` |
| events.csv | `date,year,code,event,from_status,to_status,memo,source,estimated` | `일자,연도,WBS,이벤트,이전 상태,새 상태,메모,출처,추정` |

| Values | English | Korean |
|---|---|---|
| status | `done`, `in_progress`, `waiting` (on someone else), `backlog` (parked on purpose) | `완료`, `진행 중`, `대기·심사`, `백로그` |
| importance (blank = medium) | `high`, `medium`, `low` | `상`, `중`, `하` |
| size (estimate when created) | `S` ≤ 1 day, `M` ≤ 1 week, `L` ≤ 1 month, `XL` > 1 month | same |
| blocker category | `external review`, `external reply`, `external dependency`, `prerequisite`, `scheduled later`, `on hold`, `result unconfirmed` | `외부 심사·승인`, `외부 응답`, `외부 의존·차단`, `선행 조건`, `일정·연기`, `보류`, `결과 미확인` |
| date words | `planned`, `not recorded`; continuation marker `(continued)` | `예정`, `미기록`; `(계속)` |
| events.event | `create`, `status`, `enrich`, `correct`, `move` | `생성`, `상태`, `보강`, `정정`, `이동` |
| coverage.state | `not_started`, `partial`, `complete`, `unavailable` | `미착수`, `부분`, `완료`, `불가` |
| plan.kind | `goal`, `focus`, `checkup`, `config` | `목표`, `집중`, `검진`, `설정` |

**Columns of wbs.csv** (English name / Korean name: how to fill; blank when the evidence does not say).
- `year`/`연도`: the year tree of the row = year of `start`. Row key is (year, code).
- `code`/`WBS`: `area.package.task` (`1.2.3`) or `area.package.task.step` (`1.2.3.4`). `level`/`레벨`: 3 or 4, matching the depth.
- `area`/`대분류`: `<n> <name>` from the agreed list. `package`/`중분류`: `<n.m> <name>`. `parent`/`상위 작업`: level 4 only, `<parent code> <parent title>`.
- `task`/`작업·산출물`: what was produced, decided or happened, concrete, with numbers.
- `start`/`시작일`, `end`/`종료일`: exact days from the sources; `end` blank while open. `start_month`/`시작월` = first 7 characters of `start`.
- `date_text`/`일자(원문)`: the human form: `2026-06-22`, `2026-06-22 ~ 07-12`, `2025-12-28 ~ 2026-01-03`, `2026-10-02 ~` (open), `planned`, `not recorded`.
- `status`/`상태`: from the table above. `key_result`/`핵심성과`: `Y` for headline results only (paper accepted, degree, launch, award, registration); never on level 4.
- `source`/`출처`: who wrote the row (`Claude`, `GPT`, `Claude·GPT`, or your agent's name).
- `due`/`마감일`: a real deadline or a date the user committed to. `importance`/`중요도`, `size`/`크기`: from the table.
- `depends_on`/`선행`: prerequisite codes separated by `;` (`2025:1.2.3` for another year).
- `blocker`/`막힘 사유`: `<category>: <what or who>`, naming an organisation or a role ("admissions office", "advisor"), never a personal handle.
- `last_progress`/`최근 진행일`: the last day anything happened on the row.
- `goal`/`목표`: one goal name from plan.csv. `evidence`/`근거`: pointers separated by `;`: `claude:<chat id8>`, `cc:<Claude Code session id8>`, `gpt:<conversation id8>`, `gh:<owner/repo>#<PR>` or `gh:<owner/repo>@<sha7>`, `drive:<file title>`, `gmail:<message id>`, `cal:<event date>`, `slack:<channel>/<ts>`, `notion:<page id8>`, `file:<path>`.

**Codes.** Each year has its own tree and reuses the same area list. Codes are permanent once written: a new task takes max+1 in its package, a new step max+1 under its parent, a deleted code is retired (gaps are normal), a misfiled row is corrected in text, never renumbered. A task that continues into a new year stays in its start year; new work in the new year gets a new row there starting with `(continued)`. Counts use leaf rows (rows without steps). Keep rows sorted newest year first, then by code numerically.

## Procedure

The onboarding has four stages. Early impact comes first; completeness comes next and does not stop until every window is `complete` or `unavailable`.

| Stage | What happens | Steps |
|---|---|---|
| 1. First look | Collect and refine only the last 90 days, then show the result. Target: one session, so the user sees value before being asked for more. | 0 to 10 |
| 2. Ask | Right after the result, ask how to continue. | 11 |
| 3. Expand | Last 12 months, then older years, newest first, until the whole history is covered. | 12 |
| 4. Keep going | New work is collected in the background; the user is shown updates once a week. | 13, 14 |

Steps 4 to 9 are the same in every stage: whatever a stage writes passes through dedupe, atomization, events, validation and publishing. Write files after every window so any run can stop and resume.

## Stage 1. First look (last 90 days)

Set `cutoff` = today minus 90 days. Every step below applies only to items dated on or after `cutoff`. Do not ask for the full history yet.

### Step 0. Permissions checklist (trimmed to the 3-month pass)

Tell the user why: **a source that is not connected is missing from every count, chart and health check, and some sources forget** (free Slack keeps about 90 days, local transcripts are pruned). For the first look, ask only for what the last 90 days need: the first four items below, in one message, then wait. The ChatGPT export and the extra repositories can come later; ask for them in Step 11. The Slack and Claude Code items matter most to ask early, because their history expires.

- [ ] Past chats: chat search and memory turned on in the app's settings; for Claude Code, the local session transcripts (`~/.claude/projects/`, one JSONL per session, kept about 30 days by default unless `cleanupPeriodDays` is raised). Users without chat search can upload a data export (Claude: Settings → Privacy → Export data).
- [ ] Connectors the user has: Google Drive, Gmail, Google Calendar, Slack, Notion, GitHub (or `gh auth status` for the CLI), plus any other work tool.
- [ ] Where the ledger will live: a claude.ai artifact, a local folder, or a private Git repository (needed for cloud-scheduled runs). Write it into a config note the agent always sees (CLAUDE.md, project instructions or memory): `WBS ledger: <artifact URL | folder path | owner/repo>`.
- [ ] Tool permissions, granted once so later background runs never stall on a prompt. In Claude Code add allow rules to `~/.claude/settings.json`, for example `"permissions": {"allow": ["Bash(python3 *)", "Bash(gh api *)", "Bash(gh repo list *)", "Bash(git clone *)", "Bash(git log *)", "mcp__<server>__search_*", "mcp__<server>__read_*"]}` (server names from `/mcp`; narrow the rules if you prefer). In claude.ai, set the connectors' read tools to always allowed and turn on code execution.

Ask in Step 11, not now (they only matter for older windows, and the export takes time, so the user may request it while reading the first result):
- [ ] A ChatGPT data export if they used ChatGPT (Settings → Data controls → Export data; the link arrives by e-mail).
- [ ] Local folders and repositories to include, and the accounts or organisations to cover on GitHub (the 90-day pass uses the repositories the user names or that `gh repo list` shows with recent pushes).

Record every source that stays unavailable in coverage.csv as `unavailable` with the reason, and tell the user what the ledger will miss.

### Step 1. Set up and take inventory

1. Language: English unless the user prefers Korean. Create the four CSV files with the header lines above (UTF-8 with BOM: write with `encoding='utf-8-sig'`).
2. Period: the first look covers `cutoff` to today. Note the earliest date each source reaches (it sizes Stage 3) but do not enumerate older items yet.
3. For each reachable source, list (do not open) what exists since `cutoff`: count of items per month, plus the earliest date overall. Show the inventory as a short table: source, earliest month, items in the last 90 days, how you will enumerate it.

### Step 2. First skim and taxonomy (light sign-off gate)

1. Skim titles only: for the last 90 days, plus a cheap look at older chat titles, repository names and Drive folders so the areas fit the whole history. Listing calls only; no opening.
2. Propose:
   - **4 to 7 areas**, stable across years: e.g. `1 Research`, `2 Graduate School`, `3 Startup`, `4 Career`, `5 Admin`. Areas are life domains, not projects.
   - **Packages for the current year, only for what the last 90 days show**, each a project, a deliverable stream or a recurring duty, holding roughly 3 to 40 tasks (expect fewer in the first look): e.g. `1.2 Workshop paper`, `3.1 App v1 launch`, `4.1 Teaching assistant`. Split anything bigger, merge anything smaller into a neighbour. Tell the user that older years may add packages later; that is normal and does not change any code already written.
   - **3 to 6 goals** for plan.csv (`goal` rows): outcomes the user cares about, e.g. "Finish the MSc", "PhD admission for 2027". Tasks link to at most one.
3. Show the proposal as a compact tree with estimated task counts per package, plus the goal list. **Wait for explicit sign-off**, but keep it light: the areas are what must be right now, because codes are permanent once rows are written; packages can grow. Iterate until the areas are agreed.

### Step 3. Coverage windows and the import (last 90 days)

1. Write coverage.csv: one row per year × month × source for the months from `cutoff` to today, state `not_started` (`unavailable` for sources you cannot reach, memo = why). The month that contains `cutoff` is enumerated only from `cutoff`: its memo says "from <cutoff date>" and it stays `partial` until Stage 3 has covered the rest of that month. Older months are added in Stage 3.
2. Fill windows **oldest first**, so codes come out roughly chronological. For each window, **enumerate every item by ID** with date-bounded listings, paging to the end. Never sample and never stop at "enough".
3. Judge every item with a work lens and record a verdict in `sweep_state.json`: `<year> <code>` (already covered), `new:<code>` (row added), `detail:<code>` (adds evidence to an existing row), `skip:<reason>` (no work: chit-chat, personal, trivial Q&A that serves no task). A chat that serves a task (reading a paper for it, comparing tools before a purchase, formatting a document) is `detail:`, not `skip:`.
4. Date each row from the item that carries the result: the message or commit or file version where the deliverable appears, not the conversation start.
5. Update the window: `passes` + 1, `new_last_pass`, `last_checked`, memo ("41 chats listed by ID, 2 new"). A window is `complete` only when the month is over, it has at least 2 passes, and the latest pass found 0 new items; otherwise `partial`.
6. Snowball: for every new item take 2 to 5 distinctive terms (project, tool, file or organisation names) and search the other sources and months for them; queue windows that turn up hits.

`sweep_state.json` shape:
```json
{"updated": "YYYY-MM-DD", "language": "en",
 "sources": {"claude": {"reviewed": {"<id8>": ["<verdict>", "<reviewed on>"]}},
             "chatgpt": {"export_date": "YYYY-MM-DD", "reviewed": {}},
             "github": {"<owner/repo>": {"commits_through": "YYYY-MM-DD", "prs_through": "YYYY-MM-DD"}},
             "drive": {"files_reviewed": []}, "gmail": {"through": ""}, "calendar": {"through": ""},
             "slack": {"through": ""}, "notion": {"pages_reviewed": []}, "local": {}},
 "keywords": {"queue": {}, "searched": {}},
 "undated": [], "log": [{"date": "YYYY-MM-DD", "windows": ["2026-03 GitHub"], "new": 0}]}
```

### Step 4. Dedupe across the whole year

The same item seen in several sources (the chat that drafted a document, the file, the e-mail that sent it) is **one row with several evidence pointers**. Different deliverables of the same project are **not** duplicates: they are separate rows or steps. Dedupe against the whole year, not just the window, because work often surfaces weeks after it was planned.

### Step 5. Write rows

Edit with a short Python script and the `csv` module (`encoding='utf-8-sig'` for reading and writing); never retype the file by hand. Fill all 22 columns the evidence supports and leave the rest blank. Use `status` = `in_progress` when you cannot tell whether open work finished; Step 8 settles it with the user. `waiting` always has a blocker. Keep the sort order. Run `python3 <scripts>/validate.py <folder>` after each batch of writes and fix every error.

### Step 6. Range-row atomization pass

Run `python3 <scripts>/validate.py <folder> --atomize`. It lists rows whose dates span several days while the text lists several outcomes, rows with dates written inside the text, leaf rows longer than 31 days without steps, and rows with no or month-only dates. For each candidate:
1. Re-read the sources behind its evidence.
2. Split it: if the items belong to one continuous piece of work, the row becomes a parent (it keeps its code, title and overall range) and each separately dated item becomes a level-4 step with its own exact date and evidence; if they are unrelated, give them their own task rows.
3. Replace month-only dates with the exact day; leave truly unknown dates blank with `not recorded` and add the row to `sweep_state.json` → `undated`.
4. Log a `correct` event per changed row (memo: "split into steps 1.2.3.1–1.2.3.4").

### Step 7. Reconstruct events.csv

For every row: a `create` event on its start date (to its first status), a `status` event when it finished (`end`), went waiting or was parked, when the evidence shows it. Mark all of them `estimated` = `Y`, because they were rebuilt after the fact. Rows without dates get one `create` event dated today with the memo "logged without a date". From now on events are appended live and are not estimated.

### Step 8. Reconcile current status with the user

Imported records lag reality: work finished outside the sources, or never written down, still looks open. This is the most common first-run error, so ask before you show results. In the first look this is a quick pass: only the open tasks the 90 days produced, in batches of up to 10, with likely answers pre-filled; older open tasks are reconciled when their windows are imported.

1. Run `python3 <scripts>/reconcile.py list <folder>`. It lists every open leaf task (in progress, waiting, undated) in batches of up to 10, grouped by package, undated and oldest first, with hints the ledger itself gives (a dependent task has started, a later row looks like the result, long silence).
2. Before asking, **pre-fill likely answers from evidence**: a later row that mentions the result, a merged PR, a sent e-mail or a submitted file. Mark them "(likely done: <evidence>)" in the option text, so the user mostly confirms.
3. Per batch ask two multiple-choice questions, multi-select: **"Which of these are already done?"**, then **"Which are blocked or parked?"** (for each picked one, a short follow-up: blocked on whom or what, or parked until when). Use the app's multiple-choice question tool when there is one; if it caps the number of options, split the batch over several questions; otherwise show a numbered list and ask for numbers. Invite exact finish dates ("done 2026-10-20") but do not insist.
4. Write the answers to `answers.json` (`[{"year": "2026", "code": "1.2.3", "status": "done", "end": "2026-10-20"}, {"year": "2026", "code": "2.1.3", "status": "waiting", "blocker": "external reply: admissions office"}]`) and run `python3 <scripts>/reconcile.py apply <folder> answers.json`. It sets the status, the end date (today unless the user gave one), the blocker, closes parents whose steps are all done, and appends events with the memo "onboarding reconciliation" (Korean ledgers: "온보딩 상태 확인").
5. The dashboard also has a **Status check** mode that walks through open tasks one by one with Done / In progress / Blocked / Backlog / Skip buttons. If the user prefers it, apply the answers it produces the same way.

### Step 9. Generate agent files and the dashboard

1. `python3 <scripts>/validate.py <folder>`: 0 errors before you go on; fix warnings that are real problems.
2. `python3 <scripts>/make_agent_files.py <folder>` writes `summary.json` and `llms.txt` in the ledger's language.
3. Put the dashboard page next to the data: `index.html` (English), `index.ko.html` or `index.zh-CN.html` from this package's `templates/dashboard/`. It reads `wbs.csv`, `coverage.csv`, `plan.csv`, `events.csv` and any `digest_<year>.csv` from the same folder.
4. Publish to the location from Step 0: republish the artifact with the files, or write the folder (commit to the repository only if the user asked). Leave `sweep_state.json` out of anything shared, because it lists item IDs.
5. Add a `checkup` row to plan.csv with `recheck` = a week from today, and `focus` rows for the 2 or 3 packages the user wants to push now.


### Step 10. Show the result

Early impact is the point: show it right after Step 9, before asking for anything more.
1. Publish the dashboard and open it for the user.
2. Show the analysis and the visualizations the dashboard computes from the rows: rows per area and per month, status mix, key results, what is open, late or blocked, and the focus packages.
3. Say **three short headline findings**, each one sentence with a number taken from the rows (for example where the time went, what is stuck, what finished that the user may have forgotten). Do not invent a finding the rows do not support.
4. State plainly what this is: the last 90 days only, with the older history still to come.

## Stage 2. Ask how to continue

### Step 11. Offer the options

Ask right after Step 10, with the app's multiple-choice question tool when there is one. Also ask now for the items deferred from Step 0 (ChatGPT export, extra repositories and organisations, local folders).

| Option | What happens | Cost, in relative terms |
|---|---|---|
| **a. Full power now** | Collect the last 12 months, then all older history, in this and following sessions, with the maximum resources: you are the lead and plan, merge, number and validate; 2 or 3 worker subagents enumerate windows in parallel. | Fastest to a complete ledger; the most tokens and the most attention in the next hours. |
| **b. Steady in the background** | 1 or 2 background agents (scheduled runs or sessions) each take a few windows per run, walking backwards month by month, 12 months first and then older years, refining a little each time. | Slowest to finish (days to weeks); small cost per run, and nothing to watch. |

Also ask which **worker model** to use (cost versus thoroughness). Default: Sonnet workers with the session's own model as lead. A stronger worker model is more thorough and costs more; a cheaper one is faster and may leave more `partial` windows for a second pass. Do not quote prices or durations you cannot know; give the relative comparison above.

There is no third option of stopping at 3 months. Whatever the user picks, two things hold: **the collection goes to the end** (the user can pause either mode and resume it later, but no window is silently dropped; every window ends `complete` or `unavailable`), and **new work keeps being collected in the background**. Record the choice as `config` rows in plan.csv (`config,,expansion,<a|b>`, `config,,worker-model,<model>`).

## Stage 3. Expand to the whole history

### Step 12. Walk backwards

**Order.** Last 12 months first (the month containing `cutoff` is finished first), then older years, newest year first and newest month first inside each year. Add the new windows to coverage.csv as `not_started` a year at a time. Within a window the Step 3 rules apply unchanged: enumerate every item by ID, judge, dedupe, atomize, validate.

**Progress is coverage.csv.** The next window is always the first `not_started` or `partial` row in that order; a window closes by the `complete` rules in `wbs-sweep`. Report progress as `complete` windows ÷ windows that are not `unavailable`, per year. A year is finished when no window is open. Stop when none is.

**Codes stay permanent.** Never renumber rows already written. Older windows add rows under the year they belong to. Items that fit an existing package take the next free number there. Work in an older year that fits no package gets a new package in that year's tree, taking that year's next free package number (the areas are fixed). A year with no tree yet starts at `1` in each area. Show new packages to the user in one line each in the next weekly summary; ask only when an item truly fits no area. Do a Step 8 reconciliation for each older year when its windows are mostly done.

**Mode a, full power.** You are the lead. The package is designed around an Opus-class lead: you plan the windows, merge, number and validate.
1. Pick the next batch of windows (about 6 per worker per round) and give each of 2 or 3 workers its windows.
2. Each worker is a subagent on the chosen worker model (Claude Code: the Agent tool with `model: sonnet`; the `wbs-collector` agent already does this). Give it the agreed areas and packages, the current code list of the year (for dedupe), its windows, the row format and the rules in "Budget and subagents". It enumerates read-only and returns candidate rows plus a verdict per item.
3. You check the returned verdicts against the rules (exact dates, evidence, atomic rows), reject or fix weak rows, assign codes, write, run Steps 4 to 9, update coverage and `sweep_state.json`, and republish.
4. Repeat until no window is open or the user pauses. After each round, give one line: windows done, rows added, coverage so far.

**Mode b, steady in the background.** Create the expansion run from `wbs-schedule` (section 2, "Backfill expansion") for 1 or 2 agents, only when the user chose it and asked for the schedule. Each run takes a few windows, advances them and stays silent. If no scheduler is available, say so and offer to continue in-session in small rounds.

**Switching.** The user may change mode or pause at any time; coverage.csv shows where to resume. When the last window closes, run a full atomization pass and a final Step 8 reconciliation, then tell the user the ledger is complete.

## Stage 4. Keep going

### Step 13. Schedule the background runs

New work is collected from now on, whatever the user chose in Step 11. So the user never has to ask for things to be added, set up the recurring runs (pick minutes off :00 and :30). The `wbs-schedule` skill has the ready prompts and the steps for each app; create a schedule only when the user explicitly asks:
- **Daily collection**, e.g. 21:17 local: "Use the wbs-sweep skill in catch-up mode: enumerate the last 48 hours of every source, log new work atomically with the wbs-tracker rules, validate, regenerate the agent files, publish. Report only what needs my answer."
- **Weekly review**, e.g. Monday 08:43: "Use the wbs-tracker skill to run the weekly health check, update plan.csv, publish, and send me the summary."

The cadence of showing is deliberate: the daily run is silent unless something needs the user's answer, and **the weekly review is when the user is shown what was added** (new rows, windows closed, new packages, coverage). Do not report after every run. If the user chose mode b in Step 11, add the backfill expansion run from `wbs-schedule` as a third schedule.

Where to schedule: Claude Code cloud scheduled tasks (`/schedule` in the CLI or claude.ai/code/routines; they run without your machine, from a fresh clone, so the ledger must be in a repository or artifact the run can reach, and only the connectors the task needs should be attached); Claude Desktop scheduled tasks for local folders; otherwise cron or launchd running `claude -p "<prompt>" --allowedTools "<the rules from Step 0>"`; or whatever scheduled-task feature the user's app offers. If nothing can be scheduled, say so and suggest a recurring reminder instead.

### Step 14. Report

At the end of each onboarding session, tell the user, briefly: rows written per year (leaves, key results), coverage per year (`complete` ÷ windows that are not `unavailable`), windows still open and why, rows waiting for dates, what reconciliation changed, the schedules created, and the next step (the expansion mode chosen in Step 11, and that the next update will be shown in the weekly review).

## Source notes

- **Claude chats**: the listing (title, created and updated time, summary) is enough to judge most chats; open a chat only when the listing cannot tell. Enumerate by ID with date bounds and page to the end; keyword search costs more and mostly re-finds known chats, so use it only for snowballing. A chat updated after you judged it was continued: judge it again. Project knowledge and memory files can hold dated project states that chats alone miss.
- **Claude Code**: product work often happens in Claude Code sessions, so the repository, not the chat list, carries it. Session transcripts are local JSONL files with timestamps.
- **GitHub**: work hides in unmerged branches, so mine commits with `--all`, not just merged PRs: `git clone --bare --filter=blob:none <url>` into a scratch folder, then `git log --all --no-merges --since=<from> --until=<to> --format='%as|%h|%s'` (author date). One PR can bundle hundreds of commits: cluster commits into deliverables (one row per feature, fix or release, dated by its last commit or merge) with `gh:` pointers. List repositories with `gh repo list <owner> --limit 200`. Skip bot and batch repositories. Never check out, commit or push; delete the clones afterwards.
- **Google Drive**: enumerate each month twice, by created time and by modified time (each pass finds files the other misses); restrict to the user's own work files (documents, spreadsheets, slides, PDF, notebooks, Markdown, archives) because caches and package files run into thousands.
- **Gmail**: sent mail and confirmations ("received", "submitted", "accepted", receipts) mark submissions, applications and decisions. Record the work, never quote private messages.
- **Google Calendar**: talks, defences, interviews, deadlines; the event date is the row date.
- **Slack**: search the user's own messages per month. Free workspaces show only about the last 90 days: older windows are `unavailable`, and the sweep must run at least monthly.
- **Notion**: pages and database rows created or edited by the user in the window; page history can be short, and some content may not be readable through the connector (note it in the memo).
- **Exports the user uploads** (ChatGPT, Claude, other apps): ask for them in Step 0; they may arrive later. A window based on an export is complete only up to the export date.
- **Local folders**: files by modified time; any Git repository inside them by `git log`.

## ChatGPT data export

The export is a zip with `conversations.json`: a list of conversations, each with `title`, `create_time` and `update_time` (Unix seconds), an id (`conversation_id` or `id`), `current_node`, and `mapping`: message nodes keyed by id, each `{"message": {"author": {"role"}, "content": {"content_type", "parts": [...]}, "create_time"}, "parent", "children"}`. The visible thread is the path from `current_node` back to the root. Build a digest with Python and judge from it, opening a conversation only when needed:

```python
# one line per conversation: id8, date, title, turns, first user message (save as chatgpt_digest.csv)
import csv, json, datetime as dt, sys
convs = json.load(open(sys.argv[1], encoding='utf-8'))
def text(m):
    parts = (m.get('content') or {}).get('parts') or []
    return ' '.join(p for p in parts if isinstance(p, str)).strip()
rows = []
for c in convs:
    mapping, node, thread = c.get('mapping') or {}, c.get('current_node'), []
    while node:                                    # walk the visible branch back to the root
        n = mapping.get(node) or {}
        m = n.get('message')
        if m and (m.get('author') or {}).get('role') in ('user', 'assistant') and text(m):
            thread.append(m)
        node = n.get('parent')
    thread.reverse()
    first = next((text(m) for m in thread if m['author']['role'] == 'user'), '')
    cid = c.get('conversation_id') or c.get('id') or ''
    day = dt.datetime.fromtimestamp(c.get('create_time') or 0).date().isoformat()   # local time zone
    rows.append([cid[:8], day, c.get('title') or '', len(thread), first[:200].replace('\n', ' ')])
rows.sort(key=lambda r: r[1])
with open('chatgpt_digest.csv', 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.writer(f); w.writerow(['id8', 'date', 'title', 'turns', 'first_user_message']); w.writerows(rows)
```
Date rows by the `create_time` of the message that produced the result, converted to the user's time zone, not by the conversation start. Evidence: `gpt:<id8>`. Very large exports may hold several conversation files: process each.

## Budget and subagents

**Lead and workers.** Planning and writing need judgment; enumerating read-only sources does not. So the work is split by model:

| Role | Model | Does | Never does |
|---|---|---|---|
| **Lead** | the session's own model; the package is designed around an Opus 5.5-class model | plans windows, decides the taxonomy and codes, checks worker verdicts, merges, numbers, writes files, validates, publishes, talks to the user | |
| **Workers** | Sonnet by default; the user may pick a cheaper or stronger model in Step 11 (in Claude Code: the Agent tool with `model: sonnet`, or the `wbs-collector` agent) | enumerate their windows by ID, judge items, return candidate rows and verdicts | edit any file, write the ledger, assign codes, change anything in a connected app |

Workers are safe on a cheaper model because the sources are read-only and only the lead writes: a weak candidate row is rejected or fixed in the merge, and a missed item is caught by the second pass that `complete` requires.

- Run at most 2 or 3 workers in parallel. Give each the agreed areas and packages, the current code list of the year (for deduping), its windows, the row format and these rules; they return candidate rows and verdicts, not edits. One writer (you) merges, numbers and validates.
- One round handles about 6 windows per worker (one source × one month each) or one busy month of chats; checkpoint after every window. The `wbs-sweep` skill resumes where you stopped.
- Prefer listings and metadata over opening items: titles and dates judge most items.
- Stage 1 (the first look) usually needs no workers: 3 months is small enough for the lead alone. Use workers when it is clearly large.
- Without a subagent tool (for example a chat app), the lead does the windows itself in smaller rounds; mode a then means working through more windows per session.

## Privacy defaults

The user can change these; store their changes as a `config` row in plan.csv (`config,,privacy,<what to include or skip>`).
- Skip: health and medical matters, dating and relationships, emotional counselling, financial account or card numbers, government ID numbers, passwords and secrets, other people's personal handles or contact details (name organisations or roles instead).
- Leave out amounts of personal income, salary, scholarships, prizes, personal transfers and property; keep business costs, public prices and technical metrics.
- Record the work, never quote private messages. Sources are read-only: never send, edit, share or delete anything in a connected app.

## Helper scripts

Python 3, standard library only: `validate.py`, `make_agent_files.py`, `reconcile.py`, all importing `wbs_schema.py`. Use the first folder that exists as `<scripts>`: `scripts/` next to this SKILL.md (zips built by `package_skills.py`; `${CLAUDE_SKILL_DIR}/scripts` in Claude Code), `${CLAUDE_PLUGIN_ROOT}/scripts` (installed as a Claude Code plugin), or `scripts/` in a clone of the personal-wbs repository. Each takes the ledger folder; `--help` explains the options.
