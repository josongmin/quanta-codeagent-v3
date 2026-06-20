# Journal — 2026-06-20 (overnight SWE-bench re-measure + RCA)

Task delegated: "re-measure ALL previously-failed instances with the SOTA++ config
(verify-select:3 + repro-vote consensus) and RCA each, while I sleep."

What actually happened: the measurement was confounded by my own bug, the RCA that
forced surfaced two real transport/infra bugs (now fixed), and my first "SOTA++ works"
conclusion **did not survive adversarial self-audit** and was walked back. The durable
value of the night is the bug fixes + the honest negative result, not a SOTA++ win.

---

## Lesson 1 — The OAuth throttle-swallow bug (the real find)

**Symptom (evidence):** in the first overnight run, all 6 shard boxes started failing
LLM calls at the *identical second* (~20:36:00, ~40s into the run). 20–30% of all calls
were "prepare-only" records: `llm_continuation phase:"prepare"` then ZERO response events
(~220ms) — vs a healthy gpt-5.4 call averaging ~4,139ms with 60–220 events. ~8 of the 10
"empty patch" failures were instances whose agent loop fired its first continuation inside
this window and exhausted retries before it cleared (turns=1–3 immediate aborts).

**Root cause:** `streamResponsesSurface` (src/llm/responses-stream.ts) returned NORMALLY
on an HTTP-200 stream that produced zero content events and no `response.completed` — a
silently-swallowed throttle. The agent loop saw a "completed empty turn" and immediately
fired the NEXT request into the same throttle window. There was NO backoff because the
empty stream was never classified as an error (the retry path with exponential-jitter
backoff in src/agent/retry.ts only fires on a *thrown retryable error*).

**Fix (structural):** after the stream, if `!sawContentEvent && completed===null &&
terminalStopReason==="end_turn"`, throw a retryable `rate_limit` LLMError. Now the existing
backoff engages instead of hammering. Guarded against false positives:
- `message_stop` is the synthetic terminator (emitted even for empty streams) → excluded
  from `sawContentEvent` (this was the first bug in my own fix — caught by the unit test).
- a NON-`end_turn` terminal stop_reason (content_filter / max_tokens) is an *intentional*
  early stop, not a throttle → excluded (this was the false-positive the adversarial audit
  caught: a content-filtered stop would otherwise be wrongly retried 3×).

**Verification:** 6 teeth (empty→rate_limit+isRetryable, content→no-throw, partial→no-throw,
content_filter→no-throw, max_tokens→no-throw) + adversarial audit (Round 2 = production
backoff-engagement traced end-to-end through fromSdkError→isRetryable→decideOnStreamError→
backoff, runtime-confirmed) + 313 existing LLM tests green + typeclean.

**Why it matters:** this confounded EVERY full-remote measurement under load. Fixed → all
future bench/agent runs are robust to the throttle. This is the night's biggest win.

---

## Lesson 2 — The concurrency-env confound (my mistake)

I set `QUANTA_BENCH_CONCURRENCY=1` to keep boxes light. **Wrong env var.** full.ts:404 reads
`QUANTA_FULL_REMOTE_CONCURRENCY` (default 6) and *clobbers* QUANTA_BENCH_CONCURRENCY on the
box. Box logs confirmed every shard ran **concurrency=6** → 6 boxes × 6 = 36 concurrent
agent loops on ONE ChatGPT-OAuth token → the throttle burst above.

**Fix:** full.ts now honors EITHER env name (alias) + logs the effective per-box concurrency
up-front (the confound was invisible because only the box echoed it). The product
`box_count × per_box_concurrency` is what hits the shared login rate — known-safe ≈ 6 total.

---

## Lesson 3 — "verify-select works" did NOT survive adversarial audit (walked back)

**What I first claimed:** clean run recovered 16/38 vs single-pass control 3/38 → "net +9–13,
verify-select is the lever, 5× recovery." I wrote this in the report.

