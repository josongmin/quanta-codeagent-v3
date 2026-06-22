# Jun 22 - agentless-v5-thin-and-expanded

Related:

- [jun-21 heuristic authority cleanup](../jun-21-heuristic-authority-cleanup/README.md)
- [jun-21 contaminated / ambiguous cases](../jun-21-heuristic-authority-cleanup/contaminated-cases.md)
- [jun-21 thin-strict gated](../jun-21-agentless-v3-thin-strict-gated/README.md)
- [jun-22 oracle proof clean v4](../jun-22-oracle-proof-clean-v4/README.md)
- [jun-22 static witness contract scaffold](../jun-22-static-witness-contract-scaffold/README.md)
- [jun-22 repro oracle campaign](../jun-22-repro-oracle-campaign/PLAN.md)
- [jun-22 evidence signal final plan](../jun-22-evidence-signal-final-plan.md)

## Verdict

`agentless-v5-thin-and-expanded` should not be another static preset that bakes
more knobs into round 0.

It should be a thin-first adaptive controller:

```text
thin candidate
  -> evidence packet
  -> LLM route decision
  -> bounded expansion phase
  -> proof-gated finalization
```

The design goal is:

- keep the cheap, minimal, source-only `v3-thin-strict` opening;
- let the LLM decide which evidence gap exists and which deeper phase is needed;
- keep submit authority deterministic and proof-based;
- forbid benchmark-shaped runtime heuristics.

This is the structural bridge between:

- `agentless-v3-thin-strict` as the cheap default posture, and
- `agentless-v4-proof-clean` as the bounded executable-proof posture.

## Why this plan exists

Current code already contains most of the pieces, but they are split across
static presets and do not compose into one adaptive run:

- the default live preset is still `agentless-v3-thin-strict`;
- `agentless-v3-thin-strict-gated(-llm)` can expand candidate count when cand0
  looks risky, but only inside the selector;
- `agentless-v4-proof-clean` exists, but must be selected up front;
- preset selection is fixed at run start, not promoted mid-run;
- the LLM today can help with a local risk-gate decision, but it does not own a
  typed escalation contract over repro / proof / repair / deeper localization.

So the current state is:

```text
many useful mechanisms exist
!=
one coherent thin-first adaptive system
```

`v5` is the plan to connect those mechanisms without reintroducing hidden
authority, targeted gates, or another layer of benchmark-specific heuristics.

## Current code truth

These points are the starting facts for this plan:

- bench default preset is `agentless-v3-thin-strict`
  - `src/apps/bench/preset.ts`
  - `src/runner/knobs/presets.ts`
- `agentless-v3-thin-strict` is minimal/noexec and does not enable repro,
  proof-required, or verify-select by default
  - `src/runner/knobs/presets.ts`
- `agentless-v3-thin-strict-gated` and `...-gated-llm` already implement
  candidate-0-first expansion inside verify-select
  - `src/runner/knobs/presets.ts`
  - `src/runner/batch/eval/selection-risk-gate.ts`
  - `src/runner/batch/eval/llm-risk-gate.ts`
- `agentless-v4-proof-clean` already packages repro-only execution,
  proof-required selection, and clean selector mode
  - `src/runner/knobs/presets.ts`
- bench posture is currently resolved from env/preset snapshot at run start
  rather than promoted by a per-instance controller
  - `src/apps/bench/preset.ts`
  - `src/runner/batch/eval/knobs-bench.ts`
- LLM evidence packet builders exist, but only some stages are runtime-active;
  the intake packet is still mainly a reporting artifact
  - `src/runner/batch/eval/llm-evidence-packet.ts`
  - `src/runner/batch/eval/driver.ts`

This means the repo is already close enough to build `v5` without rewriting the
whole bench runner. The missing piece is orchestration.

## Target operating model

`agentless-v5-thin-and-expanded` is a single-run controller with explicit
phases:

