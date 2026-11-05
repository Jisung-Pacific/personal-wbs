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

`--scaffold` runs the cases' `scaffold.sh` (it only writes `ledger/wbs.csv` and `ledger/plan.csv` into the empty workspace). Granting `Bash` runs commands in Claude Code's sandbox; on Linux install `bubblewrap` and `socat` first. Results go to `evals/results/`, which is ignored by Git.
