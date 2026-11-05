---
name: wbs-tracker
description: Keep the user's personal WBS ledger (wbs.csv) current. After any task that produced a concrete result (a document, code, a decision, a submission, an application, an admin action), silently log it as an atomic, dated row with evidence. Also answers "how am I doing", "what is open, blocked or overdue", "what did I finish this week", and runs the weekly health check. Use after finishing work in any chat or project, or when asked to show, filter or summarize the WBS.
license: MIT
---

# Track work in the personal WBS ledger

The user keeps one ledger of everything they do, all years in one file, maintained by agents. Whenever a task produces a concrete result, record it before you end the turn, **silently**: do not mention the update in the reply unless the user asked for confirmations (a preference they may set in the config note). Mention the ledger only when they ask about it.

## Where it lives

- The location is in a config note you can always see (CLAUDE.md, project instructions or memory): `WBS ledger: <artifact URL | folder path | owner/repo>`. plan.csv may repeat it as a `config` row with target `publish`.
- Files: `wbs.csv` (the ledger, source of truth), `plan.csv` (goals, focus packages, health-check dates, settings), `events.csv` (append-only log), `coverage.csv` and `sweep_state.json` (owned by the `wbs-sweep` skill), `summary.json` and `llms.txt` (generated), `index.html` (dashboard; `index.ko.html`, `index.zh-CN.html`).
- No ledger yet: offer the `wbs-bootstrap` skill. Location unreachable in this session: skip silently; the daily sweep will find the work.

## The ledger is raw data

- One row = one concrete deliverable, decision or event, with its own exact date (`YYYY-MM-DD`) from the source: the time of the message, commit, file or e-mail where the result appeared. Today's work gets today's date.
- Never merge several items into one range row ("10-10 ~ 10-13: did A, B, C"). A range is for one genuinely continuous piece of work; its separately dated steps are level-4 rows.
- Work that extends an existing task becomes a **new step under it** (the task turns into a parent and keeps its code) or a new task row. Never append dated outcomes to an existing row's text. Edits to an existing row are limited to status, dates, blocker, due date, importance, last progress, evidence and corrections.
- Every row carries at least one evidence pointer. Unknown dates stay blank (`not recorded`); never guess dates, deadlines or outcomes. Mark unverified outcomes ("result unconfirmed").
- Summaries, rollups, health checks and topics are computed views. They never become rows.

## Schema v6

The ledger is kept in English (default) or Korean; the header row says which. Keep writing in that language.

| File | English header | Korean header |
|---|---|---|
| wbs.csv | `year,code,level,area,package,parent,task,start,end,date_text,start_month,status,key_result,source,due,importance,size,depends_on,blocker,last_progress,goal,evidence` | `연도,WBS,레벨,대분류,중분류,상위 작업,작업·산출물,시작일,종료일,일자(원문),시작월,상태,핵심성과,출처,마감일,중요도,크기,선행,막힘 사유,최근 진행일,목표,근거` |
| events.csv | `date,year,code,event,from_status,to_status,memo,source,estimated` | `일자,연도,WBS,이벤트,이전 상태,새 상태,메모,출처,추정` |
| plan.csv | `kind,year,target,note,decided,recheck` | `종류,연도,대상,내용,결정일,재검일` |

| Values | English | Korean |
|---|---|---|
| status | `done`, `in_progress`, `waiting` (on someone else), `backlog` (parked on purpose) | `완료`, `진행 중`, `대기·심사`, `백로그` |
| importance (blank = medium) | `high`, `medium`, `low` | `상`, `중`, `하` |
| size | `S` ≤ 1 day, `M` ≤ 1 week, `L` ≤ 1 month, `XL` > 1 month | same |
| blocker category | `external review`, `external reply`, `external dependency`, `prerequisite`, `scheduled later`, `on hold`, `result unconfirmed` | `외부 심사·승인`, `외부 응답`, `외부 의존·차단`, `선행 조건`, `일정·연기`, `보류`, `결과 미확인` |
| date words, continuation | `planned`, `not recorded`, `(continued)` | `예정`, `미기록`, `(계속)` |
| event | `create`, `status`, `enrich`, `correct`, `move` | `생성`, `상태`, `보강`, `정정`, `이동` |
| plan kind | `goal`, `focus`, `checkup`, `config` | `목표`, `집중`, `검진`, `설정` |