```text
Phase A: thin attempt
Phase B: evidence collection
Phase C: typed route decision
Phase D: bounded expansion
Phase E: proof-gated submit or typed stop
```

### Phase A - thin attempt

Start from the existing `agentless-v3-thin-strict` posture:

- no in-loop execution for round 0;
- patch hygiene on;
- patch budget on;
- strict minimal candidate generation;
- no hidden verify-select cost.

This preserves the current default strengths:

- lower turns;
- lower patch bytes;
- fewer unnecessary multi-file edits;
- cleaner measurement surface.

### Phase B - evidence collection

After the thin candidate exists, build a bounded evidence packet from current
code and receipts only.

This packet should answer:

- what the issue says in normalized public form;
- where the current candidate touched;
- what static owner / witness / contract evidence exists;
- what executable proof exists already;
- what proof is missing;
- whether the failure looks like localization, proof, synthesis, or infra.

### Phase C - typed route decision

The LLM does not emit raw knob values and does not choose a free-form preset
name.

Instead it returns one typed action from a closed schema.

### Phase D - bounded expansion

The controller maps the typed action to one of a small number of already-owned
phases:

- expand selection only;
- run public repro / MWE rails;
- promote into proof-clean;
- run one bounded repair with proof context;
- deepen localization;
- stop as infra / budget / missing prerequisite.

### Phase E - finalization

Submission authority is never the LLM decision itself.

Submission authority remains:

- apply-clean and structural validity;
- clean selector authority;
- executable proof receipt when the selected phase requires it;
- contamination and hidden-oracle bans.

## Authority model

`v5` is only worth doing if authority stays clean.

Allowed roles:

| signal | role |
|---|---|
| thin patch budget / hygiene / minimality | regularizer or rank |
| static witness / owner evidence / public contracts | seed, family expansion, or rank |
| public MWE / repro consensus / proof-required receipts | submit authority |
| LLM route decision | phase-routing only |
| report-only explanations | RCA only |

Forbidden runtime authority:

- benchmark instance IDs;
- known file-path regexes tied to benchmark cases;
- issue-keyword heuristics tied to known solve shapes;
- declared-expected answer matching;
- hidden SWE-bench tables, `FAIL_TO_PASS`, `PASS_TO_PASS`, `test_patch`,
  official grader data, or gold patches;
- magic score thresholds with veto power;
- contract-only or owner-only submit admission.

## Core controller contract

The controller needs a closed action schema.

```ts
type AdaptiveAction =
  | "accept_thin"
  | "expand_select"
  | "run_public_repro"
  | "run_proof_clean"
  | "repair_with_proof"
  | "deeper_localize"
  | "stop_infra_or_budget"

type EvidenceGap =
  | "localization_uncertain"
  | "issue_condition_not_evidenced"
  | "candidate_no_positive_proof"
  | "multi_owner_likely"
  | "base_repro_missing"
  | "regression_signal_missing"
  | "infra_blocked"

type AdaptiveDecision = {
  action: AdaptiveAction
  evidenceGaps: EvidenceGap[]
  citedEvidenceIds: string[]
  why: string
}
```

Required properties:

- closed enum;
- cited evidence ids only from the current packet;
- no preset names in the model response;
- no direct env or knob mutations from model output;
- invalid output fails closed into non-submit / escalate-needs-human telemetry.

## Evidence packet design

The packet should be built by one SSOT helper, not by ad hoc strings scattered
through drivers.

The minimum packet sections are:

### 1. Public issue facts

- normalized issue statement;
- extracted symbols and paths from public text;
- public reproduction hints if they exist;
- explicit ban on benchmark-only sources.

### 2. Candidate facts

- candidate patch hash;
- touched files;
- touched symbols if available;
- empty-patch / new-def / multi-file / runtime-expansion summaries;
- patch byte size.

### 3. Static ownership and witness facts

- owner files;
- owner evidence provenance;
- static witness edges or relation facts when available;
- candidate family or contract obligations.

### 4. Executable proof facts

