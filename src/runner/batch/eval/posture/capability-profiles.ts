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

/** N-best verify-select with the no-oracle discovered-repo regression signal. */
export const SELECT_N = (n: number): KnobModule => ({
  id: `select-n-${n}`,
  knobs: { "verify-select": String(n), "verify-select-regression": "discovered" },
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

/** One bounded closure-repair round seeded by proof-failure context. */
export const REPAIR_BOUNDED = (rounds: number): KnobModule => ({
  id: `repair-bounded-${rounds}`,
  knobs: { "closure-repair": String(rounds) },
})

// ── Named composites that reproduce shipped presets EXACTLY ──────────────────
// (over an `agentless-v3-thin-strict` base — pinned by the equivalence hellgate)

/** ≡ `agentless-v3-thin-strict-gated`. */
export const GATED_MODULES: readonly KnobModule[] = [
  SELECT_N(2),
  RISK_GATE,
  SELECT_REPRO_OFF,
  CLEAN_SELECTOR,
]

/** ≡ `agentless-v3-thin-strict-select`. */
export const SELECT_MODULES: readonly KnobModule[] = [
  SELECT_N(5),
  SELECT_EARLY_ACCEPT,
  SELECT_REPRO_POSITIVE,
]

/** ≡ `agentless-v3-thin-strict-closure-select-clean`. */
export const CLOSURE_SELECT_CLEAN_MODULES: readonly KnobModule[] = [
  SELECT_N(5),
  SELECT_EARLY_ACCEPT,
  SELECT_REPRO_POSITIVE,
  CLOSURE_GROUNDING,
  CLEAN_SELECTOR,
]

/** ≡ `agentless-v4-proof-clean`. */
export const PROOF_CLEAN_MODULES: readonly KnobModule[] = [
  SELECT_N(5),
  SELECT_REPRO_POSITIVE,
  CLOSURE_GROUNDING,
  REPRO_EXEC,
  WIDE_CONCURRENCY,
  PROOF_REQUIRED,
  CLEAN_SELECTOR,
]

/** Public-repro rails WITHOUT proof-required gating — generate/extract a base
 *  oracle and let late selection rank, but do not yet hard-gate submit on it. */
export const REPRO_RAILS_MODULES: readonly KnobModule[] = [
  SELECT_N(5),
  SELECT_REPRO_POSITIVE,
  CLOSURE_GROUNDING,
  REPRO_EXEC,
  WIDE_CONCURRENCY,
  CLEAN_SELECTOR,
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
 *  lever before it earns a posture). Routing `deeper_localize` here today is a
 *  no-op (≡ thin) rather than smuggling an unvalidated dial. Populate only after
 *  a measured lever exists. */
export const DEEPER_LOCALIZE_MODULES: readonly KnobModule[] = []

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
