# Sonar Absorption + Quanta Hardening — SOTA Plan (2026-06-20)

## North star
Close the **measured** frontier gap on SWE-bench Verified by fixing the failure
modes we OBSERVED this session — not by prompt-hacking the ceiling. Four levers,
each grounded in a measured gap + an external SOTA datapoint (Sonar Foundation
Agent technical report, #1 at 79.2% Verified w/ Opus-4.5).

Source of truth for "what frontier does": Sonar tech report (audited 2026-06-20 —
verdict: real reusable methodology, not PR). Three techniques hit our exact gaps.

---

## Methodology discipline (LEARNED this session — binds ALL phases)
0. **A knob is NEVER a destination.** default-OFF is measurement scaffolding ONLY.
   After the A/B, EVERY knob resolves to exactly one of: **default-ON** (it won) or
   **DELETED** (it didn't). No permanent-OFF limbo — an OFF-forever knob is dead
   code. SIMPLICITY already completed the cycle (OFF → validated → default-ON).
   EXCEPTION: a pure SAFETY net (can only help or be neutral, never worse — e.g.
   P0 tentative-retention: emitting best-of instead of a regressed/empty patch on
   exhaustion) ships **default-ON the moment regression==0 is confirmed**; its A/B
   only measures HOW MUCH it recovers, not whether to keep it.
0b. **TYPE-MATCHED comparison — the ONLY valid A/B.** Do NOT A/B on random
    instances. For each lever, build the comparison set from instances that
    (a) currently FAIL, AND (b) are the SPECIFIC TYPE the lever targets — using
    the GOLD ORACLE to (i) classify the failure type (is the fail actually this
    type?) and (ii) verify the lever's output is the RIGHT fix, not just a pass.
    Then ON-vs-OFF on that set; adopt the winner. A lever that helps its own
    target type but is neutral elsewhere still WINS (so the set must be the type,
    not the full benchmark). Per-lever target sets:
      - P0 tentative: instances that hit `max_turns_exhausted` where the gold
        oracle shows a correct patch WAS reachable mid-run (it regressed/emptied).
      - P1 AST: instances where localization failed under pyright warm-up
        exhaustion / cross-file (matplotlib-25479, multi-file ceiling).
      - P2 lean: instances where the verbose prompt drove over-exploration /
        over-engineering / max_turns (gold shows a small fix the agent overshot).
1. **Every lever is knob-gated, default-OFF, A/B'd vs baseline.** No exceptions.
2. **Attribution requires ABLATION.** "Ran it ON and it passed" ≠ "it helped"
   (the "10 green from one steer" overclaim → ablation showed only 2 causal).
   Toggle OFF, re-grade the SAME instances.
3. **Grade on EC2 only** (local has no docker → unreliable; local 0/9 was EC2 8/9).
   Terminate the spot box after EVERY grade; verify "today boxes up: 0".
4. **Adversarial audit before any "solved" claim** (3-round audit caught 2 of my
   over-claims: "all ceiling is multi-file" → only 53%; "LSP can't bridge" →
   siblings often symbol-reachable, agent just under-uses LSP).
5. **Stop a lever after 2 negative rounds.** Lever A (sibling steer) v1+v2 both
   0/6 → stopped. No rabbit-holing (the 13417 micro-opt trap).
6. **Patch hygiene**: source-only, strip binary + test + agent-created repro junk
   before grading (binary-strip already landed; junk-.py strip still open — P0.5).

---

## Current bench profiles (live code, 2026-06-20)
- `agentless-v3-thin-strict` = CURRENT base profile. Mini-first, noexec, hard
  patch-budget admission, and source-focused generation. This is the default
  measurement base for SOTA++ work.
- `agentless-v3-select-regression` = CURRENT no-oracle selection arm. Starts
  from `v3-thin`, adds `verify-select:5`, discovered native repo-test regression
  gating, and `verify-select-repro=positive` (generated repro becomes soft-only,
  never a hard reject).
- `agentless-v3-thin-strict-closure-select` = STRUCTURAL selection arm. Uses
  noexec/mini candidate generation, strict patch-budget admission,
  ClosureBundle owner authority, discovered regression, positive-only repro
  signal, and early accept. This is the preferred selector substrate before any
  default-profile promotion.
- `agentless-v3-select-regression-doubt` = TARGETED `verify_loop_stuck` arm.
  Same as `select-regression`, plus `repro-doubt:5` to break post-edit test
  rerun churn when the repro oracle is likely false-negative.
- `QUANTA_BENCH_TENTATIVE` is NOT a profile: it is a safety-net gate in the
  driver, and is now default-ON once regression==0 was confirmed.
- `QUANTA_BENCH_LEAN_PROMPT` stays an A/B gate, NOT a profile. First measured
  result was neutral on the 5-case max-turns set, so do not fold it into the
  base profile.

### Immediate measurement protocol (picked, not brainstorming)
- **Smoke 1 — selection-sensitive recoverable**
  - instance: `sympy__sympy-12096`
  - dataset: [select-regression-smoke.sympy-12096.jsonl](/Users/songmin/quanta-codeagent-v3/docs/plans/jun-20-sonar-absorption/slices/select-regression-smoke.sympy-12096.jsonl)
  - control: `agentless-v3-thin-strict`
  - treatment: `agentless-v3-thin-strict-closure-select`
  - why this case: prior telemetry already showed a candidate-selection delta
    (`minimal single-file` vs `3-file over-broad`), so it is the cleanest first
    smoke for the outer selection plane rather than the repro-doubt guard.
  - run ids:
    - `v3sel-smoke-sympy12096-ctl`
    - `v3sel-smoke-sympy12096-trt`
  - commands:
    ```sh
    QUANTA_RUN_ID=v3sel-smoke-sympy12096-ctl QUANTA_BENCH_PRESET=agentless-v3-thin-strict \
      bun run src/apps/bench/cli.ts run \
      --swebench docs/plans/jun-20-sonar-absorption/slices/select-regression-smoke.sympy-12096.jsonl \
      --model gpt-5.4

    QUANTA_RUN_ID=v3sel-smoke-sympy12096-trt QUANTA_BENCH_PRESET=agentless-v3-thin-strict-closure-select \
      bun run src/apps/bench/cli.ts run \
      --swebench docs/plans/jun-20-sonar-absorption/slices/select-regression-smoke.sympy-12096.jsonl \
      --model gpt-5.4
    ```
  - readout: `resolved`, `turns`, `selectionTelemetry.candidates/admissible/winner`,
    and whether the chosen patch stays narrow.

- **Smoke 2 — verify_loop_stuck / repro-oracle doubt**
  - instance: `django__django-10999`
  - dataset: [select-regression-doubt-smoke.django-10999.jsonl](/Users/songmin/quanta-codeagent-v3/docs/plans/jun-20-sonar-absorption/slices/select-regression-doubt-smoke.django-10999.jsonl)
  - control: `agentless-v3-select-regression`
  - treatment: `agentless-v3-select-regression-doubt`
  - why this case: this is the clean anchoring-trap / `verify_loop_stuck` case.
    Measuring `repro-doubt` on a non-stuck instance would just add noise.
  - run ids:
    - `v3doubt-smoke-dj10999-ctl`
    - `v3doubt-smoke-dj10999-trt`
  - commands:
    ```sh
    QUANTA_RUN_ID=v3doubt-smoke-dj10999-ctl QUANTA_BENCH_PRESET=agentless-v3-select-regression \
      bun run src/apps/bench/cli.ts run \
      --swebench docs/plans/jun-20-sonar-absorption/slices/select-regression-doubt-smoke.django-10999.jsonl \
      --model gpt-5.4

    QUANTA_RUN_ID=v3doubt-smoke-dj10999-trt QUANTA_BENCH_PRESET=agentless-v3-select-regression-doubt \
      bun run src/apps/bench/cli.ts run \
      --swebench docs/plans/jun-20-sonar-absorption/slices/select-regression-doubt-smoke.django-10999.jsonl \
      --model gpt-5.4
    ```
  - readout: `resolved`, `turns`, failure classifier (`verify_loop_stuck` present
    or absent), and whether the treatment escapes churn without introducing a
    wrong broad patch.

- **Promotion rule (unchanged)**: these 2 smokes are only substrate checks. Do
  **NOT** promote either arm from smoke wins alone. Promotion still requires a
  COMPLETE control and `n>=50` on a MEDIUM slice.

---

## Phase 0 — Stop the bleeding: tentative-patch retention  〔Sonar #1, highest ROI〕
**Measured gap**: agent finds the correct fix, then burns the rest of its turns
trying to verify it locally (no test env) → `max_turns_exhausted` with whatever
is in the tree (often regressed/empty). Seen on 13417, matplotlib-22719, and
across both ceiling runs.

**Sonar (verbatim)**: *"the agent is encouraged to save tentative patches…
Otherwise, the agent would often run out of reasoning steps while trying to
validate a tentative patch, thus forced to terminate without giving an answer."*

**Design**: harness-level best-candidate retention (NOT a prompt).
- Snapshot the source diff (`sourceOnlyDiff(gitStageAndDiffCached())`) at each
  *verification-pass* event (verifyGuard already detects pass) AND at each
  successful edit as a fallback.
- Keep a ranked best: prefer (verified-green, smallest non-empty diff).
- On `max_turns_exhausted` / abort, EMIT the best tentative instead of the final
  tree. Clean runs (agent finishes normally) → final == best → byte-identical.
- Hook: [driver.ts](../../../src/runner/batch/eval/driver.ts) around
  `withGitSnapshot` (L1373/L1522) + the agent loop; tie snapshot to the
  verifyGuard pass signal (session-resources verifyGuardState).
- Knob: `QUANTA_BENCH_TENTATIVE` (default-OFF for A/B).

**Risk**: low — additive; only changes the emitted patch on exhaustion.
**Success**: re-run the instances that hit max_turns; tentative ≥ final on EC2,
0 regression on clean finishers. Ablation: OFF re-grade same set.

### Phase 0.5 — junk-.py hygiene (cheap, rides along)
pylint-4604 left `reproduce_issue.py`, `tmp_repro_*.py` in the patch. Extend the
patch sanitizer to drop agent-created top-level non-package `.py` files (repro
scripts) — but NEVER drop a path that's inside a package dir (gold can add new
source). SSOT next to `isTestFilePath` / binary-strip.

---

## Phase 1 — Localization: AST symbol index  〔Sonar #2〕
**Measured gap**: pyright LSP warm-up EXHAUSTS on big repos (matplotlib pyplot.py,
90s budget blown) → the steer-requested LSP traversal fails; agent under-uses LSP
(1-2 calls). Localization to the OWNER is good, but cross-file/symbol discovery is
throttled by pyright cost.

**Sonar (verbatim)**: *"An index of the classes and functions is built at the
beginning by parsing the whole codebase with treesitter… AST Search is often more
efficient than grep, saving reasoning steps."* — no LSP, no warm-up, built once.

**Design**:
- We ALREADY have `astGrepTool` (gate `QUANTA_AST_GREP`, default-OFF). Step 1:
  turn it ON for bench + measure.
- Step 2 (if needed): build a tree-sitter class/function index at sandbox setup;
  expose a `symbol_search(name)` tool that returns definition sites across the
  whole repo in one call (no per-file pyright warm-up).
- This REPLACES the role pyright nav was meant to play for symbol lookup; keep
  pyright only where it adds (diagnostics), or drop it for bench if AST wins.
- Knob: `QUANTA_BENCH_AST_INDEX` (A/B vs pyright-nav).

**Risk**: medium — competes with the LSP investment; must measure head-to-head.
**Success**: on the pyright-exhaustion instances (matplotlib etc.), AST-index arm
matches OWNER localization with 0 warm-up stalls AND surfaces cross-file siblings
more often than the LSP arm. Ablation vs current.

---

## Phase 2 — Autonomy calibration: lean-prompt A/B  〔Sonar #4, contrarian〕
**Sonar measured**: two-stage 58% → free-workflow 70% → **less-prescriptive +
extended-thinking 75%**. *"the prompt was so detailed that … the agent would
largely do the same things"* — detailed prompts CAP thinking models (Claude's own
prompting guide).

