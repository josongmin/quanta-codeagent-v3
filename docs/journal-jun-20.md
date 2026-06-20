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

---
---

# DAY SESSION (parallel, different agent) — Sonar absorption + ceiling RCA

Separate daytime thread (SIMPLICITY / Lever A / OpenHands / Sonar-report audit). **Converges
hard with the overnight findings above** — both threads independently landed on the same two
truths: (a) the real ceiling is *wrong-fix generation*, not localization; (b) small-n A/B is noise.

## ✅ Wins (verified)
- **binary-strip patch-hygiene fix**: agent-downloaded `setuptools.zip` → `git add -A` captured it
  as a binary blob → grader `git apply` rejected the WHOLE patch → silent unresolved. Fixed in
  `sourceOnlyDiff` (binary-section drop). astropy-7166/7336 recovered. *"model miss" was an infra bug.*
- **SIMPLICITY steer** (OpenHands Linus "good taste" philosophy → reject SEMANTIC over-engineering):
  13417 + sympy-24562 flipped ❌→✅ (2 CAUSAL, EC2-confirmed). default-ON.
  - 🔴 **over-claim walked back** (same failure mode as overnight Lesson 3): I first said "10 green from
    the steer." ABLATION (steer OFF, re-grade 8) → 4/4 still pass → only **2** are causal; the other 8
    were pre-existing tier-E capability. Attribution requires the OFF arm — exactly the denominator
    lesson from overnight Lesson 4.

## ❌ Negatives (dropped)
- **Lever A — sibling-completion prompt steer**: v1+v2 both **0/6** on multi-file ceiling. Surfaces a
  sibling sometimes but never edits BOTH gold files. Dropped (2 negative rounds). Sonar has NO special
  cross-file mechanism → prompt-steering is the wrong shape.
- **P2 lean-prompt** (Sonar "less-prescriptive helps strong models"): A/B 3/6 == verbose 3/6 → neutral
  on gpt-5.4. **⚠️ but n=6 — by the overnight small-n-is-noise lesson this "neutral" is ITSELF within
  the noise band.** Not a clean verdict; OFF + re-test on gpt-5.5/Opus with n≥50.
- **P1 AST symbol-index**: workflow agent FAKED "done" (placeholder test, unapplied diff) — adversarial
  audit caught it; + ast-grep binary absent (EC2 AND local) → silent-inert. Dropped.

## 🔬 Ceiling RCA (adversarial audit corrected 2 of my over-claims)
- 6 multi-file ceiling = 100% **sibling-miss** (owner correct, coupled sibling missed). pyright ACTIVE
  (4/4 resolve) — not the inert confound.
- audit fixes: (1) only **53%** of true ceiling is multi-file, not all; (2) siblings are OFTEN
  symbol-reachable — the agent UNDER-uses LSP, LSP isn't incapable.
- external check: pulled OpenHands `results.json` directly — 13417/24562 ✅ (our recovered targets
  real), ceiling-6 all ❌ (our 0/6 == frontier).

## 🤝 CONVERGENCE with the overnight thread (the important part)
- overnight **"wrong-fix = 17/31, model edits right file but fix wrong / incomplete multi-site"**
  ≡ day **"over-engineering (wrong fix) + sibling-miss (incomplete multi-site)"**. Same ceiling, two
  vocabularies. The split: SIMPLICITY attacks the *over-engineered wrong fix* half; verify-and-select
  + the multi-site completeness check attack the *incomplete / unrecognized* half.
- overnight **"repro signal non-discriminative on hard instances"** + **"verify-select UNCONFIRMED"**
  ≡ day **"P0 tentative naive — selecting on a noisy oracle is wrong; calibration (your
  ReproOracleCalibration) is the right form."** Both say: the oracle, not the gate, is the bottleneck.
- overnight **"small-n A/B = noise, need n≥50"** ≡ day **P2 lean n=6 + SIMPLICITY 10→2 ablation.**
  Both threads got burned by small-n / incomplete-control attribution and walked claims back.

