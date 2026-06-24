/**
 * Capability profile catalog (jun-22 v5 Wave-1 skeleton).
 *
 * The thin-strict preset FAMILY in `runner/knobs/presets.ts` is, structurally,
 * one shared 13-knob base (`agentless-v3-thin-strict`) plus a small set of
 * detachable capability bundles that every variant re-lists verbatim:
 *
 *   - SELECT_N            verify-select N-best + discovered regression
 *   - RISK_GATE           candidate-0-first structural risk gate
 *   - CLOSURE_GROUNDING   fault-evidence / verification-plan / primary-rail / …
 *   - CLEAN_SELECTOR      clean lexicographic submit authority
 *   - REPRO_EXEC          bounded repro-only execution + adversarial repro
 *   - PROOF_REQUIRED      proof-gated submit rail
 *
 * This file names those bundles ONCE as {@link KnobModule}s so the v5 controller
 * can attach/detach them per phase instead of selecting a whole preset up front.
 * The named composites below reproduce real presets EXACTLY (pinned by the
 * equivalence hellgate) — that is what proves these modules carry genuine
 * capability and never drift from the shipped presets.
 *
 * Nothing here turns a knob on by itself; a profile is inert until the
 * controller folds it onto a base state via `derivePhasePosture`.
 */

import type { KnobModule } from "./knob-module"

// ── Primitive capability modules (deltas over the thin-strict base) ──────────

/** N-best verify-select candidate count. ONE capability per module: the
 *  regression signal is the separate {@link REGRESSION} module (split jun-22 so
 *  DETACH paired-control holds — `verify-select` and `verify-select-regression`
 *  are independent fields). */
export const SELECT_N = (n: number): KnobModule => ({
  id: `select-n-${n}`,
  knobs: { "verify-select": String(n) },
})

/** Hard regression signal source for verify-select (no-oracle `discovered` repo
 *  tests by default; `gold`/`off` for ablations). */
export const REGRESSION = (mode: "discovered" | "gold" | "off"): KnobModule => ({
  id: `regression-${mode}`,
  knobs: { "verify-select-regression": mode },
})

/** Progressive early-accept: stop after the first hard-positive owner candidate. */
export const SELECT_EARLY_ACCEPT: KnobModule = {
  id: "select-early-accept",
  knobs: { "verify-select-early-accept": "1" },
}

/** Self-generated repro consensus as POSITIVE-only soft ranking (no false-red veto). */
export const SELECT_REPRO_POSITIVE: KnobModule = {
  id: "select-repro-positive",
  knobs: { "verify-select-repro": "positive" },
}

/** Self-generated repro signal OFF (gated arms that must not pay repro-gen cost). */
export const SELECT_REPRO_OFF: KnobModule = {
  id: "select-repro-off",
  knobs: { "verify-select-repro": "off" },
}

/** Candidate-0-first adaptive risk gate (sequential, expand only when risky). */
export const RISK_GATE: KnobModule = {
  id: "risk-gate",
  knobs: { "verify-select-risk-gate": "1", "verify-select-concurrency": "1" },
}

/** Clean lexicographic submit authority (no research-only heuristic veto). */
export const CLEAN_SELECTOR: KnobModule = {
  id: "clean-selector",
  knobs: { "selector-mode": "clean" },
}

/** ClosureBundle grounding: typed fault evidence + verification plan + primary
 *  rail + no-patch breaker + multi-owner repair escalation. */
export const CLOSURE_GROUNDING: KnobModule = {
  id: "closure-grounding",
  knobs: {
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
  },
}

/** Bounded executable public-repro feedback: repro-only in-loop exec + K repro
 *  samples + adversarial-coverage repro prompt + native test runner. */
export const REPRO_EXEC: KnobModule = {
  id: "repro-exec",
  knobs: {
    "bench-in-loop-exec": "repro-only",
    "repro-test": "10",
    "adversarial-repro": "1",
    "test-runner": "1",
  },
}

/** Wider candidate-generation concurrency (proof arms amortize exec cost). */
export const WIDE_CONCURRENCY: KnobModule = {
  id: "wide-concurrency",
  knobs: { "verify-select-concurrency": "3" },
}

