# DOF-30 - seam-only disposition

**Priority:** P1  
**Depends on:** DOF-00

> **Status update (2026-09-07):** the single routing authority and the typed
> HITL fail-closed follow-up are complete. [`SEP6-01`](../../sep-6-role-contract-audit/tickets/SEP6-01-hitl-retry-fail-closed.md)
> records the behavioral proof. Do not reopen the broader DOF-30 seam-only queue.

Current seam-only set: lane-manager, bug-fix proposal queue, recovery-router, plus ledger-discovered rows. Plan-queue, `/profile`, prompt-suggestion, per-tool producer, and syntax indexing are excluded because they have live production paths.

For each seam choose `wire`, `deliberate_hold`, or `delete-proven-duplicate` before writing broad tests. `wire` requires a named host/consumer. `hold` keeps the unique primitive and records the promotion owner. `delete` requires the four-part deletion contract from the board.

Likely wiring targets to evaluate:

- recovery-router -> RetryingLLM/FallbackLLM single policy authority
- lane-manager -> existing batch/subagent concurrency owner, only if it removes duplicate scheduling policy
- bug-fix queue -> explicit review UI/slash consumer, not autonomous apply

No default decision is `kill`.
