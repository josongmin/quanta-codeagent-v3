# GOAL-10 verification receipt

Date: 2026-08-26

Branch: `codex/goal-v2-main-integration`

## Result

CLI and web goal control are default ON. `QUANTA_GOAL=0` is the public opt-out;
explicit internal gate values remain authoritative. Enabling the controller does
not create autonomous work: continuation remains inert until the operator creates
an active goal.

The implementation includes revision- and attach-generation-safe settlement,
measured per-attempt budgets, bounded wakeups, quiescence checks, exponential
backoff, a product hard turn cap, verifier receipts, repeated blocker admission,
atomic web submission, and actor-scoped objective capabilities.

## Proof rails

| Rail | Result |
|---|---|
| `bun run typecheck && bun run typecheck:tests` | PASS |
| `bun run lint && bun run lint:debt` | PASS; 221 diagnostics at or below the frozen ceilings, no new category or worst-score regression |
| `bun test tests/unit/god-code-ratchet.test.ts tests/unit/_arch` | 73 pass, 0 fail |
| `bun test tests/unit` | 38329 pass, 21 skip, 0 fail across 2987 files |
| `bun test tests/integration` | 3122 pass, 13 skip, 1 todo, 0 fail across 353 files |
| compiled `dist/agent` PTY goal battery | 9 pass, 0 fail |
| flaky-rail repetition (`--rerun-each=10`) | 140 pass, 0 fail |
| `bun fc validate && bun fc build && bun fc diff && bun fc check-evidence` | PASS; 1068 features, all evidence resolved, generated catalog clean |

`dist/agent` was produced by `bun run build` and selected through
`QUANTA_E2E_CLI_BIN`. No global CLI installation was overwritten.

## Regressions found and closed

- The CLI wake path lacked the measured `BudgetMeter` required by autonomous
  attempts. The CLI now uses the same per-turn assembler authority as web.
- A failed turn hid the authoritative `turn.failed` reason, obscuring the budget
  wiring defect. The session turn driver now surfaces that reason.
- Capability-boundary consumers retained raw objective authority after actor
  capabilities were introduced. CLI, web, and wake composition now receive only
  read, user, or system capabilities appropriate to the caller.
- Static ratchets matched pre-refactor source shapes instead of live helper calls.
  They now match calls and include red-on-injection checks.
- Two unrelated full-suite assertions were nondeterministic: same-millisecond
  lease acquisition order and Node REPL stdout flush timing. They now assert the
  actual contracts and passed ten repeated runs.
- Existing goal-branch files contained four formatting/import-order failures and
  the god-code approaching cohort exceeded its ceiling. Formatting was repaired
  and cohesive pricing, mode-error, identity, and authority adapters were split
  without raising ceilings or allowlists.

## Remaining boundary

No production live efficacy, latency, or cost campaign is claimed. That is an
operational measurement follow-up, not evidence for runtime safety. Headless and
batch goal pursuit remain outside the feature claim because they have no public
front-door goal E2E.

The final commit SHA is reported after this receipt and the verified tree are
committed; a commit cannot contain its own SHA without changing that SHA.
