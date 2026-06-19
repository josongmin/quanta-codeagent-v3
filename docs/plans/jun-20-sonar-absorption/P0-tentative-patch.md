# P0 — Tentative-Patch Retention (structural spec)

Absorb Sonar #1: *"the agent is encouraged to save tentative patches… otherwise it
would run out of reasoning steps while validating and terminate without an
answer."* Fixes our most-observed loss: `max_turns_exhausted` with a gold patch
already found (13417, matplotlib-22719) — the agent over-runs verification and
the FINAL tree is empty / regressed.

Harness-level (NOT a prompt). Reuses existing seams — zero new infra.

---

## Seams (all confirmed present)
- `runAgentViaSdk` already SUBSCRIBES to the session event stream
  (`captureBenchSessionEvents` → `listenerPort.subscribe`). [apps/bench/eval/driver.ts]
- sandbox path + `gitStageAndDiffCached(sandbox)` + `sourceOnlyDiff` in scope.
- verify outcome classification already exists in `verify-guard.ts`
  (`isVerifyFailing(lastVerify)`) — REUSE it; do NOT invent test-name heuristics.
- final patch is taken via `withGitSnapshot` → `patch` in the driver.

## Failure mode this fixes (measured)
agent edits → runs test (PASS, tree = the fix) → keeps going → can't re-verify /
loops → `max_turns` → final tree emitted is empty or a later regression. The
VERIFIED-GREEN intermediate state is thrown away. We keep it instead.

---

## Module 1 — `src/runner/batch/eval/tentative-patch.ts` (PURE core)
```
interface Candidate { readonly diff: string; readonly verified: boolean; readonly seq: number }

createTentativeRecorder(): {
  record(diff: string, verified: boolean, seq: number): void   // push non-empty only
  selectEmitted(finalPatch: string, finalOk: boolean): string  // PURE selection
  readonly count: number
}
```
**Selection policy** (audited — avoids the "smallest picks an incomplete fix" trap):
1. `finalOk` (agent finished cleanly) AND `finalPatch` non-empty → **finalPatch**
   (never second-guess a clean finish → byte-identical to today on clean runs).
2. else → the **LAST verified-green** candidate if any exists
   (the latest tree the agent ITSELF proved working — most complete, not smallest).
3. else → the last non-empty candidate; else `finalPatch` (unchanged).
Pure + deterministic + unit-testable in isolation. No I/O, no heuristics.

## Module 2 — snapshot trigger (in `runAgentViaSdk`)
On each session event (existing subscribe loop), when the event is a VERIFY tool
result classified NOT-failing by `verify-guard`'s existing classifier:
  `recorder.record(sourceOnlyDiff(await gitStageAndDiffCached(sandbox, t)), /*verified*/ true, seq)`
- Snapshot SYNCHRONOUSLY on the verify-pass event (stream is sequential → captures
  the post-verify tree = the verified state).
- `git add -A && git diff` mid-run only stages the index; the final `withGitSnapshot`
  re-stages — harmless. Agent is already barred from `git checkout/reset`.
- Debounce: only snapshot on verify-pass (the sole "good candidate" signal) — at
  most a few git calls per run, near-zero overhead.

## Module 3 — emit (driver)
Where the driver computes the final `patch`:
  `patch = QUANTA_BENCH_TENTATIVE ? recorder.selectEmitted(rawPatch, outcomeIsClean) : rawPatch`
`outcomeIsClean` = the run ended via normal completion (not max_turns / aborted).

## Gate
`QUANTA_BENCH_TENTATIVE` knob (default-OFF). OFF ⇒ recorder never wired ⇒
byte-identical. New knob file `src/runner/knobs/knobs/tentative-patch.ts` +
manifest/registry per the knob SSOT.

---

## Hellgate tests (`tests/unit/.../tentative-patch.test.ts`)
1. clean finish, non-empty final → `selectEmitted` returns the final (byte-identical).
2. max_turns (finalOk=false) + a verified candidate + EMPTY final → returns the
   verified candidate (the core win). teeth: assert the EXACT candidate diff.
