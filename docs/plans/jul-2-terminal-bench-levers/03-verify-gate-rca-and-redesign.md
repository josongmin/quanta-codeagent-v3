# RCA: verify-gate is a rubber-stamp — root cause + redesign (2026-07-02)

## Symptom (box audit, closable re-run, verify-gate ON)

verify-gate stamped `verified-pass` for **3 of 7 tasks that actually FAILED** (reward=0):
pytorch-model-recovery, torch-tensor-parallelism, mteb-retrieve. The bounded follow-up turn fired
**0 times** across all runs. ⇒ the campaign's "+7 fake-green" is NOT attributable to verify-gate; it
was env-owned + fresh-attempt. **verify-gate's real contribution ≈ 0.**

## RCA (multi-layer, grounded)

1. **Immediate:** `deriveVerificationState` returns `verified-pass` when `exercised === true` AND the
   final text is not uncertain/negative. i.e. "ran the deliverable + agent didn't say it failed."
2. **Mechanism:** `exercised` (a `container_exec`/`pty_*` that ran the deliverable and observed SOME
   output) is NOT correctness. Running `python solve.py` and seeing output ⇒ exercised=true ⇒ pass,
   regardless of whether the output is right.
3. **Design flaw (wrong hypothesis):** the RFC assumed fake-green = "agent didn't EXERCISE (only
   created files)." The box reality is the opposite: the agent DOES exercise (runs it, sees output)
   but the output is WRONG and the agent is **over-confident** ("verdict: green, exit 0"). The gate
   was built against a failure mode that isn't the dominant one.
4. **Root cause:** no check against the task's **correctness criterion**. TB task layout:
   `environment/` (given to the agent) + `tests/` (HIDDEN — holds `golden.sql`, `test_outputs.py`).
   The golden answer is hidden. BUT the criterion is **COMPUTABLE from given inputs for a subset**:
   - query-optimize: the agent is GIVEN the original slow query (`my-sql-query.sql`); "correct" =
     "same rows as the original" ⇒ the agent can run the original to get the reference output and diff.
     It didn't.
   - polyglot-*: expected = `fib(N)`, computable ⇒ agent can compute + diff. It didn't.
   - chess-best-move: correctness = "engine's best move" ⇒ install stockfish (env-owned) + query. It
     guessed instead.
   Where the answer is NOT derivable from given inputs (pytorch-recovery original weights,
   model-extraction true matrix, dna/raman/db-wal domain answers) the agent CANNOT self-verify — only
   best-of-N / a stronger model helps.
5. **Process RCA (why CI didn't catch it):** the 135 green unit tests validated the *mechanism* (does
   the gate detect an exercise / stamp a state) — never the *outcome correlation* (does `verified-pass`
   ⇒ the task actually passes). Only the box A/B, which has REAL reward, exposed the rubber-stamp.
   **Missing test class: verdict ↔ real-reward correlation** (a fake-green fixture whose gate verdict
   must NOT be verified-pass).

## Two grounded failure classes

- **Class 1 — computable-reference (FIXABLE by scaffold):** query-optimize, polyglot-c-py,
  polyglot-rust-c, chess-best-move. A correctness check is constructible from given inputs (run the
  original, compute the expected, query a real engine). The agent skipped it. ~3-4 tasks.
- **Class 2 — non-computable / hidden-only (model / best-of-N):** pytorch-model-recovery,
  model-extraction-relu-logits, dna-assembly/insert, raman-fitting, db-wal-recovery, mteb-retrieve.
  No derivable reference; correctness needs the right answer the agent can't check. ~best-of-N only.

## Plan (hellgate each; fix v1 before any v2)

### P0 — Stop the rubber-stamp (honesty; immediate)
`verified-pass` MUST require a passed correctness check, not mere exercise. Rescope the trichotomy →
**`exercised` (ran, correctness UNCHECKED) / `verified-pass` (ran AND a reference-check passed) /
`verified-fail` / `unverifiable` (no exercise).** Today's "verified-pass" is a lie that both misleads
telemetry AND suppresses the follow-up. This alone makes the gate honest (most current passes become
`exercised`, which correctly does NOT satisfy "verified").

### P1 — verify-gate v2 = construct-and-diff acceptance loop (Class 1)
Before finalize, if a correctness check is constructible, the agent MUST build + run it and only claim
pass on a match:
- "reproduce-and-diff": run the GIVEN reference artifact (original query / a spec-derivable expected
  output) and diff the deliverable's output against it.
- "use the real oracle": for tasks with a canonical tool (chess→stockfish), install (env-owned) + query.
Delivered as a STEER (system-priority, owned-rules sibling) + a gate that, when no reference-check is
found in the trajectory, injects ONE bounded follow-up demanding it. Targets query-optimize, polyglot,
chess.

### P2 — Observability (prereq — we are blind on the box)
The brain does not log its assembled system prompt or the gate verdict path. Add opt-in brain
prompt/verdict logging (to `QUANTA_TB_BRAIN_LOG_DIR`) so env-posture (R-ENV-OWNED reached the model?)
and the gate decision are verifiable on the box, not just in unit. Without this every box measurement
is faith-based.

### P3 — Clean re-measurement (attribution)
Re-run with the FIXED gate + logging; isolate env-owned-only vs +verify-gate-v2 so contributions are
attributed (the current +7 is unproven for the gate).

### P4 — best-of-N (orthogonal; Class 2)
Variance capture for non-computable tasks — pytorch-model-recovery (66% → N=3 near-certain), then the
11-12% pair. Independent of the gate.

## Missing-test backstop (so this can't regress)
Add an integration fixture: a trajectory that exercised-but-produced-wrong-output MUST yield
`exercised`/`unverifiable`, NEVER `verified-pass`. This is the outcome-correlation test the unit suite
lacked.

## Honest expected yield
- P0+P1 (Class 1): query-optimize + polyglot + chess ≈ **+2-3** (63→65-66).
- P4 best-of-N (Class 2): pytorch-recovery + ~1-2 ≈ **+2-3**.
- Ceiling unchanged: 13 tasks never-solved by anyone; 84% is union (unreachable single-system).
- Realistic reach: **~66-68/89 (74-76%)**. Not 84%.
