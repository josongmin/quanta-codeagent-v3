# P6 — SWE Hidden-Grader (`grader-only` verify strategy)

Resolve a MEASURED prompt contradiction that makes the agent wobble in SWE-bench /
hidden-grader runs. Grounded in `docs/evidence/jul-5-prompt/` (real captured prompts) and
adversarially+objectively audited before commit. Fits the jul-4 3-axis prompt model — this is the
unfinished half of the VERIFY axis, not a new mechanism.

Parent: `docs/plans/jul-5-sota-runtime-kernel/` (P6 summary). This is the detailed plan.

## 0. SOTA++ verdict

This repo's SOTA++ direction here is **not** "add another prompt overlay."

- absorb hidden-grader into the existing VERIFY axis as `verifyStrategy:"grader-only"`
- make the L1/L2 system prompt the SSOT for verify posture
- delete duplicated/contradictory hidden-grader verify prose from the L8 bench directive path
- preserve DEFAULT-OFF byte identity, then measure the lever; if flat, delete only the text lever

## 1. Problem (measured)

The real SWE run prompt carries contradictory orders in one turn (Policy stack ranks system L1 > user L8):

- **system body (L1, `src/agent/prompt-body.ts`)**
  - Operating-principles L61: *"When (and ONLY when) fixing a defect: **first reproduce the failure** with the smallest failing case"*
  - Completion-bar (`BODY_AFTER_PROMPT_PACK`): *"finish only when … **verified** — it builds/type-checks, and the relevant **tests pass**"*
- **user injection (L8, `src/runner/batch/eval/driver/prompt-directives.ts`)**
  - *"Do NOT run the test suite, pytest, tox … an **unverified edit is fine — the grader decides**"* (L147-148) + no-test-edit / smallest-diff / no-destructive-git

Because L1 > L8, the model is pulled toward "reproduce + verified-only completion" and either (a) runs
the forbidden pytest or (b) can't satisfy "verified" and ends ambiguously. Confirmed against
`docs/evidence/jul-5-prompt/00-main-coding-agent-turn1.txt` (L468-485) vs `11-render-swe-batch.txt`
(L37/L386).

## 2. Audit findings (adversarial + objective, code-verified)

- **[CORRECTION] body split is already half-done.** `prompt-body.ts` already splits into named section
  constants, and the completion bar is ALREADY isolated as `BODY_AFTER_PROMPT_PACK_COMPLETION_BAR`.
  The remaining hardcoded conflict is the repro clause still embedded inside
  `BODY_AFTER_PERSONA_OPERATING_PRINCIPLES` (L61-64). ⇒ Phase 0 is NOT "extract both"; it is
  "extract only the repro-required slice and make completion suppressible by reusing the existing
  completion-bar constant."
- **[GAP] conflict is not only body↔user.** `prompt-directives.ts` has MULTIPLE hidden-grader variants
  (L73/118/168) and an INTERNAL contradiction — L65 *"Verify both before you stop"* vs L147 *"Do NOT run
  pytest/tox"* coexist in the user injection. Fixing the body alone is insufficient; the directive SSOT
  needs consolidation too. The cleanup must be SUBTRACTIVE: remove duplicated verify posture, but keep
  legitimate task-shape rules like source-only / smallest-diff / no-destructive-git.
- **[GAP] clashes with the VERIFY axis.** `verify-strategy.ts` already has `reproduce-first` (reproduce!)
  which is the OPPOSITE of hidden-grader (do NOT reproduce/pytest). Two independent knobs ⇒ a nonsense
  `reproduce-first ON + hidden-grader ON` state. ⇒ NO new standalone knob and NO new task-pack axis —
  make hidden-grader a THIRD VerifyStrategy value `grader-only`, mutually exclusive with
  `reproduce-first` by type.
- **[GAP] observability/type SSOT also has to widen.** `PromptSurfaceVerifyStrategy` currently allows only
  `none | reproduce-first | verify-after-edit`, and prompt-surface snapshots record that enum. If the
  live prompt is `grader-only` while telemetry still says `none`, the measurement rail lies. ⇒ widen the
  snapshot types/builders together with the prompt rule.
