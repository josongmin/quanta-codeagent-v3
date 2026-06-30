/**
 * T-301 — VerificationPlan: the typed "what proof is required before done"
 * artifact. Selection authority is PUBLIC evidence only (a synthesized/selected
 * repro, an owner-near test, a touched-module smoke). Hidden bench labels, gold
 * patch hints, and same-model self-critique are NEVER counted as required
 * verification — self-critique stays advisory.
 */

export type VerificationStepKind = "repro" | "owner-test" | "module-smoke"

/**
 * Closed (v1) discriminated union of success contracts. Each shape is a typed
 * proof obligation — "run the command and inspect loosely" is NOT admissible.
 *
 * - `authority` of the step says HOW the proof is read:
 *   - `execution`  ⇒ run-and-observe (exit code / stdout / stderr)
 *   - `structure`  ⇒ AST/DOM/symbolic shape match
 *   - `exact-diff` ⇒ exact string/repr/latex equality against a public expected
 */
export type SuccessPredicate =
  | { type: "stdout_exact_empty" }
  | { type: "stdout_contains"; substring: string }
  | { type: "stderr_absent" }
  | { type: "symbolic_repr_equals"; expectedRepr: string }
  | { type: "ast_or_dom_shape"; shape: string }
  | { type: "latex_or_string_exact"; expected: string }
  | { type: "test_exit_zero" }
  | { type: "selected_test_passes"; selector?: string }

/** All admissible v1 successPredicate discriminants (closed set). */
export type SuccessPredicateKind = SuccessPredicate["type"]

/** Optional negative contract: what observed signal counts as a hard failure. */
export type FailurePredicate =
  | { type: "stderr_present" }
  | { type: "stdout_contains"; substring: string }
  | { type: "test_exit_nonzero" }

/** How the step's proof is read. */
export type VerificationAuthority = "execution" | "structure" | "exact-diff"

export interface VerificationStep {
  kind: VerificationStepKind
  /** Concrete command to run (deterministic, public). */
  cmd: string
  /**
   * How this step's proof is read. Required steps always carry one.
   * Optional on the type for back-compat of loosely-attached optional steps.
   */
  authority?: VerificationAuthority
  /**
   * Typed proof obligation. The builder ALWAYS attaches one to required steps;
   * kept optional on the type so back-compat optional steps need not carry one.
   */
  successPredicate?: SuccessPredicate
  /** Optional negative contract (observed signal that hard-fails the step). */
  failurePredicate?: FailurePredicate
  /** Structured pytest sidecar path for synthesized repro steps. */
  pytestReportPath?: string
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
  /** True iff the SELECTED primary rail itself was actually observed RED on the
   *  unpatched base tree. Absent ⇒ legacy objects / tests; treat as false. */
  primaryRailBaseValidatedRed?: boolean
}

export interface VerificationPlanInput {
  /** Synthesized/installed repro. Becomes primaryRail ONLY if baseValidatedRed. */
  reproScript?: { cmd: string; baseValidatedRed: boolean; pytestReportPath?: string }
  /** Owner-near test commands (public). */
  ownerNearTests?: readonly string[]
  /** Base-tree RED proof for the PRIMARY owner-test candidate. */
  ownerNearPrimaryBaseValidatedRed?: boolean
  /** Touched-module smoke commands (post-edit info). */
  touchedModuleSmoke?: readonly string[]
  /**
   * Issue-declared expected output (PUBLIC problem-statement text). When the
   * issue exposes a concrete expected/observed output, it is encoded as the
   * successPredicate of the primary/required step (gap-B spec-fidelity rail).
   * This is public INPUT — never a hidden oracle / gold label.
   *
   * - `latex`        ⇒ `latex_or_string_exact`
   * - `symbolic`     ⇒ `symbolic_repr_equals`
   * - `stdout`       ⇒ `stdout_contains`
   * - `stdout-empty` ⇒ `stdout_exact_empty` (the issue declares the correct
   *                    behavior is to emit NOTHING — e.g. pylint
   *                    `min-similarity-lines=0` should report no duplicates;
   *                    `value` carries the human description, not a substring).
   */
  issueDeclaredExpected?: { value: string; kind?: "latex" | "symbolic" | "stdout" | "stdout-empty" }
  /** Required-step cap (default 3). */
  maxRequired?: number
}