/** Full in-loop repo-test execution. REQUIRED for the closure-repair phase:
 *  `benchRunsRepairPhase` only fires when `inLoopExecMode === "full"`
 *  (repair-phase-policy.ts:13), so a repair action MUST override the proof
 *  arm's `repro-only` exec to `full` or the repair round is inert. */
export const FULL_EXEC: KnobModule = {
  id: "full-exec",
  knobs: { "bench-in-loop-exec": "full" },
}

/** Proof-gated submit: only candidates with positive executed public proof may
 *  be submitted (contracts/family/minimality stay advisory). */
export const PROOF_REQUIRED: KnobModule = {
  id: "proof-required",
  knobs: { "verify-select-proof-required": "1" },
}

/** CHA sibling-override completeness steer (jun-24): static class-hierarchy
 *  analysis of the candidate repo points the localizer at sibling override
 *  sites the model otherwise misses on multi-backend bugs. Static-only; never
 *  reads the gold patch. */
export const CHA_MULTISITE: KnobModule = {
  id: "cha-multisite",
  knobs: { "cha-multisite-steer": "1" },
}

/** One bounded closure-repair round seeded by proof-failure context. */
export const REPAIR_BOUNDED = (rounds: number): KnobModule => ({
  id: `repair-bounded-${rounds}`,
  knobs: { "closure-repair": String(rounds) },
})

/** Closure-repair loop with N rounds (preset spelling of {@link REPAIR_BOUNDED}). */
export const CLOSURE_REPAIR = REPAIR_BOUNDED

/** LSP-nav grounding steer OFF (the agentless-v1 A/B baseline arm). */
export const STEER_OFF: KnobModule = { id: "steer-off", knobs: { "lsp-steer": "off" } }

/** Patch hygiene gate (stray-file deny / owner-outside telemetry). */
export const PATCH_HYGIENE: KnobModule = { id: "patch-hygiene", knobs: { "patch-hygiene": "1" } }

/** T3 — forward-localize lever (default-OFF). Occupies the `deeper_localize`
 *  route: selecting it turns on a forward consumer-trace for the next pass. */
export const FORWARD_LOCALIZE: KnobModule = {
  id: "forward-localize",
  knobs: { "forward-localize": "1" },
}

/** H1 — dynamic-message-matcher (default-OFF). Layers on spec-fidelity-invariant:
 *  narrows the declared-expected matcher's dynamic-format abstain region via
 *  fixed-skeleton comparison so a WRONG dynamic message can be vetoed. */
export const DYNAMIC_MESSAGE_MATCHER: KnobModule = {
  id: "dynamic-message-matcher",
  knobs: { "spec-fidelity-invariant": "1", "dynamic-message-matcher": "1" },
}

/** Multi-agent axis: subagent + bundled skills (the `everything` posture). */
export const MULTI_AGENT: KnobModule = { id: "multi-agent", knobs: { subagent: "1", skills: "1" } }

/** Counterfactual cand-1 seed when cand-0 trips the structural risk gate. */
export const COUNTERFACTUAL: KnobModule = {
  id: "counterfactual",
  knobs: { "verify-select-counterfactual": "on" },
}

/** Optional LLM semantic risk gate layered on the structural gate (`shadow` =
 *  advisory telemetry only; `on` = expands fail-closed). */
export const LLM_RISK_GATE = (mode: "shadow" | "on"): KnobModule => ({
  id: `llm-risk-gate-${mode}`,
  knobs: { "verify-select-llm-risk-gate": mode },
})

/** K-of-N RESOLVED repro-consensus gate (removes the single-script false-neg). */
export const REPRO_VOTE: KnobModule = { id: "repro-vote", knobs: { "repro-vote": "1" } }

/** Repro-doubt steer: doubt the repro test (not the fix) when the verify loop
 *  stalls. N = the steer's trip threshold. */
export const REPRO_DOUBT = (n: number): KnobModule => ({
  id: `repro-doubt-${n}`,
  knobs: { "repro-doubt": String(n) },
})

