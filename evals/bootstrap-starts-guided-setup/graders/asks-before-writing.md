---
type: llm
---

PASS if the reply starts a guided setup before importing anything: it asks which sources are connected or need permission, where the ledger should live, or proposes areas and packages for the user to approve.
FAIL if it claims rows were already imported or written, or only gives generic advice without starting the setup.