- base repro status;
- public MWE status;
- repro-consensus status;
- discovered regression status;
- exact proof source, command, and bounded stdout/stderr tails.

### 5. Missing evidence facts

- what proof is missing;
- why it is missing;
- whether this is infra, environment, or lack of extraction;
- whether a deeper phase could realistically create it.

### 6. Environment caveats

- missing dependency;
- base-not-green instability;
- timeout class;
- unsupported strict-LSP or tool-state limitations.

## Action-to-phase mapping

`v5` should reuse existing code paths where possible.

| action | target phase |
|---|---|
| `accept_thin` | finalize current thin candidate through existing submit gates |
| `expand_select` | current gated verify-select path, preferably clean selector authority |
| `run_public_repro` | public MWE / repro extraction and execution rails |
| `run_proof_clean` | current `agentless-v4-proof-clean` posture, but invoked as a phase not as a separate operator-selected run |
| `repair_with_proof` | one bounded repair seeded by proof failure context |
| `deeper_localize` | wider owner/static witness/family expansion before another generation pass |
| `stop_infra_or_budget` | typed stop with explicit failure class in report |

Important distinction:

- `expand_select` is still thin-centered and cheap;
- `run_proof_clean` is the expensive executable-proof arm;
- `repair_with_proof` is only legal after a real proof failure or proof-missing
  classification, not as a generic second chance.

## State machine

Proposed high-level control flow:

```text
start thin-strict
  -> generate cand0
  -> build packet
  -> route decision

if accept_thin
  -> finalize with current authority

if expand_select
  -> run verify-select expansion
  -> finalize cleanly

if run_public_repro
  -> generate / extract proof target
  -> rebuild packet
  -> re-route

if run_proof_clean
  -> enter proof-clean phase
  -> generate/select under proof-required authority
  -> finalize or repair

if repair_with_proof
  -> one bounded repair round
  -> rebuild packet
  -> finalize cleanly

if deeper_localize
  -> widen owner/witness/family evidence
  -> one new generation pass
  -> re-route

if stop_infra_or_budget
  -> typed terminal result
```

The controller must stay bounded:

- no open-ended autonomous loop;
- per-phase max entry count;
- per-instance max expensive escalations;
- explicit stop reason when no legal next phase remains.

## Sequencing decision (jun-22) — decompose + oracle-first

DECIDED: do **not** build `v5` as one block. Decompose into a **skeleton** (built
now, measurement-independent) and a **brain** (built only after the oracle exists
and a clean baseline is measured). Rationale: the router's evidence packet is half
executable-proof facts (packet sections 4–5), and the repro oracle is **never
created in ~45%** of instances today
([evidence-signal-final-plan STEP 1](../jun-22-evidence-signal-final-plan.md)).
Building the LLM router before that = routing on empty signal + confound blowup
(unmeasured mechanisms — verify-select, repro-vote, closure-repair-net-neg —
fused into one orchestration). So:

**Wave 1 — skeleton (NOW, byte-identical / 0-token verifiable):**
- STEP 0 of the final plan: record/replay cassette + offline rescore harness
  (the gate for everything; without it every `v5` change re-pays paid rollout,
  and `v5` is adaptive so cassette replay is only PARTIALLY free — route prompts
  still re-generate).
- **C. posture injection seam** — the doc's own "key structural change"; pure
  refactor (env-snapshot → per-phase `BenchPosture` object). Also required by the
  final plan's executable-selection step, so it pays off twice.
- **B. evidence packet SSOT** — shared asset with the cassette's all-K
  persistence; build as structure, verify byte-identical.

**Wave 2 — fill the signal (final plan STEP 1–2):**
- oracle creation (astropy exec-path routing, py-version effect re-measure,
  django MWE-seed) — iterated FREE against the Wave-1 cassette.
- confound-clean baseline (n≥50, post-throttle-fix).

**Wave 3 — brain (ONLY after Wave 2 readout says the oracle exists):**
- **A. typed router contract** + **D. adaptive controller** — now the route
  decision sees real proof-facts. Gate on a measured oracle, never on n=1.