// ── Frozen base bundles (the canonical localization/exec anchors) ────────────
// A base is a KnobModule whose `knobs` is the verbatim frozen literal of the
// preset of the same name. Presets compose as `composePresetKnobs(BASE, delta)`
// (the single fold + registry in `./compose-preset.ts`).

/** `agentless-v1` — the 9-knob localization+exec core (FROZEN, reproducibility). */
export const LOCALIZATION_CORE: KnobModule = {
  id: "agentless-v1",
  knobs: {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repro-test": "5",
    "repo-map": "1",
    "read-outline": "1",
    "test-runner": "1",
    "retry-transient": "3",
  },
}

/** `agentless-v3-thin` — localization core + closure grounding + minimal-edit. */
export const THIN_BASE: KnobModule = {
  id: "agentless-v3-thin",
  knobs: {
    ...LOCALIZATION_CORE.knobs,
    "fault-evidence": "1",
    "verification-plan": "1",
    "primary-rail": "1",
    "patch-hygiene": "1",
    "no-patch-breaker": "1",
    "repair-escalation": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
  },
}

/** `agentless-v3-thin-strict` — 13-knob mini-first/noexec strict base (the base
 *  the thin-strict family + v4-proof-clean compose over). */
export const THIN_STRICT_BASE: KnobModule = {
  id: "agentless-v3-thin-strict",
  knobs: {
    lsp: "1",
    "localize-phase": "5",
    "issue-hint": "agentless",
    "issue-hint-expected-actual": "1",
    "repo-map": "1",
    "read-outline": "1",
    "retry-transient": "3",
    "bench-in-loop-exec": "off",
    "patch-hygiene": "1",
    "spec-fidelity-steer": "1",
    "patch-budget": "1",
    "patch-budget-strict": "1",
  },
}

// The build-time fold (composite → flat preset knob map) is `composePresetKnobs`
// in `./compose-preset.ts` — the SINGLE SSOT registry + fold. It is the static
// twin of the runtime `withKnobModules`/`derivePhasePosture` fold; the SAME
// module arrays feed both `PRESET_COMPOSITES` and `PHASE_MODULES`, so a preset
// literal and its phase posture share one source and cannot drift.

// ── Named composites that reproduce shipped presets EXACTLY ──────────────────
// (over an `agentless-v3-thin-strict` base — pinned by the equivalence hellgate)

/** ≡ `agentless-v3-thin-strict-gated`. */
export const GATED_MODULES: readonly KnobModule[] = [
  SELECT_N(2),
  REGRESSION("discovered"),
  RISK_GATE,
  SELECT_REPRO_OFF,
  CLEAN_SELECTOR,
]

/** ≡ `agentless-v3-thin-strict-select`. */
export const SELECT_MODULES: readonly KnobModule[] = [
  SELECT_N(5),
  REGRESSION("discovered"),
  SELECT_EARLY_ACCEPT,
  SELECT_REPRO_POSITIVE,
]

/** ≡ `agentless-v3-thin-strict-closure-select-clean`. */
export const CLOSURE_SELECT_CLEAN_MODULES: readonly KnobModule[] = [
  SELECT_N(5),
  REGRESSION("discovered"),
  SELECT_EARLY_ACCEPT,
  SELECT_REPRO_POSITIVE,
  CLOSURE_GROUNDING,
  CLEAN_SELECTOR,
]

/** ≡ `agentless-v4-proof-clean`. */
export const PROOF_CLEAN_MODULES: readonly KnobModule[] = [
  SELECT_N(5),
  REGRESSION("discovered"),
  SELECT_REPRO_POSITIVE,
  CLOSURE_GROUNDING,
  REPRO_EXEC,
  WIDE_CONCURRENCY,
  PROOF_REQUIRED,
  CHA_MULTISITE,
  CLEAN_SELECTOR,
]

/** `agentless-v4-proof-clean` plus full in-loop repo-test execution. Mirrors
 *  the competitor-style "run the existing tests in the same repair loop"
 *  posture while preserving clean selector authority and proof-required gating
 *  as-is. */
