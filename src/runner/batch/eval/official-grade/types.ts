/**
 * PMX-03 — the app-independent official-grade contract.
 *
 * ONE vocabulary for "what did an official, out-of-process grader say about
 * this instance", shared by every SWE dataset family (Verified / Live / Pro /
 * ProMax). Runner and report code depend on THIS module; they never import an
 * `apps/bench` type, so no benchmark family can smuggle its private verdict
 * shape into the reporting spine.
 *
 * Everything here is PURE data + closed unions. No I/O, no clock, no env.
 *
 * THE INVARIANT THIS FILE EXISTS FOR: `missing` is not a state. No grader emits
 * it and no adapter may fabricate it. It is derived, once, as
 * `assigned - keys(dispositions)` (see `deriveMissingInstanceIds`). A fifth
 * enum member would let a chunk that was never graded pose as a graded result.
 */

/**
 * The four honest outcomes an official grader run can produce for an instance
 * it actually reported on.
 *
 * - `resolved`      the grader's own authority says the model fixed it;
 * - `model_miss`    grading was valid and the model did not fix it;
 * - `infra_invalid` grading itself was not trustworthy (grader/env/schema);
 * - `ambiguous`     the grader explicitly declined to decide.
 */
export type OfficialGradeState = "resolved" | "model_miss" | "infra_invalid" | "ambiguous"

/**
 * Stable, typed reasons. These are report/dashboard-facing identifiers: they
 * are appended to, never renamed, so old campaign reports keep meaning what
 * they said.
 */
export type OfficialGradeReason =
  // resolved
  | "official_resolved"
  // model_miss — grading valid, model did not fix the instance
  | "patch_apply_failed"
  | "test_patch_apply_failed"
  | "model_apply_timeout"
  | "model_eval_timeout"
  | "test_failed"
  // ambiguous — the grader declined to decide
  | "upstream_need_human_review"
  // infra_invalid — the reference/golden side failed, so nothing about the
  // model can be concluded from this row
  | "golden_apply_failed"
  | "golden_test_patch_apply_failed"
  | "golden_timeout_apply"
  | "golden_timeout_eval"
  | "golden_non_zero_exit"
  // infra_invalid — the grader run itself is not trustworthy evidence
  | "schema_invalid"
  | "evaluator_no_output"
  | "evaluator_nonzero_exit"
  | "evaluator_unavailable"

/**
 * Reason → owning state. `Record<OfficialGradeReason, …>` is the exhaustiveness
 * lever: a new reason that nobody classified is a COMPILE error, and the
 * receipt builder rejects any disposition whose declared state disagrees with
 * this table, so the pair can never drift apart at runtime either.
 */
export const OFFICIAL_GRADE_STATE_BY_REASON: Record<OfficialGradeReason, OfficialGradeState> = {
  official_resolved: "resolved",
  patch_apply_failed: "model_miss",
  test_patch_apply_failed: "model_miss",
  model_apply_timeout: "model_miss",
  model_eval_timeout: "model_miss",
  test_failed: "model_miss",
  upstream_need_human_review: "ambiguous",
  golden_apply_failed: "infra_invalid",
  golden_test_patch_apply_failed: "infra_invalid",
  golden_timeout_apply: "infra_invalid",
  golden_timeout_eval: "infra_invalid",
  golden_non_zero_exit: "infra_invalid",
  schema_invalid: "infra_invalid",
  evaluator_no_output: "infra_invalid",
  evaluator_nonzero_exit: "infra_invalid",
  evaluator_unavailable: "infra_invalid",
}

/** Runtime drift-guard companion — the other direction of the same pin. */
export const OFFICIAL_GRADE_REASONS = Object.keys(
  OFFICIAL_GRADE_STATE_BY_REASON,
) as readonly OfficialGradeReason[]

/**
 * `grading_valid` is DERIVED from the state, never declared independently.
 * `Record<OfficialGradeState, boolean>` makes a new state a compile error here.
 */
export const GRADING_VALID_BY_STATE: Record<OfficialGradeState, boolean> = {
  resolved: true,
  model_miss: true,
  infra_invalid: false,
  ambiguous: false,
}

export const OFFICIAL_GRADE_STATES = Object.keys(
  GRADING_VALID_BY_STATE,
) as readonly OfficialGradeState[]

export const isOfficialGradeState = (value: unknown): value is OfficialGradeState =>
  typeof value === "string" && Object.hasOwn(GRADING_VALID_BY_STATE, value)

export const isOfficialGradeReason = (value: unknown): value is OfficialGradeReason =>
  typeof value === "string" && Object.hasOwn(OFFICIAL_GRADE_STATE_BY_REASON, value)

/**
 * An immutable pointer to retained raw grader evidence. The report carries the
 * path and digest; the (possibly enormous) bytes stay beside it. Truncating the
 * only copy of the evidence is not an option.
 */
export interface RawArtifactRef {
  readonly path: string
  /** lowercase hex sha256 over the artifact's exact bytes. */
  readonly sha256: string
  readonly byteLength: number
}

/**
 * One side (model / reference) of a grader's per-instance verdict, reduced to
 * IDENTITY fields only.
 *
 * Deliberately NO `stdout` / `stderr`. The reference side's output is
 * grader-only material; keeping it out of the disposition means a report,
 * dashboard, or prompt cannot leak it even by accident. The full streams live
 * in the raw artifact referenced above.
 */
export interface OfficialEvaluatorSideSummary {
  /** the grader's verdict string, VERBATIM — including an unrecognized one. */
  readonly finalResult: string
  readonly rawReason: string
  readonly returncode: number | null
  readonly scriptExitCode: number | null
}

