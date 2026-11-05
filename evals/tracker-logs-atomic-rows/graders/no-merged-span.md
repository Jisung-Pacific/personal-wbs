---
type: regex
target: { source: file, path: ledger/wbs.csv }
pattern: ',2026-10-10,2026-10-1[13],|,2026-10-11,2026-10-13,'
match: not_contains
weight: 2
---
