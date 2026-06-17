/**
 * T-302 — primary-rail ENFORCEMENT + repair admission.
 *
 * PURE, deterministic policy (no LLM, no I/O). Two deciders that make "what proof
 * clears done" explicit and external-signal-only:
 *
 *  1. {@link decideRepairAdmission} — repair may iterate ONLY when an admissible
 *     primaryRail exists AND it is RED. No primary rail ⇒ no blind repair. A
 *     GREEN/UNRUN rail ⇒ nothing to iterate on.
 *
 *  2. {@link decidePrimaryRailFinishGate} — closes the false-green hole. Today
 *     the repair validator clears on the AGENT's own `lastVerifyCmd` (any
 *     test-like bash), so a NON-primary green (or a self-authored repro that
 *     never actually exercises the bug — sympy-23262) "passes". This gate blocks
 *     finishing while the planner-selected primaryRail is not GREEN, regardless
 *     of how many non-primary checks are green.
 *
 * The bidirectional commit-vs-verify gate (`decideGate`/`GateSignals`/
 * `GateDecision`) is NOT here — it is the canonical {@link module:agent/gate-decision}
 * (richer structural signals). This module owns ONLY the rail-enforcement half,
 * which gate-decision.ts does not cover. Absent cfg ⇒ OFF (byte-identical). The
 * finish gate is intentionally narrow: it blocks only on a present-but-not-green
 * primary rail; a rail-ABSENT case is delegated to T-301 (plan) / T-501 (no-patch
 * breaker), never silently failed here.
 */

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
