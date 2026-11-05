# Why agents keep the books and you only decide

personal-wbs is built on one idea: a person should spend their attention on the work, not on tracking it. Agents collect, link, check and forecast in the background, and the person answers a few short cards. This page lists the research behind each design choice, with verified bibliographic data. Product precedents are listed separately and are not evidence on their own.

Reading budget the design aims for: under a minute a day on Today, at most 7 lines a week, at most 10 lines a month.

## Design choices and their evidence

| # | What the agents do | Why a person (or a classic PM tool) won't | Evidence |
|---|---|---|---|
| 1 | **Capture everything, with evidence.** They read chats, commits, documents, mail and calendars and write one dated row per outcome. Status changes from deterministic evidence (a merged PR, a submission record) are applied with a link; anything inferred becomes a card. | Self-tracking breaks at collection, and gaps carry into reflection. Trackers lapse. Classic tools react only to explicit signals. | Li, Dey & Forlizzi, *A stage-based model of personal informatics systems*, CHI 2010; Epstein et al., *A lived informatics model of personal informatics*, UbiComp 2015; Choe et al., *Semi-Automated Tracking*, IEEE Pervasive Computing 2017; Faulring et al., *Agent-assisted task management that reduces email overload*, IUI 2010; Bellotti et al., *Taking email to task*, CHI 2003 |
| 2 | **Dedupe and link.** Near-duplicates from several writers are merged when the source id matches and proposed otherwise. | Pairwise comparison grows quadratically with the ledger. | Narayan et al., *Can Foundation Models Wrangle Your Data?*, PVLDB 16 (2022); Zhang et al., *Duplicate Bug Report Detection: How Far Are We?*, ACM TOSEM (2022) |
| 3 | **Check the plan against what happened.** The event log is replayed weekly: illegal paths, time in status, work-in-progress vs throughput, share of effort outside the focus. | Nobody replays a whole history every week. | van der Aalst, *Process Mining*, Springer 2016; Rozinat & van der Aalst, *Conformance checking of processes based on monitoring real behavior*, Information Systems 33(1) 2008; Little, *A Proof for the Queuing Formula: L = λW*, Operations Research 9(3) 1961 |
| 4 | **Forecast from your own history.** P50/P85 finish dates come from your finished tasks of the same kind, not from optimism. | People underestimate completion times unless they connect the estimate to past experience; an agent can do that every time. | Buehler, Griffin & Ross, *Exploring the "planning fallacy"*, JPSP 67(3) 1994; Kahneman & Lovallo, *Timid Choices and Bold Forecasts*, Management Science 39(1) 1993; Flyvbjerg, *Curbing Optimism Bias … Reference Class Forecasting in Practice*, European Planning Studies 16(1) 2008 |
| 5 | **Resume notes.** Five lines under each task you are about to start: last state, a first action of 15 minutes or less, the open question, links. | A suspended goal fades and needs a cue at resumption; people do not write resumption notes when interrupted. | Altmann & Trafton, *Memory for goals: an activation-based model*, Cognitive Science 26(1) 2002; Parnin & DeLine, *Evaluating cues for resuming interrupted programming tasks*, CHI 2010; Iqbal & Horvitz, *Disruption and recovery of computing tasks*, CHI 2007; Kersten & Murphy, *Using task context to improve programmer productivity*, FSE 2006 |
| 6 | **Few, batched messages.** Silence unless a decision is due; reviews at fixed times. | Interruptions at the wrong moment cost time, stress and frustration; batching notifications improves attention and well-being. | Mark, Gudith & Klocke, *The cost of interrupted work*, CHI 2008; Iqbal & Bailey, *Effects of intelligent notification management*, CHI 2008; Adamczyk & Bailey, *If Not Now, When?*, CHI 2004; Fitz et al., *Batching smartphone notifications can improve well-being*, Computers in Human Behavior 101 2019; Züger et al., *Reducing Interruptions at Work: … FlowLight*, CHI 2017 |
| 7 | **Short reviews written for you.** Weekly in 7 lines, monthly in 10, each ending with one question. | Reflection improves work habits only when it rests on data that was actually collected. | Meyer, Murphy, Zimmermann & Fritz, *Enabling Good Work Habits in Software Developers through Reflective Goal-Setting*, IEEE TSE 47(9) 2021; Meyer et al., *Design Recommendations for Self-Monitoring in the Workplace*, PACM HCI 1 (CSCW) 2017; Kocielnik et al., *Designing for Workplace Reflection*, DIS 2018 |
| 8 | **Cards instead of silent changes.** The agent proposes with evidence and a reason; you accept, decline or snooze in one tap. A kind of change becomes automatic only after you accepted it 19 times out of 20. | Mixed initiative: weigh the cost of acting against the cost of asking, make dismissal and correction cheap, set the automation level per function. People over-trust plausible agent plans, so cards show evidence, not just a verdict. | Horvitz, *Principles of mixed-initiative user interfaces*, CHI 1999; Amershi et al., *Guidelines for Human-AI Interaction*, CHI 2019; Parasuraman, Sheridan & Wickens, *A model for types and levels of human interaction with automation*, IEEE Trans. SMC-A 30(3) 2000; He, Demartini & Gadiraju, *Plan-Then-Execute*, CHI 2025; Lu et al., *Proactive Agent*, ICLR 2025 |
| 9 | **Time-block proposals, never silent calendar edits.** | Re-solving deadlines, estimates and the calendar after every change is constant work; if-then plans help follow-through. | Myers et al., *An Intelligent Personal Assistant for Task and Time Management*, AI Magazine 28(2) 2007; Cranshaw et al., *Calendar.help*, CHI 2017; Gollwitzer, *Implementation intentions*, American Psychologist 54(7) 1999; Masicampo & Baumeister, *Consider it done!*, JPSP 101(4) 2011 |
| 10 | **Self-audit of the ledger.** Every row on every run: dates, evidence, parents, status vs last event. One number on Today; details only below 95%. | Checks must cover every row every time. | Schelter et al., *Automating large-scale data quality verification*, PVLDB 11(12) 2018 |
| 11 | **Split big tasks into small steps.** | Unpacking a task into parts reduces underestimation; microtasks resist interruption. | Kruger & Evans, *If you don't want to be late, enumerate*, JESP 40(5) 2004; Cheng, Teevan, Iqbal & Bernstein, *Break It Down*, CHI 2015 |
| 12 | **A work-in-progress cap and a circuit breaker.** | Limits help only if applied every time; switching costs attention. | Little 1961 (above); González & Mark, *"Constant, constant, multi-tasking craziness"*, CHI 2004; Leroy, *Why is it so hard to do my work?*, OBHDP 109(2) 2009 |