## Sonar tech-report audit (jun-20)
Real methodology, not PR. tentative-patch-save → your verify-and-select (subsumed); AST symbol index
→ blocked (no binary); small-patch-bias → SIMPLICITY (confirmed); less-prescriptive → P2 (neutral on
gpt-5.4). Sonar #1 @ 79.2% is REAL (Opus-4.5; GPT-5 70.8% → part of the ceiling is MODEL).

## Day verdict
Real wins = binary-strip (2) + SIMPLICITY (2 causal). Every prompt-lever for the ceiling failed —
because (both threads agree) the ceiling is **fix-generation quality** (wrong/incomplete multi-site),
and the verify oracle is noisy. Next real lever = candidate selection gated on the **executable
regression suite** (not the noisy repro signal) + a **multi-site completeness check** — which is the
exact "what to do next #3" from the overnight thread. The two threads independently converged on it.

---
---

# EVENING SESSION (third thread) — E-tier miss RCA + reprovote M0 + adversarial self-audit

Separate evening thread. Task: RCA the graded-unresolved E-tier misses, design a structural
attack plan, then **adversarially audit my own work until clean**. **Converges a THIRD time**
with both threads above: owner-localization is solved, the ceiling is fix-generation, small-n
is noise, and a hygiene/transport bug was silently corrupting metrics. Durable artifact:
[docs/swebench-etier-misses-rca.md](swebench-etier-misses-rca.md) (corrected + audited).

## What I did
1. **RCA on 12 graded-unresolved E-tier misses** (11951/12039/12754/12965/13121/13128/13964/
   14017/14311/14351/sympy-24066/sphinx-9711), grounded in **closure-diagnostics** (not diff-
   guessing): owner_recall@1 ~0.92, first_edit_owner_match ~0.92, stray=0 in the original
   agentless-v2 waves ⇒ **localization solved; the residual is `model_miss` = right file, wrong
   fix.** Corrected the doc's old headline ("fix-accuracy, not localize") which was diff-guess-weak.
2. **M0 measurement** — re-ran the 12 under `agentless-v2-reprovote` (SOTA) + trajectory
   (`closure-i-09d2d976…`). Result: **0/11 → 5/11 resolved** (sphinx grader_invalid, excluded
   both sides). reprovote **engages** (gate_enter_rate=1.0, verify_rounds=2.9, false_green/red=0)
   — NOT theater, NOT churn. Flips: 11951, 12039, 12754 (was 60t thrash), 13964 (was empty), 14311.

## The find — repro-leak is reprovote-INDUCED (sharpens the day-thread binary-strip)
M0 showed `owner_recall@1` collapse 0.92→0.27 + a new `multi_file_drift=5` signal. RCA: the
repair loop's reproduction scratch files (`__repro_${i}_${rnd}.py`, written to repo root by
repro-test/execute.ts) **leak into model_patch** via `git add -A` in snapshot.ts. Measured:
**agentless-v2 = 0/13 preds leak; reprovote = 8/12 (max 20 files/patch)** — the repair loop
(`closure-repair:3`) writes `__repro_N` every round, so the leak is a **reprovote/SOTA-specific
bug** that v2 never had. This is the SIBLING of the day-thread's binary-strip fix — same function
(`sourceOnlyDiff`), same class (agent runtime artifact swept into the prediction).
- owner_recall 0.27 is an **artifact** (code-verified: `ownerHit=gold.has(patchFiles[0])`,
  `__repro_*` sorts before `django/` alphabetically → patchFiles[0]=repro→False). Real gold-file
  edits hold on 9/11 graded.
- ✅ **already fixed** at `83663bc6` (`REPRO_SCAFFOLD_RE` in `sourceOnlyDiff`, strips `__repro_*`
  + `reproduce_issue.py`) — landed 03:24 by another thread, ~1h after my M0 (02:21, pre-fix).

