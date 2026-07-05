# P6 — SWE Hidden-Grader Pack (prompt mode-conflict resolution)

Resolve a MEASURED prompt contradiction that makes the agent wobble in SWE-bench /
hidden-grader runs. Grounded in `docs/evidence/jul-5-prompt/` (real captured prompts) and
adversarially+objectively audited before commit. Fits the jul-4 3-axis prompt model — this is the
unfinished half of the VERIFY axis, not a new mechanism.

Parent: `docs/plans/jul-5-sota-runtime-kernel/` (P6 summary). This is the detailed plan.

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

- **[CORRECTION] "body is one blob" was wrong.** `prompt-body.ts` already splits into 12 named section
  constants (`BODY_AFTER_PERSONA_OPERATING_PRINCIPLES`, `_GIT_POSTURE`, …); only the *assembly* is flat.
  But repro is 2 lines INSIDE `OPERATING_PRINCIPLES` (L61-62) and completion is a block inside
  `BODY_AFTER_PROMPT_PACK` — gating the whole section would also drop unrelated rules
  (read-before-edit etc.). ⇒ extract just those two blocks into their own constants (smaller than the
  original estimate; sections already exist).
- **[GAP] conflict is not only body↔user.** `prompt-directives.ts` has MULTIPLE hidden-grader variants
  (L73/118/168) and an INTERNAL contradiction — L65 *"Verify both before you stop"* vs L147 *"Do NOT run
  pytest/tox"* coexist in the user injection. Fixing the body alone is insufficient; the directive SSOT
  needs consolidation too.
- **[GAP] clashes with the VERIFY axis.** `verify-strategy.ts` already has `reproduce-first` (reproduce!)
  which is the OPPOSITE of hidden-grader (do NOT reproduce/pytest). Two independent knobs ⇒ a nonsense
  `reproduce-first ON + hidden-grader ON` state. ⇒ NO new standalone knob — make hidden-grader a THIRD
  VerifyStrategy value `grader-only`, mutually exclusive with `reproduce-first` by type.
- **[GAP] A/B n=1 is noise.** Baseline is a single instance (psf__requests-5414). Per measure-first,
  widen to picks-3/10 with model + throttle pinned before drawing any conclusion.

## 3. Final plan (phases)

### Phase 0 — extract body blocks (byte-identical refactor)
- `OPERATING_PRINCIPLES` L61-62 → new `BODY_REPRO_REQUIRED` constant.
- Completion block in `BODY_AFTER_PROMPT_PACK` → new `BODY_COMPLETION_BAR` constant.
- Assembly order unchanged ⇒ all 5 target prompts sha256-unchanged (this is the concrete "body
  slot-ification" — localized because section constants already exist).

### Phase 1 — hidden-grader as VerifyStrategy `grader-only`
- `VerifyStrategy = "reproduce-first" | "verify-after-edit" | "grader-only"` + `GRADER_ONLY_RULE`
  (Do-not / Do / Stop-when / Final-format command form; no-leak — mentions the grader only in a forbid
  clause, never "read the hidden test").
- `buildSystemPrompt`: when `verifyStrategy==="grader-only"`, SUPPRESS `BODY_REPRO_REQUIRED` +
  `BODY_COMPLETION_BAR` and splice the grader pack; any other value ⇒ byte-identical. Type makes
  `reproduce-first` and `grader-only` mutually exclusive (single axis value).

### Phase 2 — directive SSOT consolidation + wiring
- When `grader-only` is active, config-build stops emitting the redundant hidden-grader Hard-rules from
  `prompt-directives.ts` (the L2 pack is the SSOT) and removes the internal L65↔L147 contradiction from
  the SWE directive variants.
- Knob `QUANTA_SWE_HIDDEN_GRADER` → sets the SWE profile's `verifyStrategy:"grader-only"` (like
  `QUANTA_BENCH_REPRODUCE_FIRST` does today). DEFAULT-OFF ⇒ byte-identical to current.

### Phase 3 — hellgate
- RED e2e: pin the conflict exists now, AND that `grader-only` ON suppresses repro/completion + renders
  the pack + drops the directive duplicate.
- byte-identical: 5-target sha256 unchanged when the knob is OFF (Phase 0 refactor + Phase 1 absent path).
- no-leak: `GRADER_ONLY_RULE` forbids seeking hidden/grader/reference tests; RED if the clause is dropped.
- knob-inventory register; god-ratchet + tsc.
- adversarial audit ≥3R (conflict fully resolved / no-leak / OFF regression) + self-audit.

### Phase 4 — A/B (measure-first)
- picks-3 (or picks-10), model + throttle pinned, trajectory recorded.
- Re-measure baseline (`grader-only` OFF) + `grader-only` ON on the same picks; compare resolved rate.
- If it doesn't move: delete the pack only — the 3-axis `grader-only` value + body-block extraction stay
  (structure is net-positive regardless).

## 4. File map

| file | change |
|---|---|
| `src/agent/prompt-body.ts` | extract `BODY_REPRO_REQUIRED` + `BODY_COMPLETION_BAR` (byte-identical) |
| `src/agent/prompt-rules/verify-strategy.ts` | `grader-only` value + `GRADER_ONLY_RULE` |
| `src/agent/prompt-rules/index.ts` | `renderVerifyStrategy` arm for grader-only |
| `src/agent/prompt.ts` | suppress body blocks when grader-only; splice pack |
| `src/agent/surface-profile.ts` | (verifyStrategy already threaded) |
| `src/runner/batch/eval/driver/config-build.ts` | `QUANTA_SWE_HIDDEN_GRADER` → grader-only; drop duplicate directive |
| `src/runner/batch/eval/driver/prompt-directives.ts` | remove internal L65↔L147 conflict on grader path |
| tests | verify-strategy.test (grader-only), prompt byte-identical, directive-conflict, e2e wiring |

## 5. Guards

- DEFAULT-OFF, byte-identical when off (5-target sha256).
- No new standalone knob — one VERIFY axis, three values; `grader-only` ⊥ `reproduce-first` by type.
- No-leak: grader mentions live only in forbid clauses.
- Do-not lists only true prohibitions (over-listing reduces action); Do lists the desired route.
- measure-first: land default-OFF, A/B on ≥3 picks, delete pack if flat (keep structure).
- Land on origin/main per phase; local main is now synced (direct commit/push, no checkout-only workaround).
