---
name: wbs-schedule
description: Help the user set up the background runs that keep the personal WBS ledger current without asking: a daily collection, a weekly review (the moment the user is shown what was added), an optional backfill expansion that walks back through older history, and an optional daily summary, with ready prompts and the steps for their app (Cowork, the Claude app, Claude Code). Use when the user wants the ledger to update itself, asks how to schedule or automate it, or when the bootstrap reaches its scheduling step (after the first 3-month look). Never creates a schedule unless the user explicitly asks.
license: MIT
---

# Schedule the ledger's background runs

A plugin cannot create scheduled tasks by itself. This skill gives the user the exact prompts and the steps for their app, and creates a schedule only when the user explicitly asks and the session has a scheduling tool.

## 1. Check the ledger location first

A scheduled run starts fresh, so it must reach the ledger without the current session:

- **claude.ai artifact or a Git repository**: reachable from cloud runs (Cowork, the Claude app, Claude Code cloud scheduled tasks).
- **Local folder**: only a run on the same computer reaches it (a Cowork or desktop task that runs locally, or cron/launchd with `claude -p`). Suggest moving the ledger to a private repository or an artifact if the user wants cloud runs.

Read the location from the config note (`WBS ledger: …`). Put it into each prompt below.

## 2. The prompts

Replace `<LOCATION>` with the ledger location. Pick times a few minutes off the hour (runs on the hour can start late).

- **Daily collection** (for example 21:17 local time):
  > Use the wbs-sweep skill in catch-up mode on the WBS ledger at <LOCATION>: enumerate the last 48 hours of every connected source, log new work as atomic, dated rows with the wbs-tracker rules, validate, regenerate the agent files and publish. Change nothing in any connected app. Report only what needs my answer.
- **Weekly review** (for example Monday 08:43). This is the one run that shows the user what was added; the daily and backfill runs stay silent:
  > Use the wbs-tracker skill to run the weekly health check on the WBS ledger at <LOCATION>, update plan.csv, publish, and give me the summary with this week's prescriptions. Start with what was added since the last review: new rows by area, windows closed, new packages, and coverage per year.
- **Backfill expansion**, only for the steady-background onboarding mode (for example 02:41, daily, one or two such schedules at different times, never overlapping). Each run takes a few windows going backwards, so the history fills in a little at a time:
  > Use the wbs-sweep skill in backfill mode on the WBS ledger at <LOCATION>: take the next <N, default 3> open windows in coverage.csv in this order, the last 12 months first and then older years newest first, newest month first. Enumerate each by ID, dedupe against the whole year, merge with the wbs-tracker rules (existing codes never change; new packages in an older year take that year's next free number), update coverage.csv and sweep_state.json, validate, regenerate the agent files and publish. If no window is open, say so once and stop. Stay silent unless something needs my answer; the weekly review will show what was added.
- **Daily summary**, optional (for example 08:13 on weekdays):
  > Use the wbs-today skill on the WBS ledger at <LOCATION>: today's top three tasks, what is late or blocked, and at most three decisions. Change nothing.

The backfill expansion needs only read access to the sources plus write access to the ledger; run it on the worker model the user chose (default Sonnet) if the app lets a scheduled task pick a model, because its judgment is checked by the validator and the second pass.

Keep each run's tools and connectors to what it needs: the sources the user connected (read-only use), plus write access to the ledger location.

## 3. Where to set it up

Give the steps for the user's app only:

- **Cowork and the Claude app**: open **Scheduled** in the sidebar, choose **New task**, then **Create with Claude** (describe the run and paste the prompt) or **Set up manually** (name, prompt, frequency: hourly, daily, weekdays or weekly). Tasks that need local files or apps run only on that computer. Source: https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork
- **Claude Code (cloud scheduled tasks)**: run `/schedule` in the CLI (for example `/schedule daily at 21:17, <prompt>`), or use claude.ai/code/routines → **New task**, or the desktop app's **Code** tab → **Scheduled** → **New task**. A run clones the selected repositories and uses the connectors included in the task (all connected connectors are included by default; remove the ones it does not need). Schedules run at most hourly; a five-field cron expression is in UTC unless it starts with `CRON_TZ=`. `/schedule` needs a claude.ai subscription login. Source: https://code.claude.com/docs/en/web-scheduled-tasks
- **Claude Code desktop scheduled tasks** run on the user's computer and can use local folders. Source: https://code.claude.com/docs/en/desktop-scheduled-tasks
- **Anything else**: cron or launchd running `claude -p "<prompt>"` with only the tools the run needs allowed, or whatever scheduled-task feature the user's app offers. If nothing can be scheduled, say so and suggest a recurring reminder.

Do not promise e-mail or push notifications; mention them only if the user's app shows such a setting for scheduled tasks.

## 4. When the user asks you to create it

Only after an explicit request ("set it up for me"), and only with a scheduling tool present in this session: create the runs the user chose with the prompts above, confirm the name, time, time zone and location of each, and say how to pause or delete them. Otherwise walk the user through the steps of section 3.

## 5. Record it

Add or update one `config` row per run in plan.csv so the next session knows what runs: `kind` config, `target` `schedule-daily`, `schedule-weekly`, `schedule-backfill` or `schedule-today`, `note` the time, time zone and app (for example "21:17 Asia/Seoul, Cowork"), `decided` today. Then validate and publish as `wbs-tracker` does.
