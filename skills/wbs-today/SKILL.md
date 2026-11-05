---
name: wbs-today
description: The one-minute view of the personal WBS ledger (wbs.csv): today's top three tasks, what is late or blocked, and at most three decisions only the user can make. Use when the user asks what to do today or next, wants a quick status or a "today" view, starts the day, or when a scheduled daily summary runs. Read-only unless the user answers a decision.
license: MIT
---

# Today: the one-minute view

After a minute of reading, the user knows the three things to do today, what is late or stuck, and the few decisions that need them. Nothing else: no report, no health check (that is the weekly review in `wbs-tracker`).

## Inputs

- The ledger location comes from the config note (`WBS ledger: <artifact URL | folder path | owner/repo>`), as in `wbs-tracker`. No ledger yet: offer the `wbs-bootstrap` skill and stop. Location unreachable in this session: say so in one line and stop.
- Read `summary.json`. Regenerate it first when it is missing or older than `wbs.csv`, `plan.csv` or `events.csv`: `python3 <scripts>/make_agent_files.py <folder> --as-of <today>`. Without the scripts, compute the same fields from `wbs.csv` and `plan.csv`.
- Today is the user's local date. Each entry of `open_tasks` already carries `overdue`, `days_to_due`, `days_since_progress`, `blocker_category`, `focus` and `has_steps`.

## Pick

1. **Top three.** Candidates: open tasks without steps (`has_steps` false), status `in_progress`, plus `waiting` tasks only when the user can act (blocker category `prerequisite` that is now done). Never `backlog`. Rank by, in order: overdue; due within 3 days; importance `high`; in a focus package (`focus` true); serves a goal; most recent `last_progress`. Break ties with the smaller `size`. When scores tie, prefer different packages, unless the user's focus is one package. For each task give the code, a short title, the reason it is on the list (due date, focus, momentum) and the next action in at most eight words when the task text or its latest step states it; never invent one.
2. **Late or blocked**, at most five lines, then "+N more": overdue open tasks (days late), `waiting` tasks with their blocker (organisation or role) and days since the last news, `in_progress` tasks with no progress for 14 days or more.
3. **Decision cards**, at most three, in this order of priority:
   1. Probably done: an open task whose evidence or a later row suggests it finished (a step that says submitted or sent, a merged pull request in `evidence`). Answers: Done / Still open.
   2. Overdue: Done / New due date / Backlog.
   3. Stale: `in_progress` with no progress for 30 days or more. Answers: Still on / Backlog / Done.
   4. Waiting with no news for 30 days or more. Answers: Keep waiting / Backlog / Done.
   Each card states the facts in one line (code, title, the date that raises the question) and its two or three answers.

## Show

- Reply in the user's language, in at most three short lines plus the cards, with no headers or tables:
  ```
  Today (Fri 6 Nov): 1) 1.1.9 Final thesis revisions, due 27 Nov, 7 of 12 done · 2) 2.1.4 Statement of purpose v3 for program B · 3) 4.2.7 Fix the reminder bug
  Late or blocked: 5.3.6 Q3 bookkeeping 6 days late · 1.2.1 waiting on the program committee, 90 days without news
  Decide: [1] 1.1.10 Thesis repository submission, waiting since 2 Oct: a) keep waiting b) backlog c) done
  ```
- When the client offers a multiple-choice question tool (AskUserQuestion in Claude Code and Cowork, tappable choices in other apps), ask the cards with it, one question per card with its answers as options, instead of printing them.
- When the user keeps a dashboard artifact, end with its link; its Board view shows the same lists. Do not build a new page for this view.
- Nothing open: say so in one line and suggest the next goal from plan.csv.

## Apply the answers

- Change the ledger only for cards the user answered, through the `wbs-tracker` update procedure: Done sets `status` to done and `end` to today (for a parent, only when all its steps are done); Backlog and Keep waiting set the status and keep the blocker; a new due date edits `due`. Append one events.csv row per change (`status`, memo = the answer; `correct` for a new due date) and set `last_progress` to today.
- With the scripts you can write the answers as a list of `{"year", "code", "status", "end", "blocker"}` objects and run `python3 <scripts>/reconcile.py apply <folder> answers.json`.
- Validate, regenerate the agent files and publish as `wbs-tracker` does, then confirm in one line ("Updated 2: 1.1.10 done, 1.3.2 backlog").

## Scheduled daily summary

When a scheduled run asks for the daily summary, produce the same view as one short message and change nothing; decisions wait for the user.

## Rules

- Read-only unless the user answers a card.
- Never invent next actions, dates or outcomes; say "not recorded" instead.
- The content and privacy rules of `wbs-tracker` apply.

## Helper scripts

Python 3, standard library only. Use the first folder that exists as `<scripts>`: `scripts/` next to this SKILL.md, `${CLAUDE_PLUGIN_ROOT}/scripts` (Claude Code plugin), or `scripts/` in a clone of the personal-wbs repository.
