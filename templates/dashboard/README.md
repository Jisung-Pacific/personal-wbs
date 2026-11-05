# Dashboard

The dashboard is one HTML page that reads the ledger files next to it and computes everything in the browser: no server, no account.

**Not in this repository yet.** The page is about 0.6 MB, and the Claude plugin directory holds every non-image file over 256 KiB for manual review, so it will be published as a download with a release instead of inside the plugin. The roadmap item is to split it into files under that limit.

What the page expects:

- It reads its data from the folder it sits in: `wbs.csv` (required), `coverage.csv`, `plan.csv`, `events.csv` and `digest_<year>.csv` when present. English and Korean headers and values are both accepted (schema v6, see the main README).
- The interface language (English, Korean, Simplified Chinese) is switched at runtime from the globe button at the top right; the choice is remembered in that browser only. The translations sit in `i18n/<lang>.json` next to the page.
- Serve the folder over HTTP (`python3 -m http.server -d <folder>`) or publish the page with its files as a claude.ai artifact; browsers may block reading the CSV files from a page opened directly from disk.
- Served from a folder, the page is read-only. Published as an artifact, the owner can also move cards on the board and write the weekly report's summary, using the artifact's own storage and Claude features.
- Answers from the Status check mode can be written back with `scripts/reconcile.py apply <folder> answers.json` (a list of `{"year", "code", "status", "end", "blocker"}` objects).
- The sample ledgers in `sample/en` and `sample/ko` have the reference date 2026-11-06.