- **E. proof-clean adapter** / **F. telemetry** alongside.

The code groups below keep their letters; the wave tags above say WHEN each runs.

### Wave-1 status (landed jun-22)

**Posture injection seam — LANDED** (`src/runner/batch/eval/posture/`):
- `knob-module.ts` — `withKnobModules` (pure fold of detachable `KnobModule`
  fragments onto a `BenchKnobState`) + `derivePhasePosture` (re-derives through
  the canonical `benchPostureFromState` projector, so derived fields stay
  consistent) + `unknownModuleKnobs` / `rejectedModuleKnobs` validators.
- `capability-profiles.ts` — the detachable capability catalog (SELECT_N,
  RISK_GATE, CLOSURE_GROUNDING, CLEAN_SELECTOR, REPRO_EXEC, WIDE_CONCURRENCY,
  PROOF_REQUIRED, FULL_EXEC, REPAIR_BOUNDED) + named composites that reproduce
  shipped presets EXACTLY + the `AdaptiveAction → PHASE_MODULES` map.
- `tests/unit/posture-phase-modules-hellgate.test.ts` — 18 tests: byte-identical
  fence, 4 preset-equivalences (the core teeth), detach paired-control,
  red-on-injection, purity, misconfig surfacing, repair-engages, clean-mode
  ratchet. tsc clean; additive (zero production importers yet — Wave 3 is the
  sole intended consumer, per §2 of the adversarial audit "leave unwired = honest").

**Adversarial-audit findings folded in (3 rounds):**
- `repair_with_proof` now includes `FULL_EXEC` — the proof arm's `repro-only`
  exec made `benchRunsRepairPhase` false, so the repair round was inert; pinned
  by test ACTION-4.
- `deeper_localize` neutered to a no-op — `localize-phase:8` was an unmeasured
  heuristic (no shipped preset uses it); populate only after STEP 1 measures a
  localization-widening lever.
- equivalence/purity/authority refutations all FAILED (seam is sound): every
  routed action uses the clean selector, no answer-key signal smuggled.

**Wave-3 OBLIGATIONS discovered (do not skip when wiring the controller):**
1. `prepareAttemptContext` / `runInstanceOnce` still re-derive posture from
   `process.env` (via `benchOptIns()`) and expose no per-phase injection point.
   Wiring requires letting them accept an injected posture and passing a fresh
   per-phase posture into each phase entry — NOT free, a real refactor.
2. REPORT-FIDELITY: the derived `BenchKnobState` must become the SINGLE object
   feeding report serialization + `knobs_applied` + agent config, or the report
   keeps naming the base preset while a different posture ran ("report ≠ applied"
   split-brain). Add a report-fidelity test at wiring time — the hellgate's
   `behavioral()` strip deliberately does NOT cover that path.
3. Consider a dedicated `"phase-module"` `KnobValue.source` tag (today modules
   tag `"preset"`) so the report doesn't misattribute a controller-injected value
   to a named preset that never set it. Cosmetic/display-only; do alongside (2).

**Router contract + bounded controller core — LANDED**
(`src/runner/batch/eval/adaptive-escalation/`, groups A + D pure parts):
- `decision-schema.ts` — closed `AdaptiveAction` (re-uses the posture map's keys,
  drift-pinned) + `EvidenceGap` enum + `AdaptiveDecision` + the StructuredOutput
  JSON schema + `parseAdaptiveDecision` (FAIL-CLOSED: rejects unknown action/gap,
  a cited evidence id absent from the packet, or any malformed shape → caller
  must escalate-needs-human, never submit).
- `transitions.ts` — pure bounded state machine: expensive/terminal/reroute
  classification + `admitNextStep` (maxTotalSteps=4 / maxExpensive=2 /
  maxPerAction=2, terminal always admitted) + typed `StopReason`. No open loop.
