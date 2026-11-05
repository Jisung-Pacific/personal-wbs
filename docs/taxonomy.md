**English** | [한국어](taxonomy.ko.md) | [简体中文](taxonomy.zh-CN.md)

# Designing your taxonomy

The taxonomy is the code tree of your ledger: areas → packages → tasks → steps. During onboarding the agent skims your history, proposes a taxonomy and waits for your sign-off before it writes a single row. This guide helps you judge that proposal. It matters because codes are permanent once rows exist.

## The four levels

| Level | Code | What it is | Example |
|---|---|---|---|
| Area | `1` | a domain of your life, stable across years; 4 to 7 of them | `1 Research` |
| Package | `1.2` | a project, a stream of deliverables or a recurring duty within one year; 3 to 40 tasks | `1.2 Workshop paper` |
| Task | `1.2.3` | one deliverable, decision or event, with exact dates and evidence | `1.2.3 A0 poster and 3-minute pitch script` |
| Step | `1.2.1.4` | a separately dated step of one continuous task | `1.2.1.4 Acceptance notification` |

## Areas: 4 to 7, stable

- Areas are domains, not projects. Projects end; domains continue, so the same area list serves every year.
- Typical sets:
  - Student who also runs a startup: `1 Research`, `2 Graduate School`, `3 Startup`, `4 Career`, `5 Admin`
  - Employee: `1 Product`, `2 Operations`, `3 Team`, `4 Learning`, `5 Admin`
  - Freelancer: `1 Clients`, `2 Business`, `3 Craft`, `4 Community`, `5 Admin`
- Give admin its own area. Taxes, registrations, renewals and paperwork are real work and take real time; hiding them makes the health check lie.
- Add a new area at the end only when nothing fits. Never renumber.

## Packages: per year, 3 to 40 tasks

- A package is what you would name if someone asked "what are you working on?": a paper, a release, a course you teach, an application round, a grant.
- Too big (more than about 40 tasks in a year): split by deliverable or phase, e.g. `3.1 v1 launch` and `3.2 Growth and operations`.
- Too small (fewer than 3 tasks): merge it into a neighbour, e.g. one-off purchases go into `5.2 Tools and subscriptions`.
- Recurring duties (teaching, bookkeeping, a weekly report) are packages too.
- Avoid "misc" or "other": anything that lands there is a package you have not named yet.
- Packages are numbered per year from `x.1`. The same project can carry a different number in a different year.

## Tasks and steps: atomic

The ledger is raw data, never a summary.

- One row is one concrete deliverable, decision or event, with its own exact date from the source (message time, commit date, file time, e-mail time, event date) and at least one evidence pointer.
- Good: `Submitted to the main track` (2026-05-13). `Chapter 3 method, 22 pages and 9 figures` (2026-02-16 ~ 02-28, one continuous piece of writing).
- Not good: `Worked on the paper (May)`, or `10-10 ~ 10-13: did A, B, C`. Split these into dated rows.
- When a task has several separately dated steps, it becomes a parent: the task keeps its code, title and overall range, and each step becomes a level-4 row.
- A later outcome is a new row: the acceptance notification is its own row, not a note appended to "Submitted".
- If the date is unknown, leave it blank. The sweep keeps looking for it; nobody guesses.

## Goals: 3 to 6 outcomes

- Goals live in `plan.csv` (`goal` rows) and each task may serve one of them.
- Write outcomes, not activities: "PhD admission for 2027", not "Apply to programs".
- The dashboard compares where your time goes with what you say matters, so a short, honest list beats a long one.

## Years

- Each year has its own tree with the same area list; packages start again from `x.1`.
- A task that continues into a new year stays in the year it started. New work on it in the new year becomes a new row there, starting with `(continued)`.

## Codes are permanent

- Codes are never renumbered. A deleted row retires its code, so gaps are normal. A misfiled row is corrected in its text, not moved to a new code.
- That is why the first structure matters most: sign off when the areas look stable for next year too and the packages look right for your busiest year.

## Checklist before you sign off

- [ ] 4 to 7 areas, each a domain you will still have next year
- [ ] Every package holds about 3 to 40 tasks in its year, and none is called "misc"
- [ ] Recurring duties and admin have their own packages
- [ ] 3 to 6 goals, each an outcome
- [ ] Five sample rows read as concrete deliverables, decisions or events with exact dates and evidence

## Example (fictional)

```
2026
1 Research          1.1 Thesis writing · 1.2 Conference paper · 1.3 Journal extension · 1.4 Lab seminar · 1.5 Literature review
2 Graduate School   2.1 PhD applications · 2.2 Scholarships
3 Startup           3.1 Sproutlog releases · 3.2 Growth and operations · 3.3 Grants and funding
4 Career            4.1 Teaching assistant · 4.2 Talks and networking · 4.3 Internship
5 Admin             5.1 Enrollment and paperwork · 5.2 Tools and subscriptions · 5.3 Tax and bookkeeping
Goals: Finish the MSc · PhD admission for 2027 · Publish the research · Grow Sproutlog · Admin on time
```

The full fictional ledger is in `sample/en` (English) and `sample/ko` (Korean).