Columns: `year` = year of `start` (row key is year + code); `code` `area.package.task(.step)`; `level` 3 or 4; `area` `<n> <name>`; `package` `<n.m> <name>`; `parent` (level 4 only) `<code> <title>`; `task` what was produced, decided or happened, with numbers; `start`, `end` exact days (`end` blank while open); `date_text` the human form (`2026-06-22 ~ 07-12`, `2026-10-02 ~`); `start_month` = `start[:7]`; `key_result` `Y` for headline results only, never on level 4; `source` who wrote the row (`Claude`, `GPT`, `Claude·GPT`); `due`, `importance`, `size`, `depends_on` (`;`-separated, `2025:1.2.3` for another year), `blocker` (`<category>: <organisation or role>`, never a personal handle), `last_progress`, `goal`, `evidence` (`claude:<chat id8>`, `cc:<session id8>`, `gpt:<id8>`, `gh:<owner/repo>#<PR>` or `@<sha7>`, `drive:<file title>`, `gmail:<message id>`, `cal:<date>`, `slack:<channel>/<ts>`, `notion:<page id8>`, `file:<path>`).

## Filling the columns during normal work

Ask nothing extra. Take every value from what the user said or what the work shows; leave it blank otherwise.
- `due`: a deadline or date the user mentioned ("submit by Friday" → that Friday's date).
- `importance`: `high` when the user calls it critical or it gates other work; `low` for routine chores; otherwise blank.
- `size`: estimate it when you create the task, from the work in front of you; do not change it later (it records the estimate).
- `depends_on`: tasks the user named as prerequisites ("after the defence").
- `blocker` (with `status` = `waiting`): who or what it waits on, as an organisation or role ("external review: program committee").
- `last_progress`: set it to the work date whenever you touch a task or one of its steps (and on the parent).
- `goal`: the goal from plan.csv the work serves; blank if none fits.
- `evidence`: this session's pointer (`claude:` + the first 8 characters of the chat id, `cc:` for a Claude Code session) plus any PR, commit, file or e-mail the work produced.
- `source`: your name (`Claude`). Editing a row written by another agent makes it joint (`Claude·GPT`).

## Coding rules

- Default depth 3 (`1.2.3`); use level 4 (`1.2.3.4`) for separately dated steps. A new task takes max+1 in its package, a new step max+1 under its parent; a leaf may become a parent and keeps its code.
- Codes are permanent: deleted codes are retired (gaps are normal); misfiled rows are corrected in text, never renumbered.
- Each year has its own tree with the same area list. Work that continues into a new year gets a new row in the new year's tree, starting with `(continued)`. A new package takes the next free number in its area; create one only when no existing package fits.
- Rows stay sorted newest year first, then by code numerically.

## Update procedure

1. Read the ledger (artifact files, folder or repository). Note the language from the header.
2. Dedupe: search the year's rows for the same deliverable (topic, dates, evidence). The same result seen again only adds evidence; a new result of an existing task becomes a step or a new row.
3. Edit with a short Python script (`csv` module, `encoding='utf-8-sig'` for reading and writing); never retype the file. Recompute `start_month` from `start`; update the parent's `status`, `end`, `last_progress` when steps change (a parent is done when all its steps are).
4. Append one events.csv row per change: `create` for a new row, `status` for a status change (memo: the blocker or the reason), `move` when work continues elsewhere (memo: `continued as 2027:1.2.3`), `correct` for a fix, `enrich` for filled fields. `estimated` stays blank for live events.
5. Validate: `python3 <scripts>/validate.py <folder>`; fix every error before publishing.
6. Regenerate the agent files: `python3 <scripts>/make_agent_files.py <folder>`.
7. Publish: republish the artifact with the changed files (`wbs.csv`, `events.csv`, `plan.csv`, `summary.json`, `llms.txt`), or save the folder (commit to the repository only if the user asked). Other sessions may publish too: on a conflict, read the live files again, re-apply your change on top (never drop rows someone else added or changed), and publish again.
8. Say nothing about it in the reply.

```python
# add one task row (English or Korean ledger); run from the scripts folder or put it on sys.path
import sys; sys.path.insert(0, '<scripts>')
import wbs_schema as S
t = S.read_table('wbs.csv', 'wbs'); rows, lang = t.rows, t.lang
y, pkg = '2026', '1.2'
n = max([int(r['code'].split('.')[2]) for r in rows if r['year'] == y and S.package_of(r['code']) == pkg], default=0) + 1
same = next(r for r in rows if r['year'] == y and S.package_of(r['code']) == pkg)
day = '2026-11-06'
rows.append({'year': y, 'code': f'{pkg}.{n}', 'level': '3', 'area': same['area'], 'package': same['package'],
             'parent': '', 'task': 'Camera-ready version submitted', 'start': day, 'end': day, 'date_text': day,
             'start_month': day[:7], 'status': S.label('status', 'done', lang), 'key_result': '', 'source': 'Claude',
             'due': '', 'importance': '', 'size': 'S', 'depends_on': '', 'blocker': '', 'last_progress': day,
             'goal': same['goal'], 'evidence': 'claude:1a2b3c4d'})   # goal: the one this work serves, or ''
rows.sort(key=S.ledger_sort_key)
S.write_table('wbs.csv', 'wbs', rows, lang)
```

## Answering questions about the ledger

Read `summary.json` first (regenerate it if it is older than the CSV files); `llms.txt` explains every field. Answer in the user's language, tersely, leading with what they need to act on.
- "How am I doing?": the health-check verdict (below), then this week's completions, then open items: in progress, waiting (with blockers), backlog separately.
- "What is blocked / overdue / due soon?": `open_tasks` filtered by `blocker`, `overdue`, `days_to_due`.
- "What did I finish this week / month?": `recent_completions`.
- Per year: leaf count, completion rate, key results (date and one line each), busiest packages.
- Default scope is the current year; say so, and cover other years when asked. When the user wants the dashboard, open or link it.
- "What should I do today?" or a one-minute status: use the `wbs-today` skill (top three, late or blocked, at most three decisions).

## Weekly health check

Run it when the weekly scheduled review fires, when the user asks ("health check", "how am I doing", "검진"), or when plan.csv's `checkup` date has passed and the user is planning their week.

1. Regenerate `summary.json` and read `health`: an index 0–100 (mean of 8 core indicators scored normal 1, caution 0.5, risk 0) with its value 4 weeks ago, a level, patterns (scattered, stalled, overloaded, slow flow), and per indicator its value, reference range, level and prescription. The indicators are stale share (SLE and ageing WIP), work in progress against the user's own past-year range (Little's law), arrivals ÷ completions, weekly completions (XmR), cycle time at the 85th percentile, context switching, focus share, waiting with no news for 30+ days, deadline risk and missing dates.
2. Write the summary in this shape:
   ```
   Health check · 2026-11-06 (next: 2026-11-13)
   Verdict: 62/100, caution (4 weeks ago 71, down 9) · scattered, stalled
   Out of range:
   - Stale share 33% (range ≤ 15%): 4 of 12 running tasks idle over 14 days → <codes>
   - Focus share 38% (range ≥ 50%): ...
   Prescriptions this week:
   1. <one measurable action per indicator out of range, naming the tasks>
   Strategy: <health.strategy>
   ```
   Name the actual tasks (code and title) behind each finding: stale tasks, overdue items, waiting items with no news.
