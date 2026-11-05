---
type: regex
target: { source: file, path: ledger/wbs.csv }
pattern: '2026-10-1[0-3] ~ (2026-)?10-1[0-3]'
match: not_contains
weight: 2
---
