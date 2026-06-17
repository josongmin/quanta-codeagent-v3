/**
 * T-302 — primary-rail enforcement + gate decision + repair admission.
 *
 * PURE, deterministic policy (no LLM, no I/O). Three deciders that together make
 * "what proof clears done" explicit and external-signal-only:
 *
 *  1. {@link decideGate} — bidirectional commit-vs-verify gate from CHEAP
 *     structural signals. Categorical, NOT heuristic thresholds: a case may
 *     commit early ONLY when it is trivially low-stakes AND low-uncertainty;
 *     everything else must verify the primary rail.
 *
 *  2. {@link decideRepairAdmission} — repair may iterate ONLY when an admissible
 *     primaryRail exists AND it is RED. No primary rail ⇒ no blind repair. A
 *     GREEN/UNRUN rail ⇒ nothing to iterate on.
 *
 *  3. {@link decidePrimaryRailFinishGate} — closes the false-green hole. Today
 *     the repair validator clears on the AGENT's own `lastVerifyCmd` (any
 *     test-like bash), so a NON-primary green (or a self-authored repro that
 *     never actually exercises the bug — sympy-23262) "passes". This gate blocks
 *     finishing while the planner-selected primaryRail is not GREEN, regardless
 *     of how many non-primary checks are green.
 *
 * Absent cfg ⇒ OFF (byte-identical). The gate is intentionally narrow: it only
 * blocks on a present-but-not-green primary rail; a rail-ABSENT case is delegated
 * to T-301 (plan) / T-501 (no-patch breaker), never silently failed here.
 */

/** Coarse, externally-derivable case signals for the commit-vs-verify gate. */
export interface GateSignals {
  /** Blast radius of the change. `high` ⇒ must verify. */
  stakes: "low" | "high"
  /** Confidence in owner/fix. `high` uncertainty ⇒ must verify. */
  uncertainty: "low" | "high"
  /** Whether the plan produced an admissible primary rail. */
  primaryRailAvailable: boolean
  /** No edit yet / empty-patch risk — there is nothing to "commit now". */
  emptyPatchPressure: boolean
}

export type GateAction = "commit-now" | "verify"

export interface GateDecision {
  action: GateAction
  reason: string
}

/**
 * Commit-now ONLY for trivially safe cases: low stakes AND low uncertainty AND
 * something actually exists to commit. Every other combination verifies. This is
 * a categorical rule over coarse buckets, not a tuned threshold.
 */
export const decideGate = (s: GateSignals): GateDecision => {
  if (s.emptyPatchPressure) {
    return { action: "verify", reason: "empty-patch pressure: nothing to commit, must produce+verify" }
  }
  if (s.stakes === "low" && s.uncertainty === "low") {
    return { action: "commit-now", reason: "low stakes + low uncertainty: trivial single-owner early-commit" }
  }
  return {
    action: "verify",
    reason: `must verify (stakes=${s.stakes}, uncertainty=${s.uncertainty})`,
  }
}

/** Tri-state outcome of running the primary rail. */
export type RailState = "green" | "red" | "unrun"

export interface RepairAdmissionInput {
  primaryRailPresent: boolean
  primaryRailState: RailState
}

export interface RepairAdmissionDecision {
  admit: boolean
  reason: string
}

/**
 * Repair iterates ONLY against a present + RED primary rail. This is the inverse
 * guard to the finish gate: without a rail proven red there is no honest signal
 * to repair toward, so we never spin blind repair rounds (cost + drift).
 */
export const decideRepairAdmission = (i: RepairAdmissionInput): RepairAdmissionDecision => {
  if (!i.primaryRailPresent) return { admit: false, reason: "no admissible primary rail" }
  if (i.primaryRailState === "green") return { admit: false, reason: "primary rail already green" }
  if (i.primaryRailState === "unrun") return { admit: false, reason: "primary rail not yet proven red" }
  return { admit: true, reason: "primary rail red: repair admissible" }
}

/** Config — presence enables the gate. Absent ⇒ OFF. */
export interface PrimaryRailGateConfig {
  enabled: boolean
}

export interface PrimaryRailResult {
  primaryRailPresent: boolean
  primaryRailState: RailState
  /** Count of NON-primary verification steps that passed (must NOT clear the gate). */
  nonPrimaryGreens: number
}

export interface PrimaryRailFinishDecision {
  block: boolean
  reason?: string
}

/**
 * Block a finish attempt while the primary rail is present but not GREEN. The
 * whole point: `nonPrimaryGreens` is IGNORED for clearing — only the primary rail
 * passing clears the gate. A rail-absent case never blocks here (delegated).
 */
export const decidePrimaryRailFinishGate = (args: {
  cfg: PrimaryRailGateConfig | undefined
  result: PrimaryRailResult
}): PrimaryRailFinishDecision => {
  const { cfg, result } = args
  if (cfg === undefined || !cfg.enabled) return { block: false }
  if (!result.primaryRailPresent) return { block: false }
  if (result.primaryRailState === "green") return { block: false }
  return {
    block: true,
    reason: `primary rail ${result.primaryRailState}: ${result.nonPrimaryGreens} non-primary green(s) do not clear the gate`,
  }
}
