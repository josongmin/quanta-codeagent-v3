/**
 * T-301 — VerificationPlan: the typed "what proof is required before done"
 * artifact. Selection authority is PUBLIC evidence only (a synthesized/selected
 * repro, an owner-near test, a touched-module smoke). Hidden bench labels, gold
 * patch hints, and same-model self-critique are NEVER counted as required
 * verification — self-critique stays advisory.
 */

export type VerificationStepKind = "repro" | "owner-test" | "module-smoke"

export interface VerificationStep {
  kind: VerificationStepKind
  /** Concrete command to run (deterministic, public). */
  cmd: string
}

export interface VerificationPlan {
  /** The single rail repair is gated on. null ⇒ no admissible rail (repair stays off). */
  primaryRail: VerificationStep | null
  /** Hard-capped required steps (first is the primaryRail). */
  required: VerificationStep[]
  /** Non-blocking extra checks (incl. a repro that failed red-on-injection). */
  optional: VerificationStep[]
  /** True iff a synthesized repro proved RED on the unpatched base. */
  baseValidatedRed: boolean
}

export interface VerificationPlanInput {
  /** Synthesized/installed repro. Becomes primaryRail ONLY if baseValidatedRed. */
  reproScript?: { cmd: string; baseValidatedRed: boolean }
  /** Owner-near test commands (public). */
  ownerNearTests?: readonly string[]
  /** Touched-module smoke commands (post-edit info). */
  touchedModuleSmoke?: readonly string[]
  /** Required-step cap (default 3). */
  maxRequired?: number
}
