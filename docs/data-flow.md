# Data flow

Everything happens inside your own Claude session and your own files. There is no server; nothing goes to the author.

```mermaid
flowchart LR
  subgraph S["Your sources (read-only)"]
    C["Claude chats and<br/>Claude Code sessions"]
    G["GitHub"]
    D["Google Drive · Gmail · Calendar"]
    K["Slack · Notion"]
    X["Exports you upload<br/>(ChatGPT, Claude)"]
  end
  subgraph K2["Skills in your Claude session"]
    B["wbs-bootstrap<br/>first import"]
    T["wbs-tracker<br/>log after each task"]
    W["wbs-sweep<br/>find what was missed"]
    Y["wbs-today<br/>one-minute view"]
    H["wbs-schedule<br/>background runs"]
  end
  subgraph L["Ledger in the place you choose"]
    F["wbs.csv · plan.csv · events.csv<br/>coverage.csv · summary.json · llms.txt"]
  end
  P["Dashboard: one HTML file<br/>computes in your browser"]
  N["Author / any third-party server"]
  S --> B & T & W
  B & T & W --> F
  F --> Y
  H -. prompts you paste into<br/>your app's scheduler .-> W & T & Y
  F --> P
  F -. never .-> N
```

| Step | What moves | Where it goes |
|---|---|---|
| Read | Titles, dates and IDs of your chats, commits, files, mail, events and pages, through the connectors you enabled | Into the Claude session only |
| Write | Short rows describing the work, with evidence pointers (chat ID, PR number, file title) | `wbs.csv` and its companions, in a claude.ai artifact, a local folder or your private Git repository |
| View | The CSV files | The dashboard page, computed in your browser |
| Send | Nothing | No telemetry, no analytics, no author server |

The optional autolog plugin adds one local step: when a Claude Code session ends, a hook appends the session's ID, time, working folder and transcript path to `queue.jsonl` in the plugin's data folder on your computer. The transcript is read later, in a session, only when you ask the `wbs-autolog-drain` skill to log the queue.

The privacy policy is in [PRIVACY.md](../PRIVACY.md); security reporting in [SECURITY.md](../SECURITY.md).