3. max_turns + a verified candidate + a REGRESSED non-empty final → returns the
   verified candidate, NOT the regression.
4. never verified + empty final → returns last non-empty; none → returns final.
5. RED-on-injection: knob OFF ⇒ even with candidates, emits the raw final
   (proves the gate, not the recorder, is what changes behavior).
6. determinism: same candidate sequence → same selection.

## Measurement (A/B, EC2)
- Re-run the instances that hit `max_turns_exhausted` (13417, matplotlib-22719,
  django-13212, +the ceiling runs) with `QUANTA_BENCH_TENTATIVE=1`.
- Check: emitted patch == a verified candidate (mechanism fires) + EC2 grade.
- ABLATION: same set with knob OFF → confirm the delta is the tentative emit, not
  noise. Per discipline: no "it passed with it on = it helped" without the OFF arm.
- Telemetry: candidates recorded/run, % runs where emitted ≠ raw-final, of those
  how many flip ❌→✅.

## Risk
LOW — additive, gated, clean-finish path byte-identical. Only changes the emitted
patch when the run ends badly AND a verified-green intermediate exists.

## Done-when
6 hellgate green + full bench unit suite green + typecheck clean + measured A/B
showing emitted≠final flips ≥1 max_turns instance ❌→✅ with 0 clean-run regression.
Then promote to default-ON (off-switch) like SIMPLICITY.

---

## STATUS (2026-06-20, autonomous build)
**IMPLEMENTED + HELLGATE-GREEN. Measurement deferred (see below).**

Landed:
- `src/runner/batch/eval/tentative-patch.ts` — pure selection core. **10 hellgate green** (`tests/unit/bench/tentative-patch.test.ts`).
- `src/runner/batch/eval/stream-tap.ts` — `BenchStreamTap` extended with verify-pass
  detection + optional `onVerifyPass` callback (absent ⇒ byte-identical). **8 new
  hellgate green** (`tests/unit/bench-stream-tap.test.ts`, 19 total) incl
  RED-on-injection (no-callback = pure pass-through).
- `src/apps/bench/eval/driver.ts` `runAgentPhase` — recorder + serialized
  best-effort snapshot on verify-pass + `selectEmitted(patch, stopReason==="completed")`,
  all behind `QUANTA_BENCH_TENTATIVE` (default-OFF, gateOn). swebench-only.
- `src/agent/index.ts` — export `isVerifyOutputFailing` (the tap needs it).
- Regression: **43 bench unit tests green**, touched files typecheck clean.

Verify-pass signal (no heuristics): a `test_runner` / test-like-`bash` tool_call
whose tool_result is `ok` AND not `isVerifyOutputFailing` (the SSOT the
verify-guard uses). Snapshot = `gitStageAndDiffCached` (already source-only).

NOT yet done:
1. **EC2 A/B measurement** — DEFERRED. `driver.ts` was being actively edited by a
   parallel session (in-flight `ReproOracleCalibration` type, typecheck red — NOT
   mine). Running bench (local or EC2) against a moving driver risks collision +
   infra contention (per the standing warnings). RUN WHEN driver.ts is stable:
   `QUANTA_BENCH_PRESET=agentless-v2 QUANTA_BENCH_TENTATIVE=1 bun run bench run
   --swebench <max_turns-instances.jsonl> --predictions <out>` on instances that
   hit `max_turns_exhausted` (13417, matplotlib-22719, the ceiling set), grade on
   EC2, compare to the OFF baseline. Per the SAFETY-NET rule: confirm regression==0
   on clean finishers → promote to **default-ON** (`!gateDisabled`).
2. **repair-path wiring** (`runAgentOnce` / `runRepairPhase`, the multi-round
   path) — only the single-pass `runAgentPhase` is wired. Single-pass is the
   dominant path for the observed max_turns cases; repair-path is a follow-up
   (avoided more driver.ts edits during the parallel session).