- **[GAP] A/B n=1 resolved-rate is noise.** Baseline is a single instance (`psf__requests-5414`). Per
  measure-first, widen to picks-3/10 with model + throttle pinned, and score prompt-conflict symptoms
  too (`pytest` attempts, premature "done/verified" claims, empty-patch aborts) rather than resolved
  count alone.

## 3. Final plan (phases)

### Phase 0 — finish the body split (byte-identical refactor)
- `BODY_AFTER_PERSONA_OPERATING_PRINCIPLES` L61-64 → new `BODY_REPRO_REQUIRED` constant.
- Reuse existing `BODY_AFTER_PROMPT_PACK_COMPLETION_BAR`; do NOT re-extract what is already isolated.
- Assembly order unchanged when `verifyStrategy` is absent ⇒ all 5 target prompts sha256-unchanged.

### Phase 1 — hidden-grader as VerifyStrategy `grader-only`
- `VerifyStrategy = "reproduce-first" | "verify-after-edit" | "grader-only"` + `GRADER_ONLY_RULE`
  (Do-not / Do / Stop-when / Final-format command form; no-leak — mentions the grader only in a forbid
  clause, never "read the hidden test").
- `buildSystemPrompt`: when `verifyStrategy==="grader-only"`, SUPPRESS `BODY_REPRO_REQUIRED` +
  `BODY_AFTER_PROMPT_PACK_COMPLETION_BAR` and splice the grader-only rule block; any other value ⇒
  byte-identical. Type makes
  `reproduce-first` and `grader-only` mutually exclusive (single axis value).
- This is an ABSORPTION into the existing verify slot, not a second prompt-pack family.

### Phase 2 — directive SSOT consolidation + wiring
- When `grader-only` is active, config-build stops emitting the redundant hidden-grader Hard-rules from
  `prompt-directives.ts` (the L1/L2 verify slot is the SSOT) and removes the internal L65↔L147
  contradiction from the SWE directive variants.
- Keep only NON-verify task-shape rules in `prompt-directives.ts` on the hidden-grader path:
  source-only, smallest-diff, no destructive git, apply-patch format. Do NOT leave a second copy of
  "do not run pytest / grader decides / unverified edit is fine" in the user injection.
- Knob `QUANTA_SWE_HIDDEN_GRADER` → sets the SWE profile's `verifyStrategy:"grader-only"` (like
  `QUANTA_BENCH_REPRODUCE_FIRST` does today). DEFAULT-OFF ⇒ byte-identical to current.
- Widen prompt-surface snapshot SSOT so `promptSurfaceProfile.verifyStrategy` can honestly report
  `"grader-only"` during measurement.

### Phase 3 — hellgate
- RED e2e: pin the conflict exists now, AND that `grader-only` ON suppresses repro/completion + renders
  the rule + drops the directive duplicate.
- byte-identical: 5-target sha256 unchanged when the knob is OFF (Phase 0 refactor + Phase 1 absent path).
- no-leak: `GRADER_ONLY_RULE` forbids seeking hidden/grader/reference tests; RED if the clause is dropped.
- snapshot honesty: prompt policy / assembled-prompt observability must emit `verifyStrategy:"grader-only"`
  when active, never `"none"`.
- knob-inventory register; god-ratchet + tsc.
- adversarial audit ≥3R (conflict fully resolved / no-leak / OFF regression) + self-audit.

### Phase 4 — A/B (measure-first)
- picks-3 (or picks-10), same model, same throttle, same repro-hint posture, trajectory recorded.
- Primary score = prompt-conflict symptom reduction: forbidden `pytest`/`tox` attempts, premature
  "verified/done" claims without a permitted check, empty-patch/no-patch aborts.
- Secondary score = submitted-patch rate and resolved rate on the same picks.
- If it doesn't move: delete the rule text only — the 3-axis `grader-only` value + body-block extraction stay
  (structure is net-positive regardless).

## 4. File map