3. Update plan.csv: the `checkup` row gets `decided` = today, `recheck` = today + 7, `note` = the one-line verdict. Publish.

## Content and privacy rules

- Leave out health and medical matters, dating and relationships, emotional counselling, account or card numbers, government IDs, secrets, and other people's personal handles (use organisations or roles). Leave out amounts of personal income, salary, scholarships, prizes, transfers and property; business costs, public prices and technical metrics are fine. The user can change these rules (a `config,,privacy,…` row in plan.csv).
- Record the work, never quote private messages.

## Finding work that was never logged

When the user asks to find missing work or backfill a period, or when the daily collection runs, use the `wbs-sweep` skill. It owns coverage.csv and sweep_state.json; this skill only logs finished work.

## Helper scripts

Python 3, standard library only: `validate.py`, `make_agent_files.py`, `reconcile.py`, importing `wbs_schema.py`. Use the first folder that exists as `<scripts>`: `scripts/` next to this SKILL.md (`${CLAUDE_SKILL_DIR}/scripts` in Claude Code), `${CLAUDE_PLUGIN_ROOT}/scripts` (Claude Code plugin), or `scripts/` in a clone of the personal-wbs repository. Without them, check by hand: 22 cells per row, unique (year, code), parents exist, `start_month` = `start[:7]`, `end` ≥ `start`, valid status and importance values, prerequisite codes exist.