- `controller.ts` — `runAdaptiveEscalation<P>`, the orchestrator spine that
  composes the three skeletons into one bounded loop (route → fail-closed parse →
  admit → map action to `PHASE_MODULES` → execute → reroute/finalize). Generic
  over the packet type `P` (never couples to the real packet shape); the LLM
  `router` and the phase `executor` are INJECTED PORTS, so the orchestration is
  hermetically testable and Wave 3 just supplies the real ports.
- tests (36): `adaptive-escalation-hellgate` (18 — closed-schema reject,
  cited-evidence scope, 9-case fail-closed, no-drift ratchet
  schema≡ADAPTIVE_ACTIONS≡PHASE_MODULES, exhaustive classification, bounded
  red-on-injection) + `adaptive-controller-hellgate` (8 — fail-closed never
  executes/submits, action→module mapping, per-action/expensive caps, packet
  reroute). tsc clean.

**Explicitly DEFERRED (hot-file collision with in-flight work — do NOT force):**
- **Evidence packet SSOT (group B)** — touches `driver.ts` /
  `llm-evidence-packet.ts`, both in-flight; building it now would clobber others'
  edits. Blocked until the working tree settles.
- **Group-A prompt assembly** — depends on the packet SSOT above; deferred with it.
- **Posture seam wiring + the router's LLM call** — Wave 3, gated on a measured
  oracle (final-plan STEP 1) per the sequencing decision; wiring now would be
  inert and violate the wave gating.
- **STEP 0 cassette/rescore harness** — actively in-flight
  (`repro-rescore*.ts`, `evaluate-repro` CLI); owned elsewhere, left untouched.

## Required code changes

This plan does not split tickets yet, but the code work naturally falls into
these implementation groups.

### A. Typed router contract

Add a dedicated module for:

- schema;
- parser;
- invalid-output handling;
- prompt assembly using the packet SSOT;
- exact list of allowed actions and forbidden sources.

Expected home:

- `src/runner/batch/eval/adaptive-escalation/`

### B. Evidence packet SSOT

Extend the existing LLM evidence packet helpers or add a sibling typed module so
that one builder can feed:

- route decision prompt;
- generation seed where allowed;
- repair seed where allowed;
- report telemetry.

Do not keep separate packet assembly logic in:

- `src/runner/batch/eval/driver.ts`
- `src/apps/bench/eval/driver.ts`

### C. Posture injection seam

Current bench posture is resolved from env/preset snapshot. `v5` needs a way to
invoke existing runner phases with explicit per-phase posture rather than
re-resolving a single preset from env.

That likely means:

- introducing a posture object that can be passed directly into phase runners; or
- introducing an internal controller-to-phase adapter that materializes a
  `BenchPosture` without mutating global env.

This is the key structural change. Without it, `v5` degenerates into "launch a
different preset later", which is operationally clumsy and makes per-instance
telemetry worse.

### D. Adaptive controller

Add a controller that:

- runs the initial thin attempt;
- builds the packet;
- calls the router;
- maps action to phase;
- records route telemetry;
- enforces bounded transitions;
- owns final terminal classification.

### E. Proof-clean phase adapter

Do not fork `v4` logic.

`v5` should reuse the existing proof-clean phase behavior and only change:

- when it is invoked;
- what packet/evidence is supplied;
- how the result is reported as part of a larger thin-first run.

### F. Report and telemetry surfaces

Every adaptive run must record:

- starting posture;
- chosen actions by phase;
- cited evidence ids;
- phase receipts;
- proof state;
- terminal failure class;
- whether the final submitted candidate came from thin, expanded select,
  proof-clean, or repair.

This is required so future RCA does not collapse:

- localization miss;
- proof-generation miss;
- synthesis miss;
- infra miss;
- grading miss.

## Testing strategy

`v5` needs tests at three levels.

### 1. Unit ratchets

- schema rejects unknown actions;
- schema rejects uncited evidence;
- route output cannot smuggle preset/env mutations;
- invalid LLM output cannot produce submit authority;
- clean mode cannot consume contaminated sources;
- router prompt includes current-stage evidence and forbidden-source guard.

