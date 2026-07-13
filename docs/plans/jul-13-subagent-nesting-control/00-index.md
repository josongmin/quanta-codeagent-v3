# Sub-agent nesting control — execution status board (SSOT)

**Date:** 2026-07-14
**Design authority:** [RFC rev.5](../jul-13-subagent-nesting-control.md)
**Execution authority:** this status board and the ticket files linked below

## Live baseline

Re-check before each ticket; do not treat this snapshot as permanent.

- `src/agent/spawn-depth.ts` derives child depth from `parent.depth`, but still treats absent depth as root and uses `Number.isInteger`.
- `QUANTA_MAX_DESCENDANT_DEPTH` is canonical with live default `3`.
- `config.subagent.maxDepth` can still provide a separate effective cap.
- `src/agent/subagent-runner.ts` uses derived depth for admission/config, but still uses `req.depth` for run id and agent metadata.
- `src/agent/branch-search-runner.ts` directly calls `runAgent` and derives `(config.depth ?? 0) + 1` locally.
- persisted handles do not carry lineage/policy receipts; resume calls `scheduler.fork(spec)`.
- `Tool` has no required spawn/manage/observe effect metadata; projection remains builder-local.

## Status vocabulary

- `ready`: all dependencies are complete and the ticket has an owner-local RED rail.
- `blocked`: a named predecessor is not complete. Do not start.
- `in_progress`: exactly one worker owns the ticket and has recorded the baseline.
- `done`: acceptance commands and completion receipt exist.
- `hold`: product decision or external authority is missing.

## Ticket board

| Ticket | Priority | Status | Depends on | Deliverable |
|---|---:|---|---|---|
| [SNC-00](tickets/SNC-00-baseline-red-rails.md) | P0 | ready | — | inventory + authoritative RED rails |
| [SNC-01](tickets/SNC-01-policy-snapshot-config.md) | P0 | blocked | SNC-00 | immutable policy snapshot + config conflict rules |
| [SNC-02](tickets/SNC-02-lineage-root-grants.md) | P0 | blocked | SNC-01 | explicit lineage + root grant assembly |
| [SNC-03](tickets/SNC-03-admission-grant-ledger.md) | P0 | blocked | SNC-02 | typed admission + single-consumer grants |
| [SNC-04](tickets/SNC-04-run-entry-split-static-fence.md) | P0 | blocked | SNC-03 | root/descendant entry split + AST fence |
| [SNC-05](tickets/SNC-05-standard-producer-migration.md) | P0 | blocked | SNC-04 | standard runner producer migration |
| [SNC-06](tickets/SNC-06-special-producer-migration.md) | P0 | blocked | SNC-04 | branch/reviewer/background/side paths migrated |
| [SNC-07](tickets/SNC-07-tool-effect-contract.md) | P1 | blocked | SNC-05, SNC-06 | required tool-effect contract + exhaustive annotation |
| [SNC-08](tickets/SNC-08-central-tool-projection.md) | P0 | blocked | SNC-07 | effective-registry central projection |
| [SNC-09](tickets/SNC-09-persistence-v2-receipt.md) | P0 | blocked | SNC-03, SNC-04 | V2 durable lineage receipt |
| [SNC-10](tickets/SNC-10-resume-grants-legacy-deny.md) | P0 | blocked | SNC-09 | depth-preserving resume grant |
| [SNC-11](tickets/SNC-11-observability-invariants.md) | P1 | blocked | SNC-08, SNC-10 | projection/admission telemetry |
| [SNC-12](tickets/SNC-12-closeout-default-flip.md) | P0 | blocked | SNC-05..11 | cleanup, catalog rebuild, gated default flip |

## Landing order

```text
SNC-00 -> SNC-01 -> SNC-02 -> SNC-03 -> SNC-04
                                         |-> SNC-05 -|
                                         |-> SNC-06 -|-> SNC-07 -> SNC-08 -|
                                         |-> SNC-09 -> SNC-10 ------------|-> SNC-11 -> SNC-12
```

`SNC-05`, `SNC-06`, and `SNC-09` may run in parallel only when their owned files do not overlap and `git status --short` is clean for those surfaces.

## Global completion contract

Every ticket report must include:

- baseline commit and `git status --short` before edits
- exact files changed and owner seam changed
- RED evidence captured before implementation
- focused proof commands with exit codes
- unrelated pre-existing RED, separated from introduced RED
- remaining blockers and next unblocked ticket

No ticket may mark itself done from typecheck-only evidence when its contract includes runtime behavior.