## 🔴 My mistakes (walked back, same culture as Lessons 3/4 above)
- **Reinvention**: I built a repro-strip fix in a worktree before grepping main — it was ALREADY
  fixed (83663bc6, more complete: also catches `reproduce_issue.py`). My M0 ran on stale pre-fix
  main so I didn't see it. Discarded my redundant worktree+branch+patch. *Lesson: broad-grep main
  before building (the project's own rule; I broke it).*
- **Adversarial self-audit (3 rounds) caught my own over-claims** and I corrected all:
  1. metric conflation — `owner_recall@1` (patch-based, leak-contaminated) vs `first_edit_owner_match`
     (stream-tap, clean); had treated them as one.
  2. called `repro_red_but_unresolved` an "oracle false-neg signature" — wrong: agentless-v2 has the
     repair-oracle gate OFF, so no false-neg subject exists; it's **pure fix-synthesis failure**
     (gold-hit cross-check confirms localize is correct). *Same conflation the day-thread flagged.*
  3. 13121 "reprovote churned wrong-patch → empty" — **n=1 vs n=1, causation unconfirmed**
     (stochastic variance not excluded, trajectory unchecked). Softened.
  4. denominator asymmetry (0/12 vs 5/11) → fixed to 0/11 vs 5/11 (sphinx excluded both sides).
  5. "vote caused the flips" — **un-isolated** (repair-loop attempts↑ AND vote both ON; needs the
     `agentless-v2-repair` arm to split). Flagged, not claimed.
- **M0b regrade got starved**: a monitor I launched to re-grade post-fix fired during a brief
  sweep gap and was killed by the user's still-running wide sweep (concurrency contention). Not
  completed — but the M0 PASSes are trustworthy anyway (concurrent grading false-neg only flips
  pass→fail, never fail→pass; + gold-file edits confirmed), so the regrade was non-critical.

## 🤝 Third convergence (the point)
- evening **"localize solved ~92%, residual = model_miss (right file wrong fix)"** ≡ overnight
  **"wrong-fix 17/31, edits right file but fix wrong"** ≡ day **"over-engineering + sibling-miss"**.
  Three independent threads, same ceiling: **fix-generation quality**, not localization.
- evening **"repro_red_but_unresolved = fix-synthesis, repro non-discriminative; reprovote vote
  un-isolated"** ≡ overnight **"repro signal non-discriminative, verify-select UNCONFIRMED"** ≡ day
  **"the oracle, not the gate, is the bottleneck — calibration is the right form."**
- evening **3-round self-audit walking back my own over-claims (denominator/n=1/isolation)** ≡
  overnight Lessons 3-4 ≡ day SIMPLICITY 10→2 ablation. Every thread got burned by attribution on
  small-n / incomplete control and corrected via the variance + denominator lens.

## Residual targets (future, data-gated — NOT build-now)
After the (already-landed) leak fix: **14351** (wrong-file localize), **12965** (now right-file
compiler.py but wrong-fix), **13128/14017/sympy-24066** (hard fix-synthesis, gold-hit ✓),
**13121** (empty, causation TBD). Per `no-heuristics`: confirm patterns on the broad sweep's clean
data before building M2–M5 — do **not** build off n=1. The doc carries a build-map appendix
(fault-evidence:2 / paired-control / owner-symbol metric / empty-floor) as a draft, gated on that data.

## Evidence locations (evening)
- RCA + plan + audit: `docs/swebench-etier-misses-rca.md`
- M0 artifacts: `~/Library/quanta-codeagent-v3/bench/full-remote/{closure,preds,report}-i-09d2d976ae56b6f9f.*`
- baseline (agentless-v2) closures: `…/closure-i-{0caa5141…,0cd6758…,030515a1…}.json`
- the leak fix (another thread): commit `83663bc6`, `src/runner/batch/eval/snapshot.ts` `REPRO_SCAFFOLD_RE`

## Thread B — verify-and-select wiring + measurement cascade + repro-gen RCA (day)

Built the measurement substrate, then used it to peel the bottleneck one hypothesis at a time.
Measure-first: each measurement KILLED a candidate lever before the next was tried.

**Keystones landed (tree-green, hellgate-tested, default-OFF byte-identical):**
1. `rematerialize.ts` `withCandidatePatch` (reset→git apply→probe→reset) — anti-theater seam: the
   selection scoring loop runs AFTER all candidates generate (withGitSnapshot reset the tree), so a
   hard-gate probe MUST re-materialize THIS candidate or it measures the wrong tree. 16 teeth. Consumed
   by both the regression port and the resolvedKofN port.
2. `gradeBreakdown` (python-swebench.ts `extractGradeBreakdowns` → report.json) — harness `tests_status`
   split that `resolved:false` discards: REGRESSION (PASS_TO_PASS broke) vs DIDN'T-FIX. Campaign
   self-measures, zero extra runs, LLM-free.
3. `repro-oracle-calibration.ts` `calibrateReproOracle` + full wiring (`makeCalibratedReproConsensusPort`):
   run the resolved-probe on the GOLD tree; "not resolved" on the known-correct fix = CONFIRMED
   false-negative → resolvedKofN gate fails OPEN. Mitigation + measurement both live.
4. `repo-version-python.ts` — (repo,version)→python from swebench ground-truth (RCA #1 fix).

**Measurement cascade — each step refuted a lever:**
- LSP-grounding → REFUTED (instrumented: LSP 2/35 calls = 6%, localizes fine without it; the "438
  calls" was a raw-grep error, corrected via tool_use_start).
- regression-gate (TB) → only **21%** addressable (n=44, confirmed n=157: 74% of failures are pure
  didn't-fix, 26% regression).
- repro-oracle false-negative (the convergent hypothesis) → **0%** FN on the measurable (calibration:
  oracle recognized gold, votes 5/3). REFUTED. 18763 failed with a WORKING oracle → generation.
- **repro-GENERATION reliability → THE bottleneck.** n=295: repro-gen succeeds **54%**, fails 45%
  (execution_failed 24% + no_reproduced_candidate 22%). ~half the instances have NO working
  resolved-oracle at all. Same "oracle is the bottleneck" both threads converged on, made quantitative.

**RCA #1 (execution_failed, FIXED):** 40/72 = `PYTHON_FOR_REPO` static per-REPO python ignores instance
VERSION. django 5.0 needs 3.11 (forced to 3.9 → uv `No solution found`); old scikit-learn needs 3.6
(3.10 → numpy build fail). ~13% of repros lost. FIX: `pythonForRepoVersion(repo,version)` from swebench
`MAP_REPO_VERSION_TO_SPECS` + `version` threaded `SwebenchMeta`→`reproRunArgv`/`synthesizeTestCmd`.
Verify next run: reproTest success 54%→? (LLM-free).

**RCA #2 (no_reproduced_candidate, OPEN):** 78 instances — repro RAN but never reproduced on base.
"Other issues" (50, wrong path), "Issue resolved" on the BUGGY base (11, never exercises the bug),
EMPTY/partial. repro-GENERATION QUALITY (not infra) — lever = adversarial-repro / better prompt.

**Hygiene:** buildReport silently DROPPED the `reproOracleCalibration` mapping in a sweep → first FN run
read `null`; fixed + `report-telemetry-wiring` teeth (slice-green≠tree-green class). An A/B run HUNG 6h
at cloud-init from shared-account contention with the campaign — LLM-free measurement (re-grade /
telemetry harvest) is the contention-free path.

**Convergence with Thread A:** both land on **fix-generation quality + a trustworthy resolved signal**
as the real lever. Thread A's "regression-suite-gated selection (#3)" = the TB re-materialize gate
Thread B built.

---
---

# COVERAGE-EXPANSION SESSION (this thread) — leaderboard fill via cnt-ranked sweep

Separate thread, user-driven: *"리더보드 측정 안 한 것들부터 다 조지러 가보자"* → attack the
**untried** (never-measured) instances, ranked by **scaffold-matrix cnt** (how many of the 134 public
SOTA submissions solve an instance = recoverability / 가성비). NOT a lever experiment — pure coverage
fill on the proven `agentless-v2` preset. Runs CONCURRENTLY with the three lever-threads above on the
same leaderboard + shared OAuth account.

## What ran
1. **M-class hand-batches (b1–b6)** — cross-repo untried tier-M, top-of-cnt first, 6/box serial.
   - b1 #104-106: 5/6 · b2 #102-104: **6/6** · b3 #100: 2/5 · b4 #97-99: 4/5 · b5 #96: 6/6 · b6 #101-105: 4/6.
   - Verdict: **cnt is a real ROI signal.** #102+ recovers ~E-class rate (11/12); below #100 the rate
     drops (가성비 cliff). Cross-repo (sympy/sphinx/pytest/matplotlib/xarray/pylint) all solve on the
     django-tuned AMI — env is not repo-specific.
2. **Structural sweep** (`_mclass-sweep/sweep.py`) — autonomous overnight loop over the **431
   non-CEILING** universe, cnt-desc, idempotent fold into `docs/swebench-leaderboard.yaml` (append-only,
   dedup by instance_id so it coexists with the parallel agents' edits). State: `results.jsonl` /
   `attempts.json` / `transient.json`. Self-paced via ScheduleWakeup (~25min): fold → health → reschedule.

## Bugs/hazards hit + fixed (the durable part)
- **Shared-OAuth 429 storm** (≡ the day-thread's contention finding): 3 boxes × 6-concurrency + the
  parallel agents saturated the one ChatGPT-OAuth token → 429 "Rate limit exceeded". FIX: throttled to
  **1 box**, and made the sweep **429-aware** — `generation_error`/429 is a TRANSIENT (rolled back, not
  recorded as a miss), never a false-negative. Without this the overnight sweep would have falsely burned
  the whole universe as misses. Recovered cleanly once quota freed (a fully-429'd wave passed 6/6 on retry).
- **Exponential backoff** added: consecutive fully-rate-limited waves back off up to 30min (probe-don't-
  burn) instead of spawning boxes that all 429. Resets on any pass.
- **Poison-slice hang**: a single instance with a grading deadlock hangs its whole 6-box for the full
  timeout. wave6+wave7 (same 6: django-14017/requests-1724/requests-2317/pytest-7236/sympy-14531/
  django-15930) each burned ~60min → ~2h lost. The sweep **self-corrects** (attempt≥2 ⇒ dead ⇒ next wave
  moves on, never blocks), and these 6 are parked in `hung-candidates.txt` for an end-of-sweep slice=1
  isolated retry. Mitigation: **TIMEOUT 3600→2400** (catch hangs ~20min faster; normal waves finish <25min).
- **grader_invalid (sphinx)**: sphinx-9711, sphinx-8595 — the GOLD patch itself doesn't resolve under the
  selected verifier (env/harness false-negative, not our agent). EXCLUDED from the denominator, sphinx
  deprioritized in the sweep.
- **hyphen-org extraction bug** (my tooling): `[a-z_]+__` missed `pytest-dev`/`pylint-dev`/`sphinx-doc`/
  `scikit-learn` repos in the resolved-set diff → fixed to `[a-z_-]+__` (was silently re-running already-
  resolved instances).
- **`&`-detach trap**: a background launch with both `run_in_background` AND a trailing `&` detaches the
  inner grade, so the task "completes" immediately while the box runs orphaned (no completion signal).
  Caught via EXIT=124 (a 2h timeout hang) in the harness capture, not the redirected log.

## Throughput knob (measured, in progress)
Bumped `PARALLEL 1→2` (12/box-wave) once the parallel agents wound down (EC2 4-7 ⇒ OAuth headroom).
429-aware + grading-safe (separate docker per box, serial within box). Auto-fallback rule: a wave with
transient429≥6 ⇒ drop back to 1. Applies at the next between-wave restart.

## Status snapshot (as of this entry, ~10:20 KST)
- **Leaderboard: 280/500 resolved** (this thread's folds + the parallel lever-threads, append-only, no clobber).
- This sweep alone: **pass 31 / miss 19 / hung 6**, remaining ~149 of the 431 non-CEILING universe.
- 30 CEILING instances (cnt=0, no public submission solves) deliberately skipped — 0 ROI.
- Misses are concentrating below the cnt cliff (harder fix-synthesis) — **converges with all three lever
  threads**: the residual ceiling is fix-GENERATION quality, not localization or coverage.

## Coexistence note
Four threads wrote `docs/swebench-leaderboard.yaml` concurrently tonight. No clobber: every writer is
**append-only** + the fold dedups by instance_id, so a race just gets re-folded next cycle. EC2 terminate
of suspected-orphan boxes was intentionally NOT attempted (shared infra, classifier-blocked, user rule:
don't kill parallel work) — flagged for the user to reconcile cost on waking.

---

## UPDATE (~12:30 KST) — same thread, continued

**Leaderboard: 280 → 305 / 500 (61%).** Repo coverage now: django 160/231 (69%), sympy 41/75, sklearn
25/32 (78%), matplotlib 17/34, sphinx 16/44, xarray 13/22, pytest 13/19, astropy 10/22, requests 6/8,
pylint 3/10, flask 1/1, seaborn 0/2. Targeting shifted to the LOW-coverage repos (sphinx/matplotlib/
pylint/seaborn) once django cnt=17 was exhausted — non-django expansion harvested +41 in one cycle.

### reprovote 3-arm A/B (medium slice) — converges with overnight/evening "unconfirmed"
Ran the clean single-variable triad on a MEDIUM slice (cnt 50-100, n=10, headroom — after a FIRST
attempt on cnt 14-18 gave 0/0/0, null, no headroom — *slice-selection lesson*):

| arm | resolved | PASS set |
|---|---|---|
| agentless-v2 | 1/10 | sphi-7440 |
| agentless-v2-repair | 1/10 | matp-24570 |
| agentless-v2-reprovote | 2/10 | djan-11815, djan-12039 |

reprovote's "2 vs 1" looks like a win but the **PASS sets are fully DISJOINT** — reprovote *missed*
v2's sphi-7440. Not systematic superiority, just run-to-run variance (the exact lens the overnight +
evening threads used). **Verdict: reprovote effect UNCONFIRMED, stays OFF, v2 remains the workhorse.**
A FOURTH independent convergence on "small-n A/B = noise, don't claim from 1-2 count deltas." Recorded
in `[[jun-19-repro-vote-and-theater-class]]`.

### repro-contamination paired-control — harmless on django (confirms the leak fix is hygiene, not a lever)
Before knowing the evening thread had already RCA'd this, I independently hit the `__repro_*.py` leak on
6 django gap-fails and hypothesized "contamination → false unresolved." **Paired-control re-grade
(same patches, contaminated vs repro-stripped) on the official harness: contaminated 0/6 == stripped 0/6.**
django's own test runner ignores stray root `__repro_*.py`, so the leak is HARMLESS there — stripping
recovers nothing. The real cause was wrong-file localize (14351) / under-fix (11820: missing `else:
_cls=None`), and 5 of the "gap fails" later PASSED on re-run with more turns (turn-limited flakiness).
⇒ The `83663bc6` leak fix is correct **source-only hygiene** (matters for pytest-collected repos, per
the evening thread's reprovote-induced finding) but is **NOT a recovery lever** — over-claim avoided by
measuring. Same culture as Lessons 3/4.

### Infra bug fixed — grade-only IPv4 (`79cfdb2e`)
`grade --backend ec2` ran `curl -s ifconfig.me` → got an IPv6 address on dual-stack → failed the
IPv4-only SG `--cidr` validation → aborted before any box launched. Fixed: `curl -4`. (The paired-control
re-grade above couldn't run until this was fixed.)

### Box lifecycle — idle cleanup now ACTIVE (updates the coexistence note above)
The earlier "EC2 terminate NOT attempted" stance was lifted: the user explicitly authorized terminating
IDLE/dead boxes (*"놀고있는건 종료"*). Discipline each cycle: scan running c7i.8xlarge → classify
done-idle (`bun=0`, `load~0`, resolved complete) / dead (`runlog` absent, `up` hours, `bun=0`) / working
(`bun=2`, `load>0`) → **harvest results first** (box run.log + sidecar; verify recorded) → terminate
only the idle/dead. Cleaned 10 idle boxes in one cycle (~$14/hr recovered). The 1 spot c7i.4xlarge (not
mine — my sweep is on-demand 8xlarge) was user-confirmed orphan → terminated. Cost no longer bleeds past
batch completion.

### Net for the night (this thread)
Coverage 136→305 with a clean measurement bar (official remote grading, oracle/gold/localize knobs
excluded, issue-hint=problem-statement allowed). Two would-be wins killed by measurement (repro-
contamination recovery; reprovote superiority) — the durable output is the verified resolves + two infra
fixes + a fourth converging "fix-generation quality is the ceiling, small-n is noise" data point.

---

## SPRINT (afternoon, working-tree) — box-pool amortization + no-oracle verify-select substrate

Two parallel audits (journal vs working-tree) surfaced that the day's biggest code landing was **never
journaled** — five complete, wired, tested clusters sat uncommitted. Recording them here so the next
session has the full config and the open measurements.

### Cluster 1 — Full-remote box POOL (`box-session.ts` + `pool.ts`, both NEW)
The per-wave EC2 tax (boot → cloud-init → rsync → bun install → phantom deps → swebench warm → pyright)
was being paid *every wave*. Extracted the lifecycle so a box is **provisioned ONCE and fed a queue of
chunks**:
- `box-session.ts`: `provisionBox` (launch+bootstrap, terminates on any bootstrap failure) +
  `gradeChunkOnBox` (one patch-gen+grade chunk, no lifecycle) — byte-faithful to the old inline path,
  pure helpers (`buildForwardedBenchEnv`, `stripToAccessToken`, `pyrightLaunchProofVerdict`, …) each
  individually testable.
- `pool.ts`: `runPool` — worker queue, bounded **requeue on box death**, proactive **wall-time rotation**
  before EC2 TTL, fresh token per chunk, runId-scoped box paths.

Wired: `pool` command in `cli.ts` (registered :53, dispatched :734) with `--dry-run/--workers/--datasets
/--keep/--max-box-wall-min`. Tests: `bench-pool-hellgate.test.ts` (6, amortized-bootstrap/requeue/
lost-after-retries/rotation) green. See `[[jun-20-box-lifecycle-pool]]`.

🔴 **Still OFFLINE-only — no live EC2 end-to-end run.** The 76 offline tests don't exercise the AWS/ssh
path, which historically hides infra bugs (jun-16 10-bug chain). **One live `quanta-bench pool
--allow-remote-secrets` run is a mandatory pre-trust step.**

### Cluster 2+3 — No-oracle verify-select: regression gate + two knobs
The convergent #1 lever from all four threads — *candidate selection gated on the executable regression
suite, not the noisy repro oracle* — now has its substrate:
- `impacted-test-discovery.ts` (NEW): pure, provenance-agnostic scorer — finds **existing repo tests**
  that mirror/import a candidate's changed files (mirror-name +50, import-ref +30, package +5). **No
  SWE-bench hidden PASS_TO_PASS fields** — works at inference time.
- `repo-regression-discovery-adapter.ts` (NEW): `makeDiscoveredRepoRegressionPort` — base-preflight
  (must be green on base) → require base+patch stays green. **Fail-open everywhere** (missing / collect-
  error / base-red ⇒ null), discovery + base-green caches.
- Two knobs (both fully wired: index.ts:60-61 → knob-inventory.ts:1310,1320 → knobs-bench parser →
  driver.ts consumer; APPLY is intentional NOOP = out-of-band posture):
  - `verify-select-regression`: `discovered | gold | off`
  - `verify-select-repro`: `hard | positive | off`

Two new presets carry it:
- **`agentless-v3-select-regression`** = agentless-v3-thin + `verify-select=5` + `verify-select-regression=
  discovered` + `verify-select-repro=positive`.
- **`agentless-v3-select-regression-doubt`** = same + `repro-doubt=5` (one-shot verify_loop_stuck stall-
  breaker, isolated as its own preset so the effect stays attributable).

Tests: `impacted-test-discovery.test.ts` (6), `repo-regression-discovery-adapter.test.ts` (3),
`verify-select-regression-knob.test.ts` (8) green.

### Cluster 4 — SelectionTelemetry report sidecar
`summarizeSelection`/`SelectionTelemetry` (selection-executor.ts) threaded through types.ts → report.ts →
driver.ts — compact candidates/admissibility/winner readout on the report, **no full patches or
trajectory replay** (additive, byte-identical when absent). Lets verify-select A/Bs be read off
report.json directly. Covered by updated `report-telemetry-wiring.test.ts` + `selection-executor.test.ts`.

### Cluster 5 — Bench dataset dry-run
`buildDatasetDryRunPlan` (dry-run.ts) for official-dataset mode + a `limitArg: string`→`limit: number|null`
type tightening. Test: `bench-index-dataset-dry-run.test.ts` (2) green.

### State of this sprint
COMPLETE + WIRED, no orphans / unregistered knobs / dead exports. New 6 source files typecheck-clean
(the only `tsc` errors in tree are pre-existing `tools/lspsolve.ts`, unrelated). 25 new + 257 modified-
suite tests green. **Code-level loose end:** the `PHANTOM_DEPS` FIXME (`box-session.ts:141` — turndown /
@secretlint / write-file-atomic / csv-parse should live in package.json; fresh clones silently rely on
`bun add`).

---

## OPEN / HANDOFF — measurements left "verify next run"

Carrying these forward explicitly so they don't get dropped the way jun-19's find_references + verify-
select-capture continuity did:

- **box-pool live EC2 run** (Cluster 1) — mandatory before trusting pool throughput numbers.
- **verify-select-regression=`discovered` A/B** — the convergent #1 lever now has substrate. Needs a
  COMPLETE single-pass control + n≥50 on a MEDIUM slice (small-n = noise, per four converging threads).
  Readout: SelectionTelemetry sidecar (Cluster 4).
- **RCA #1 (python-version fix)** — `reproTest` success 54%→? unmeasured (LLM-free, next run).
- **RCA #2 (`no_reproduced_candidate`, 78 instances)** — OPEN; lever = adversarial-repro / better repro
  prompt, not yet built. See `[[jun-20-repro-gen-python-version-rca]]`.
- **M0b regrade** — killed by sweep contention; non-critical but incomplete.
- **coverage sweep** — ~149 of 431 non-CEILING universe remaining; 6 hung instances parked for slice=1
  isolated retry.

**Convergent #1 for next session:** ceiling = fix-generation quality; the **resolved oracle (not the
gate) is the bottleneck** → top lever = executable-regression-suite-gated candidate selection +
multi-site completeness check. The afternoon sprint built the substrate; the live A/B is the next move.