/** The grader's per-instance record, reduced for audit. */
export interface OfficialEvaluatorSummary {
  /**
   * The grader's own top-level pass flag, RETAINED FOR AUDIT ONLY. It is never
   * sufficient on its own to produce `resolved` — see the family classifier.
   * `null` when the grader did not emit a usable boolean.
   */
  readonly passed: boolean | null
  readonly model: OfficialEvaluatorSideSummary | null
  readonly golden: OfficialEvaluatorSideSummary | null
}

/** What an official grader concluded about ONE assigned instance. */
export interface OfficialGradeDisposition {
  readonly instanceId: string
  readonly state: OfficialGradeState
  readonly reason: OfficialGradeReason
  /** Derived from `state`; the builder rejects a value that disagrees. */
  readonly gradingValid: boolean
  /**
   * Raw evidence pointer. `null` ONLY when the grader produced no artifact at
   * all — which the builder allows exclusively for `infra_invalid`, so a
   * scored outcome can never be evidence-free.
   */
  readonly rawArtifact: RawArtifactRef | null
  readonly evaluator: OfficialEvaluatorSummary
  /**
   * AUDIT-ONLY: the submitted prediction carried no patch bytes. Recorded so
   * the legacy `emptyPatch` bucket can still be derived. It NEVER influences
   * `state` or `reason` — an empty prediction under a healthy reference is a
   * model miss, not an infrastructure hole.
   */
  readonly predictionEmpty?: boolean | undefined
}

/** Identity of the grader binary/script a campaign actually ran. */
export interface OfficialEvaluatorIdentity {
  /** stable family/grader id, e.g. `swe-bench-promax`. */
  readonly evaluatorId: string
  readonly upstreamCommit: string
  readonly evaluatorPath: string
  readonly evaluatorSha256: string
  readonly argv: readonly string[]
  readonly cwd: string
}

/**
 * Grader identity PLUS the observed run. `stdout`/`stderr` here are the
 * WRAPPER-level streams of the grader process; they are grader-only material
 * and must never reach an agent-visible surface.
 */
export interface OfficialGradeEvaluatorMeta extends OfficialEvaluatorIdentity {
  /** `null` when the process never delivered an exit status (killed/crashed). */
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly outputArtifact: RawArtifactRef | null
}

/**
 * WHICH CONTAINER IMAGE produced a verdict, pinned by repo digest.
 *
 * A pass-rate document says an instance resolved; it does not say what it ran
 * inside. Two graders of the same evaluator bytes against a mutable `:latest`
 * tag are not the same experiment, and only the digest tells them apart. Kept
 * per-instance because a chunk's instances each have their own image.
 */
export interface OfficialGradeImageRef {
  readonly instanceId: string
  /** the tag the evaluator resolved — readability, never the pin. */
  readonly imageName: string
  /** `repo@sha256:…` — the actual pin. */
  readonly repoDigest: string
}

/**
 * The receipt. `assignedInstanceIds` is the DENOMINATOR of record: coverage is
 * computed against it, so a chunk that never came back cannot quietly shrink
 * the campaign.
 */
export interface OfficialGradeReceipt {
  readonly assignedInstanceIds: readonly string[]
  readonly dispositionsByInstanceId: ReadonlyMap<string, OfficialGradeDisposition>
  readonly evaluator: OfficialGradeEvaluatorMeta
  /** Absent ⇒ this grader captured no image provenance; the receipt is
   *  byte-identical to one built before this field existed. Present ⇒ every
   *  entry is a validated digest pin. */
  readonly images?: readonly OfficialGradeImageRef[]
}

/** Closed classification of every way a receipt can be refused. */
export type OfficialGradeReceiptFailureCode =
  | "assigned_id_invalid"
  | "assigned_id_duplicated"
  | "instance_id_invalid"
  | "disposition_duplicated"
  | "disposition_unassigned"
  /** the grader emitted a result that cannot be attributed to any instance. */
  | "row_unattributable"
  | "state_unknown"
  | "reason_unknown"
  | "state_reason_mismatch"
  | "grading_valid_mismatch"
  | "raw_artifact_missing"
  | "raw_artifact_invalid"
  | "evaluator_meta_invalid"
  /** an image pin was declared but is not a usable `repo@sha256:…` reference. */
  | "image_ref_invalid"
  | "receipt_unparseable"

export interface OfficialGradeReceiptFailure {
  readonly code: OfficialGradeReceiptFailureCode
  readonly message: string
}

export interface OfficialGradeReceiptAccepted {
  readonly ok: true
  readonly receipt: OfficialGradeReceipt
}

export interface OfficialGradeReceiptRejected {
  readonly ok: false
  readonly failures: readonly OfficialGradeReceiptFailure[]
}

/**
 * Fail-closed verdict. A consumer wanting dispositions must narrow on
 * `ok === true`, so a malformed receipt cannot reach reporting.
 */
export type OfficialGradeReceiptResult = OfficialGradeReceiptAccepted | OfficialGradeReceiptRejected

/**
 * The PMX-03 score contract. Rates are `null` — never `0`, never `NaN` — when
 * their denominator is zero, because "no data" and "zero percent" are different
 * claims.
 */
export interface OfficialGradeSummary {
  readonly assigned: number
  readonly resolved: number
  readonly modelMiss: number
  readonly infraInvalid: number
  readonly ambiguous: number
  /** DERIVED coverage gap: assigned ids with no disposition at all. */
  readonly missing: number
  readonly gradingValid: number
  /** resolved / grading_valid */
  readonly officialValidRate: number | null
  /** grading_valid / assigned */
  readonly coverage: number | null
  /** resolved / assigned */
  readonly rawRate: number | null
}