### 2. Driver / controller parity

- shared runner driver and app bench driver see the same packet and same route;
- posture injection does not silently fall back to global env;
- phase transitions are deterministic for the same packet and mocked LLM reply;
- proof-clean phase entry keeps submit authority semantics unchanged.

### 3. Bench-focused hellgates

- no adaptive action can submit without current authority rails;
- `run_proof_clean` cannot degrade to contract-only submit;
- `expand_select` cannot introduce research-only hard veto into clean mode;
- `stop_infra_or_budget` is surfaced as typed telemetry, not as fake candidate red;
- `v5` with router returning `accept_thin` is behaviorally close to current
  thin-strict control where no deeper phase is needed.

## E2E checklist

This is the operational signoff gate. Do not call `v5` working because one unit
test, one local run, or one remote rerun looked promising. The checklist below
must be read as an end-to-end claim ladder.

### 1. Wiring complete

- [ ] `agentless-v5-thin-and-expanded` is selectable from the normal bench
  surface and does not require ad hoc env surgery.
- [ ] the run starts from thin posture without mutating global `process.env`
  after launch.
- [ ] one SSOT evidence-packet builder feeds router prompt assembly and report
  telemetry.
- [ ] the controller can invoke thin, expanded-select, proof-clean, repair, and
  deeper-localize phases without launching a second independent bench run.
- [ ] the controller records action chain and terminal class even when no patch
  is submitted.

### 2. Route contract safe

- [ ] unknown action from the LLM is rejected.
- [ ] uncited evidence ids are rejected.
- [ ] any model output that tries to smuggle preset names, env keys, or raw
  knob mutations is rejected.
- [ ] invalid or empty LLM output cannot result in submission.
- [ ] the fallback path after invalid output is explicit and typed, not silent
  fail-open behavior.

### 3. Thin-first invariant preserved

- [ ] the first generation pass is still the current thin/noexec/minimal posture.
- [ ] cheap cases can terminate on thin without paying proof-clean cost.
- [ ] `expand_select` only expands candidate search; it does not silently turn on
  proof-required semantics by accident.
- [ ] `run_proof_clean` is entered only through the controller's typed route, not
  through hidden heuristics.
- [ ] no step reintroduces instance-id, file-path, or issue-keyword gates.

### 4. Proof authority preserved

- [ ] `accept_thin` does not let a proof-missing candidate submit if the current
  authority policy would block it.
- [ ] `run_proof_clean` preserves existing `v4` proof-required semantics.
- [ ] contract-only submit is impossible.
- [ ] owner-only submit is impossible.
- [ ] generic keep-green regression evidence cannot masquerade as positive bug-fix
  proof.
- [ ] infra or environment failures surface as infra/env, not as fake
  candidate-red proof failures.

### 5. Driver parity proven

- [ ] shared runner driver and apps bench driver see the same packet shape.
- [ ] shared runner driver and apps bench driver produce the same route decision
  under the same mocked LLM output.
- [ ] posture injection does not silently fall back to env-resolved preset state.
- [ ] route replay over the same packet is deterministic.
- [ ] report telemetry fields are present from both drivers, not only one path.

### 6. Negative E2E cases proven

- [ ] a malicious router response that says `accept_thin` on an unproven patch
  still cannot force submission.
- [ ] a malicious router response that asks for `run_proof_clean` with no valid
  cited evidence is rejected.
- [ ] a proof-clean phase with broken environment is classified as infra/env and
  stops cleanly.
- [ ] a no-proof/no-repro case does not get mislabeled as solved because static
  evidence looked good.
- [ ] a route dead-end produces a typed stop reason instead of looping forever.

### 7. Offline replay E2E proven

- [ ] with trajectory and candidate sidecars recorded, the adaptive route can be
  replayed without new LLM cost where the path is deterministic.
- [ ] replay before any behavioral fix is byte-identical to the recorded route
  outcome.