| file | change |
|---|---|
| `src/agent/prompt-body.ts` | extract `BODY_REPRO_REQUIRED`; reuse existing `BODY_AFTER_PROMPT_PACK_COMPLETION_BAR` |
| `src/agent/prompt-rules/verify-strategy.ts` | `grader-only` value + `GRADER_ONLY_RULE` |
| `src/agent/prompt-rules/index.ts` | `renderVerifyStrategy` arm for grader-only |
| `src/agent/prompt.ts` | suppress `BODY_REPRO_REQUIRED` + `BODY_AFTER_PROMPT_PACK_COMPLETION_BAR` when grader-only; render the rule block |
| `src/agent/surface-profile.ts` | (verifyStrategy already threaded) |
| `src/shared/turn-policy-types.ts` | widen `PromptSurfaceVerifyStrategy` snapshot enum with `"grader-only"` |
| `src/agent/system-prompt/default-builder.ts` | keep prompt-surface snapshot builders honest for `grader-only` |
| `src/runner/batch/eval/driver/config-build.ts` | `QUANTA_SWE_HIDDEN_GRADER` → grader-only; drop duplicate directive |
| `src/runner/batch/eval/driver/prompt-directives.ts` | remove internal L65↔L147 conflict on grader path; keep only task-shape rules |
| tests | verify-strategy.test (grader-only), prompt byte-identical, directive-conflict, snapshot-honesty, e2e wiring |

## 5. Guards

- DEFAULT-OFF, byte-identical when off (5-target sha256).
- No new standalone knob and no new task-pack family — one VERIFY axis, three values;
  `grader-only` ⊥ `reproduce-first` by type.
- No-leak: grader mentions live only in forbid clauses.
- Directive cleanup is subtractive: remove duplicated verify posture, keep only legitimate task-shape rules.
- Do-not lists only true prohibitions (over-listing reduces action); Do lists the desired route.
- Observability must stay honest: if `grader-only` is active, snapshots cannot report `none`.
- measure-first: land default-OFF, A/B on ≥3 picks, prioritize symptom reduction, delete text lever if flat.
- Land on origin/main per phase; local main is now synced (direct commit/push, no checkout-only workaround).

## 6. Self-audit closeout (clean-until-green, jul-5)

Ran the self-audit to CLEAN with TDD/scenario regression guards at each step. Findings + fixes:

- **R4 — residual body conflict (REAL, fixed).** grader-only suppressed repro + completion-bar but
  the structured `BODY_AFTER_PROMPT_PACK_VERIFICATION_REPORT` block ("rail: pytest / verdict / exit")
  still rendered — it presupposes a local run grader-only forbids. Added it to the suppress set
  (`prompt.ts` `withoutLines([...VERIFICATION_REPORT, ...COMPLETION_BAR])`). grader-only supplies its
  own honest Final ("verification: not run"). Guard: a codified render-scan asserts ZERO
  local-verification DEMANDS survive grader-only, with a `reproduce-first` control proving the scan is
  non-vacuous (control keeps all 6 demands).
- **R4b — pre-existing snapshot red DISPROVEN (not P6).** `prompt-rules-snapshot.test.ts` pinned the
  old R-ENV phrasing ("Do NOT attempt to install dependencies"); jul-3 audit `ea787de4a` reworded it.
  Verified NOTHING machine-parses the string (R-ENV is a model-read short-circuit) → synced the stale
  pin to the current byte-identical-baselined wording + corrected the misleading "bench parses" comment.
