# Evals

Behaviour tests for the skills, run with `claude plugin eval` (Claude Code v2.1.269 or later; https://code.claude.com/docs/en/plugin-evals). Each case is a folder with `prompt.md` and `graders/`; two cases seed a small synthetic ledger with `scaffold.sh`.

| Case | Checks |
|---|---|
| `bootstrap-starts-guided-setup` | `wbs-bootstrap` fires and starts the guided setup instead of writing rows |
| `tracker-logs-atomic-rows` | `wbs-tracker` fires; three outcomes on three days become three dated rows; no range row (`10-10 ~ 10-13`) and no merged start/end span |
| `sweep-enumerates-windows` | `wbs-sweep` fires and works window by window without inventing items |
| `today-one-minute-view` | `wbs-today` fires; at most three tasks, the overdue task is named, the ledger is not edited |
| `schedule-gives-prompts` | `wbs-schedule` fires; ready prompts and app steps, no schedule created |
| `ignores-unrelated-writing`, `ignores-generic-project-plan` | no `wbs-*` skill loads (scored in both arms) |

Run from the repository root. Runs call the model with your credentials and count against your usage; `llm` graders add judge calls.

```
# full suite with the no-plugin baseline (3 runs per arm)
claude plugin eval . --scaffold --trust-plugin --allow-tools Write Edit "Bash(python3 *)"

# quick check: one run, no baseline, judge-free graders still apply
claude plugin eval . --scaffold --trust-plugin --allow-tools Write Edit "Bash(python3 *)" --runs 1 --ablation none
```

Use `--judge-model sonnet` for the `llm` graders: with the default small judge, a correct sweep plan was once marked FAIL, and the same case passed with Sonnet as the judge.

## Last results

2026-11-06, Claude Code 2.1.318, two runs per arm, `Write` and `Edit` granted (no sandbox for `Bash` on that machine), default judge:

| Case | With | Without | Δ |
|---|---|---|---|
| `schedule-gives-prompts` | 1.00 | 0.00 | +1.00 |
| `today-one-minute-view` | 1.00 | 0.67 | +0.33 |
| `tracker-logs-atomic-rows` | 1.00 | 1.00 | 0.00 |
| `bootstrap-starts-guided-setup` | 1.00 | 1.00 | 0.00 |
| `sweep-enumerates-windows` | 0.50 (1.00 with a Sonnet judge) | 1.00 | −0.50 |
| `ignores-unrelated-writing`, `ignores-generic-project-plan` | 1.00 | 1.00 | 0.00 |

A Δ of 0 means the base model already does that part well on such a short case; the cases still guard against regressions.

`--scaffold` runs the cases' `scaffold.sh` (it only writes `ledger/wbs.csv` and `ledger/plan.csv` into the empty workspace). Granting `Bash` runs commands in Claude Code's sandbox; on Linux install `bubblewrap` and `socat` first. Results go to `evals/results/`, which is ignored by Git.
