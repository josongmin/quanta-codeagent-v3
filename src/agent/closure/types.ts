/**
 * Closure engine — core types (jun-17 closure-driven runner, T-1).
 *
 * The closure engine is a GENERAL capability ("how an agent verifies and closes
 * an edit"), not a bench feature. These types are PURE: no I/O, no dataset, no
 * environment. The adapter (bench / chat / autonomous) supplies the inputs; the
 * core returns verdicts. See docs/plans/jun-17-closure-driven-runner/README.md.
 */

import type { SuccessPredicate, VerificationStepKind } from "@/agent/verification-plan"

export type { SuccessPredicate }

/**
 * What was OBSERVED from running a verification command, environment-agnostic.
 * The adapter (validator) produces this from its injected `exec`; the core
 * evaluator reads it. This is the pure/IO seam — IO lives in the adapter, the
 * verdict is pure over this shape.
 */
export interface ExecObservation {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * Verdict of evaluating a {@link SuccessPredicate} against an {@link ExecObservation}.
 *
 * - `evaluable: false` ⇒ this predicate cannot be confidently judged from the
 *   observation (e.g. an issue-derived exact-string/symbolic predicate whose
 *   observed repr we cannot reliably extract). The caller MUST fail OPEN —
 *   degrade to the legacy exit-code decision, never hard-fail. False-RED (a
 *   correct patch rejected by a fragile predicate) is worse than today's
 *   false-green.
 * - `matched` is only meaningful when `evaluable: true`.
 */
export interface PredicateResult {
  readonly evaluable: boolean
  readonly matched: boolean
  readonly mismatchReason?: string
}

/**
 * The selected primary rail as a TYPED step (T-2): the command to run, how its
 * proof is read, and the typed proof obligation. Replaces the string-only
 * `primaryRailCmd` so the validator can evaluate the {@link SuccessPredicate}
 * (T-1) instead of trusting an exit code. `cmd` construction (e.g. `python
 * "<repro>"`) is the adapter's job; the SHAPE is core.
 */
export interface PrimaryRailStep {
  readonly kind: VerificationStepKind
  readonly cmd: string
  readonly authority: "execution" | "structure" | "exact-diff"
  readonly successPredicate: SuccessPredicate
  readonly pytestReportPath?: string
}