- **R5 — two-surface coherence (REAL, fixed).** grader-only is system-side, but the USER directive
  carries its own verify posture via `inLoopExecMode` (default FULL = "run the tests, an unverified edit
  is the #1 cause of failure"). The two knobs were independent ⇒ `grader-only ON + default FULL` would
  re-create the exact L1↔L8 conflict on the user surface. Fix: grader-only DRIVES the directive to
  NOEXEC in `buildPromptText` — one decision, both surfaces coherent. This SUPERSEDES §4's planned
  subtractive `prompt-directives.ts` text deletion (mode-selection reuses the existing NOEXEC variant,
  no risky text surgery, OFF stays byte-identical). Guard: coherence wiring test with mutually-exclusive
  posture strings (ON⇒NOEXEC "unverified edit is fine"; OFF⇒FULL demand) = non-vacuous.
- **knob-orphan (registry completeness, fixed).** `QUANTA_SWE_HIDDEN_GRADER` (P6) AND its jul-4 sibling
  `QUANTA_BENCH_REPRODUCE_FIRST` were both orphan reads (declared in no registry) — the ADR-0503 gate
  was already red at 1 from jul-4; P6 made it 2. Both are bench-only verify-axis toggles read via
  `gateOn` at the eval-driver composition root (not the typed registry their sibling
  `QUANTA_BENCH_IN_LOOP_EXEC` uses), so registered them in the ratchet EXCEPTIONS with reasons
  (same class as the cost/health/host-monitor bench toggles). Orphans 2 → 0.

Clean state: P6 prompt+config suite 115/0, byte-identical 5-target ✓, tsc src ✓, knob-orphans 0/0.
Out-of-scope pre-existing reds left untouched (user in-flight): god-code `brain-mode.ts` /
`web-daemon/runtime-factory.ts`, and `with-temperature` / `turn-outcome` test typecheck.

## 7. Final audit (jul-6) — the conflict SHIPS; make coherence structural (F1)

Adversarial audit of the real captured prompt (`docs/evidence/jul-5-prompt/00-…txt`) found the
grader-only fix was **opt-in only**, so the measured conflict still SHIPPED in production:

- **F1 (REAL, shipped bug, fixed).** `bench-in-loop-exec` and the verify posture were INDEPENDENT
  knobs. Two shipped presets (`agentless-v3-thin-strict`, `agentless-v5-thin-and-expanded`) and a
  capability profile set `bench-in-loop-exec: off`, which emits the **NOEXEC** user directive ("do
  NOT run pytest — the grader owns verification"). But the SYSTEM still carried its verify demands
  (Completion bar / Verification report / "run the project's tests" / reproduce-first) ⇒ the EXACT
  captured L1↔L8 conflict shipped in those presets whenever `QUANTA_SWE_HIDDEN_GRADER` was not also
  set by hand. Fix: **exec-mode is the SSOT for verify posture** — `config-build.sweVerify` now
  derives `grader-only` from `opt.inLoopExecMode === "off"` (in addition to the explicit knob). So
  exec=off ⇒ coherent grader-only system automatically, no opt-in required. exec=full ⇒ unchanged
  (body verify demands + FULL "run the tests" directive already agree) ⇒ byte-identical. The
  explicit knob still forces grader-only under any exec mode (R5 then drives the directive to NOEXEC).
  Guard: `F1` wiring test (exec=off + NO knob ⇒ both surfaces coherent grader-only+NOEXEC; exec=full
  control ⇒ no grader rule + verify demands intact, non-vacuous). End-to-end re-audit renders the real
  exec=off config and asserts 0 verify-DEMAND lines on BOTH surfaces (control exec=full keeps 4 system
  + 2 user demands, proving the scan is live).
- **F2 (R-NO-EXPLORE-OVER-EDIT "…coherent edit and a verify step"), assessed BENIGN, not changed.**
  Under grader-only "a verify step" reads oddly, BUT `R-GRADER-ONLY` renders AFTER the batch task rule
  (task axis → verify axis) with an explicit "Stop when: the minimal source patch is applied" that
  supersedes it; the live smoke stopped cleanly at 9 turns with no thrash. A byte-identical-safe fix
  would require coupling the 3 independent axes or a mid-line splice for marginal gain — deferred.
- **F3 (R-ENV "e.g. `PYTHONPATH=. pytest`" example), assessed BENIGN, not changed.** A scoped-env
  SYNTAX example in the shared frozen env rule; grader-only's explicit "Do NOT … pytest" is the
  specific rule and governs. Touching R-ENV breaks the frozen/batch byte-identical baseline.

Final-audit clean state: prompt+config suite 117/0, byte-identical 5-target ✓, tsc src ✓,
exec=off end-to-end coherence re-audit ✓ (0 conflict lines, non-vacuous control).