## Product precedents (mechanisms checked against official documentation)

| Product feature | What personal-wbs takes from it |
|---|---|
| Jira column constraints and days-in-column dots | the work-in-progress cap on the board; age dots on cards |
| Trello Card Aging | cards show how long they have been untouched |
| Linear Triage and Triage Intelligence | the decision queue: accept, decline, snooze, with suggested fields and duplicates |
| Linear project updates and Asana smart status | agent-written package health and weekly reviews |
| Basecamp Automatic Check-ins and Hill Charts | progress without asking people for status |
| Things 3 and Todoist dates vs deadlines | a planned day separate from the deadline (on the roadmap) |
| OmniFocus review intervals and sequential projects | per-package review cadence; only the next available action on Today |
| Sunsama daily planning and workload threshold | one overload warning instead of a long plan |
| GitHub Projects built-in workflows and closing keywords | `WBS:<code>` in commits, PRs and document titles closes tasks with evidence |
| Microsoft Project baselines | a monthly baseline for slip detection |
| Shape Up appetite and circuit breaker | a time budget per focus package, enforced at the re-check date |

## Notes

- Years are those of the printed version; some papers appeared online earlier (Meyer et al. TSE: online 2019).
- Titles in italics are abbreviated where long. Every reference was checked against its DOI, ACM DL, publisher or proceedings page in November 2026.