**Adversarial self-audit (using the user's own variance lens):** the user's parallel A/B
(ab-reprovote-med) had already concluded that at small n with flaky instances, *disjoint
PASS sets = run-to-run variance, not superiority* — and that you must not claim an effect
from a 1–2 instance count difference. Applying that to my result:

| arm | MEASURED | recovered | rate |
|---|---|---|---|
| verify-select:3 | 36/38 | 12 | 33% |
| single-pass (control) | **15/38** (incomplete: shard1 box-error exit 255 + others still grading) | 3 | 20% |

**The kill shot:** of the 11 "only verify-select recovered" instances, **8 were never measured
by the control at all** (control incomplete). So the headline "+9" was mostly a
control-incompleteness artifact, exactly the failure mode I should have checked before
claiming it. The honest comparison is 33% vs 20% on a partial, biased control — and these are
inherently flaky instances (they failed single-pass once, recover on *any* re-run).

**Verdict: verify-select effect UNCONFIRMED.** Possibly modestly ahead, but not a clean lever
claim. My "5×" was over-claimed and is retracted. This matches the user's reprovote A/B
conclusion (effect unconfirmed, keep OFF, don't burn more without n≥50).

---

## Lesson 4 — meta-lessons

- **Measurement hygiene > measurement.** The night's value was finding+fixing the transport
  bug that was silently corrupting every run, NOT the SOTA++ number (which was noise).
- **Small-n SWE-bench A/B is noise** for repair/select levers: flaky instances + disjoint PASS
  sets + 1–2 count deltas = variance. Need MEDIUM slice (baseline ~40–70%) + n≥50 to see a
  real recovery delta. (Both my run and the user's independent A/B converged on this.)
- **Always check the denominator before the numerator.** "X recovered, Y didn't" is meaningless
  if Y was never measured. The control must be COMPLETE before an attribution claim.
- **Audit your own conclusion the same way you audit code** — the variance lens that the user
  applied to reprovote was the exact tool that killed my verify-select over-claim.

---

## RCA findings that DO hold (throttle-independent)

- **Localization is NOT the bottleneck**: 4/31 still-fail are localize-miss, all django
  near-misses (related_lookups vs lookups, options vs base). Navigation ≠ selection (again).
- **wrong-fix = 17/31 (the real ceiling)**: model edits the RIGHT gold file but the fix is
  wrong — wrong condition / wrong function-in-right-file / **incomplete multi-site** (gold
  spans 3 files, model touched 1). This is fix-GENERATION quality.
- **repro signal is non-discriminative on hard instances** (`repro_red_but_unresolved≈0.8`;
  resolved & unresolved both split across repro 0/5 and 5/5). ⇒ a repro-vote consensus over
  this signal is ≈ noise on the hard class. repro-vote only helps where the repro is good.

## What to do next
1. **Commit the throttle + concurrency fixes** (durable, universal value).
2. **Stop small-n SOTA++ A/B.** Confirm verify-select only with a COMPLETE single-pass control
   + n≥50 on a MEDIUM slice — and weigh whether the ROI justifies it (two independent A/Bs say noise).
3. **Real lever = wrong-fix generation quality**: candidate selection gated on the *executable*
   regression/FAIL_TO_PASS suite (not the noisy repro signal) + a multi-site completeness check.

## Evidence locations
- run logs / per-shard reports: `~/reprovote-ab/sota/` ; durable verdicts: `~/Library/quanta-codeagent-v3/bench/full-remote/report-*.json`
- attribution script: `~/reprovote-ab/sota/attribution.ts` ; full report: `~/reprovote-ab/OVERNIGHT-REPORT.md`
- fix: src/llm/responses-stream.ts (throttle guard) ; src/apps/bench/remote/full.ts (concurrency alias)
- tests: tests/unit/llm/responses-stream-throttle-swallow-hellgate.test.ts