- [ ] replay preserves terminal proof state and failure class.
- [ ] replay is sufficient to test deterministic controller fixes without paying
  for fresh generation.

### 8. Three-case north-star remote run checked

- [ ] `astropy__astropy-13033`: if env parity is still broken, report says
  infra/env; if env parity is fixed, proof rails engage instead of dying as empty
  patch noise.
- [ ] `django__django-11138`: when thin lacks executable proof, the controller
  escalates into proof creation or broader structural search instead of falsely
  accepting the thin candidate.
- [ ] `django__django-14315`: an incomplete leaf-only patch cannot win over a
  fuller co-change only because it is smaller.
- [ ] each of the three reports includes starting posture, action chain, cited
  evidence ids, proof state, and terminal class.

### 9. Control-arm comparison complete

- [ ] compare against `agentless-v3-thin-strict`.
- [ ] compare against `agentless-v3-thin-strict-closure-select-clean`.
- [ ] compare against `agentless-v4-proof-clean`.
- [ ] any improvement is explained as thin-first routing plus proof-gated
  escalation, not as hidden heuristic authority.
- [ ] cheap-case turn count and patch-size regressions are measured, not assumed away.

### 10. Promotion gate

- [ ] no contaminated authority source entered runtime selection.
- [ ] no targeted heuristic bundle was reintroduced under a different name.
- [ ] adaptive routing improved at least one meaningful hard-case slice without
  invalidating clean accounting.
- [ ] unresolved cases remain diagnosable by explicit failure class:
  localization, proof generation, synthesis, infra, or grading.
- [ ] the final remote report set is strong enough that future RCA does not need
  dashboard folklore or memory of which preset "probably" ran.

## Rollout plan

`v5` should be introduced as a new explicit preset/profile name first:

- `agentless-v5-thin-and-expanded`

This name means:

- `thin`: start from the current cheap v3 posture;
- `expanded`: deepen only when evidence says the cheap attempt is insufficient.

Recommended rollout order:

1. local unit / integration ratchets;
2. 3-case proof set:
   - `astropy__astropy-13033`
   - `django__django-11138`
   - `django__django-14315`
3. contaminated / ambiguous set under clean accounting;
4. fail63 or equivalent hard-case rerun set;
5. full remote campaign.

Control arms to keep:

- `agentless-v3-thin-strict`
- `agentless-v3-thin-strict-closure-select-clean`
- `agentless-v4-proof-clean`

`v5` should beat them by structure, not by hiding more heuristics.

## Promotion criteria

Do not make `v5` default until all of these hold:

- no targeted heuristic authority was added;
- typed route controller is stable under unit and integration ratchets;
- per-phase telemetry cleanly distinguishes thin accept, select expansion,
  repro/proof creation, repair, and infra stop;
- proof-clean submit rules remain intact when invoked through `v5`;
- at least one meaningful hard-case slice shows improvement without contamination;
- cheap cases do not regress materially in turns or patch size;
- any net gain survives a control-arm comparison rather than a single scoreboard
  snapshot.

## Non-goals

- Do not turn `v5` into a broad planner/verifier stack by default.
- Do not add another monolithic "everything-on" preset.
- Do not let the LLM emit raw knob values or preset names.
- Do not use prompt injection of extra evidence as authority by itself.
- Do not backport proof-clean submit rules silently into v3 control arms while measuring.
- Do not claim SOTA++ from one lucky rerun.

## Final implementation stance

This plan is intentionally narrow:

- keep the round-0 default thin;
- let the LLM decide the semantic gap;
- let the controller decide the legal next phase;
- let proof receipts decide submission.

That is the right split.

The alternative failure modes are already known:

- static heuristic escalation overfits benchmark cases;
- all-on scaffolding destroys minimality discipline;
- unconstrained LLM autonomy destroys determinism and auditability;
- proof-free selection overclaims success.

`agentless-v5-thin-and-expanded` exists to avoid all four at once.