export const PROOF_CLEAN_EXECFULL_MODULES: readonly KnobModule[] = [
  ...PROOF_CLEAN_MODULES,
  FULL_EXEC,
]

/** Public-repro rails WITHOUT proof-required gating — generate/extract a base
 *  oracle and let late selection rank, but do not yet hard-gate submit on it. */
export const REPRO_RAILS_MODULES: readonly KnobModule[] = [
  SELECT_N(5),
  REGRESSION("discovered"),
  SELECT_REPRO_POSITIVE,
  CLOSURE_GROUNDING,
  REPRO_EXEC,
  WIDE_CONCURRENCY,
  CLEAN_SELECTOR,
]

/** `agentless-v5-absorb` — the competitor-verified absorption arm (jun-25).
 *  Bundles the LANDED-REAL absorbed levers into ONE measurable preset so the
 *  three confirmed our-only fails (13033/14315/11138) finally exercise them:
 *   - repro-rails (NOT proof-required) ⇒ rank by repro/proof but never hard-gate
 *     submit to empty — mirrors the mini-SWE-agent "submit best non-empty diff"
 *     posture that the 0/3 proof-gated run lacked (empty_patch was the terminator).
 *   - CHA_MULTISITE: backward sibling-override completeness (django-11138/14315).
 *   - DYNAMIC_MESSAGE_MATCHER: spec-fidelity-invariant + dynamic-format matcher
 *     (Lingxi topic-question oracle) — the execution-free spec gate for 13033.
 *   - FORWARD_LOCALIZE: end-state consumer-trace re-localization (Lingxi) — the
 *     forward lever for the 14315 producer→consumer miss.
 *  F821 differential gate + lost-edits capture are DEFAULT-ON, so they ride along.
 *  A/B control = `agentless-v4-proof-clean` (same rails + proof-required, no new
 *  localize/spec levers). NOT default; opt-in via `QUANTA_BENCH_PRESET`. */
export const ABSORB_MODULES: readonly KnobModule[] = [
  ...REPRO_RAILS_MODULES,
  CHA_MULTISITE,
  DYNAMIC_MESSAGE_MATCHER,
  FORWARD_LOCALIZE,
]

// ── v5 AdaptiveAction → phase modules (the controller's action map) ──────────
// Mirrors the closed `AdaptiveAction` enum in the v5 readme. `accept_thin` and
// `stop_infra_or_budget` are no-op postures (finalize/terminate on the thin base).

export type AdaptiveAction =
  | "accept_thin"
  | "expand_select"
  | "run_public_repro"
  | "run_proof_clean"
  | "repair_with_proof"
  | "deeper_localize"
  | "stop_infra_or_budget"

/** Deeper localization pass. INTENTIONALLY EMPTY (no-op) for now: no shipped
 *  preset widens localization, and an arbitrary `localize-phase` bump is an
 *  UNMEASURED heuristic (final-plan STEP 1 must measure a localization-widening
 *  lever before it earns a posture). T3 occupies it with the forward-localize
 *  lever: the knob is DEFAULT-OFF, so `deeper_localize` only engages a forward
 *  consumer-trace when the controller selects this route AND the lever is on —
 *  not an always-on dial. Promotion still requires the frozen-slice A/B. */
export const DEEPER_LOCALIZE_MODULES: readonly KnobModule[] = [FORWARD_LOCALIZE]

export const PHASE_MODULES: Readonly<Record<AdaptiveAction, readonly KnobModule[]>> = {
  accept_thin: [],
  expand_select: GATED_MODULES,
  run_public_repro: REPRO_RAILS_MODULES,
  run_proof_clean: PROOF_CLEAN_MODULES,
  // FULL_EXEC overrides the proof arm's repro-only exec to `full` so the
  // closure-repair round actually engages (benchRunsRepairPhase requires
  // mode==="full"); without it REPAIR_BOUNDED would be inert.
  repair_with_proof: [...PROOF_CLEAN_MODULES, FULL_EXEC, REPAIR_BOUNDED(1)],
  deeper_localize: DEEPER_LOCALIZE_MODULES,
  stop_infra_or_budget: [],
}
