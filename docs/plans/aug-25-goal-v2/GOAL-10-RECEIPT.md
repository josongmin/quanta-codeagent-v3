# GOAL-10 verification receipt

Date: 2026-08-26 · **superseded in part — see the addendum at the bottom (2026-08-30)**

Branch: `codex/goal-v2-main-integration` (landed on `main`; the goal lane was
reconciled by merge `9b21d2fd2`, and five further audit rounds landed through
2026-08-29: `294111f92`, `8d450b010`, `9d43617c9`)

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

## Addendum — 2026-08-30 doc↔code re-audit

This receipt is a point-in-time record; the rail table below was true on
2026-08-26 and several lines have since moved. Re-measured on `main`:

| Line in the table above | 2026-08-30 |
|---|---|
| `god-code-ratchet + _arch` 73 pass | **266 pass / 0 fail** (25 files) — the suite ~3.6×'d |
| `bun test tests/unit` 38329 pass / 2987 files | not re-measured; the tree holds **3066** unit files (a concurrent session was committing during the audit, so a single-process full-suite number would not be attributable) |
| `bun test tests/integration` 3122 pass / 353 files | not re-measured; **363** integration files |
| `lint && lint:debt` PASS, 221 diagnostics | **NOT reproducible**: `lint:debt` exits 1 with a prod `noExcessiveCognitiveComplexity` regression (37 > 36) plus unpinned `format`/`parse` hits. Attributed to files this plan never touched (`search-index-backend.ts`, `node-repl/default-kernel.ts`, `cli/internal.ts`, `agent/loop/skill-gate.ts`) |
| compiled `dist/agent` PTY battery 9 pass | the battery is **10** cases since `9d43617c9` (process-restart); the compiled-binary parity run has **not** been repeated against the 10-case suite |
| `fc validate` 1068 features | **1069**, and all four `fc` rails still PASS |

"Regressions found and closed" stops at the 2026-08-26 set. Rounds 2–5
(2026-08-27 → 08-29) closed eleven more probe-confirmed defects — unattributed
web/SDK goal turns, a queued user turn TAKING the goal claim, the CLI ignoring a
refused claim, an invisible fail-stop refuse loop, a `turn.cancel` claim leak,
`recover()` having no caller, `/goal work` accept-then-drop, a daemon-killing
handler throw, an ack emitted before every real gate, an unregistered socket
starting a billed turn, and a non-hermetic e2e writing the developer's own
149 MB thread DB. They are recorded in `receipts/GOAL-08.yaml` rounds 3–5 and
summarised in `README.md` 실행 기록.

"Remaining boundary" holds with one correction: say autonomous goal **pursuit**
is outside the claim. Since the default-ON promotion the stdio/SDK door does
build objective authority and expose the `objective_*` tools
(`src/apps/cli/serve-stdio-cmd.ts`); what it has no front door for is the wake
controller — `startGoalWakeController` still has exactly two production callers
(`interactive-setup.ts`, `goal-wake-compose.ts`).

What this receipt claimed as delivered scope but the code does not have:
`tests/smoke/goal/`, the telemetry decision-counter set and its label-allowlist
test, and 9 of the 14 PTY battery items. Those are tracked in `README.md`
"현재 상태 — 열린 항목 (2026-08-30)".