**Tension with us**: our prompt is verbose — `SWEBENCH_DIRECTIVE` + `lsp-steer` +
`spec-steer` + `SIMPLICITY` + repro prose. This may cap gpt-5.4.

**Design**: a `lean` directive arm = Sonar's 3 principles only:
  1. test-driven (reproduce → fix → verify w/ reproducer + autonomously-discovered
     regression tests; NO PASS_TO_PASS/FAIL_TO_PASS metadata),
  2. high-level (adapt to task complexity; reproduction / code-inspection / test-
     analysis as the agent sees fit),
  3. no SWE-bench overfit.
A/B `lean` vs current `verbose` on a stratified sample. Keep SIMPLICITY's
*content* (small-patch bias — Sonar's patch-size data CONFIRMS it) but fold it
into the lean principles rather than as a bolt-on steer.

**Risk**: low (prompt); result genuinely uncertain (gpt-5.4 may want MORE
structure than Opus-4.5 — that's exactly why we measure).
**Success**: clear A/B winner on the stratified sample; adopt the winner.

---

## Phase 3 — Capability measurement: stratified sample  〔answers "where do we stand"〕
We have NO honest full-500 number. Build one:
- Stratified random ~40 instances across difficulty tiers (E/M/H + a few ceiling),
  drawn from the real `swe-bench/experiments` resolved-rate distribution.
- Run quanta (best config from P0-P2) + grade on EC2 → a CI'd capability estimate.
- Cross-check the fails with the ladder (mini → OpenHands) to classify
  scaffold-loss vs model-ceiling.
- Output: "quanta ≈ X% (±CI) on Verified, vs OpenHands-claude4 ~70%; model gap vs
  Opus-4.5 explicit." Honest, defensible, finally a real number.

---

## Phase 4 — Consolidate
- Promote the A/B-winning levers to default-ON (with off-switch), like SIMPLICITY.
- Update `docs/swebench-leaderboard.yaml` with honest attribution per lever.
- Commit (user-gated): the session's landed changes + Sonar-absorbed levers.

---

## Explicitly DROPPED (negative results — do not revive without new evidence)
- **Lever A sibling-steer (prompt)**: v1+v2 both 0/6. Sonar has NO special
  cross-file mechanism — the ceiling is AST-search + autonomy + a strong model,
  not a sibling prompt. Localization improvement = Phase 1 (AST), not a steer.
- **Prompt-only ceiling cracking**: insufficient (measured). The 32 true-ceiling
  is partly model (Sonar GPT-5 70.8% vs Opus-4.5 79.2%) — not closeable by
  scaffold alone at gpt-5.4.

## Already LANDED this session (keep; do not redo)
- **binary-strip** patch sanitizer (recovered 7166/7336 — real bug).
- **SIMPLICITY** steer → DEFAULT-ON (2 causal flips 13417/24562; Sonar small-patch
  data independently confirms the direction).
- **test-scope guard** (enforces no-test-edit; 6 hellgate + 70 regression green).
- **OpenHands/mini/Live** local ceiling scaffolds (oh-login/mini-login/live-login)
  + the `/v1/responses` proxy bridge.

## Sequencing
P0 (tentative) → P0.5 (junk hygiene) → P1 + P2 in parallel A/B → P3 (capability) →
P4 (consolidate). P0 first: cheapest, fixes the most-observed loss, Sonar flags it
as "without this the agent gives no answer."

---
## P2 lean — first measurement (2026-06-20, by the measurement track)
P2 (lean-prompt) was BUILT by the parallel code track (`QUANTA_BENCH_LEAN_PROMPT`,
`SWEBENCH_DIRECTIVE_LEAN`). Measured it (non-colliding: their code, my grade) on
the 5 max_turns-prone set, EC2:
- LEAN: 2/5 (13417, matplotlib-22719) — IDENTICAL to the verbose baseline 2/5.
VERDICT: NEUTRAL — no regression (the audit's "gpt-5.4 wants more structure → lean
hurts" worry did NOT materialize), but no gain either: this set does not
DISCRIMINATE lean (the 2 passes pass under both; the 3 fails are 32-ceiling,
fail under both). Sonar's +17% not reproduced HERE. Proper P2 A/B needs a
type-matched OVER-PROMPTING set (gold = small fix; verbose drove over-
exploration/max_turns; lean lets the model converge). Follow-up.
