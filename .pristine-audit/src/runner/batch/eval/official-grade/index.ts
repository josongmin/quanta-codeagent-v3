/**
 * PMX-03 — the ONE official-grade surface for runner/report code.
 *
 * Every SWE dataset family (Verified / Live / Pro / ProMax) adapts its grader
 * output INTO this contract; runner and report code consume only what is
 * exported here and never import a benchmark-family type.
 *
 * OWNERSHIP:
 *  - grader invocation, argv, and family-specific classification ... apps/bench
 *  - this generic disposition/receipt/score contract ............... runner
 *  - report envelope and dashboard rendering ....................... BFND-02/03
 */
export {
  LEGACY_BUCKET_BY_STATE,
  type LegacyBucketName,
  type LegacyBucketProjection,
  projectLegacyBuckets,
} from "./legacy-buckets"
export {
  type MergeOfficialGradeReceiptsInput,
  mergeOfficialGradeReceipts,
} from "./merge"
export {
  type BuildOfficialGradeReceiptInput,
  buildOfficialGradeReceipt,
  deriveMissingInstanceIds,
  parseOfficialGradeReceipt,
  serializeOfficialGradeReceipt,
  summarizeOfficialGrade,
} from "./receipt"
export {
  GRADING_VALID_BY_STATE,
  isOfficialGradeReason,
  isOfficialGradeState,
  OFFICIAL_GRADE_REASONS,
  OFFICIAL_GRADE_STATE_BY_REASON,
  OFFICIAL_GRADE_STATES,
  type OfficialEvaluatorIdentity,
  type OfficialEvaluatorSideSummary,
  type OfficialEvaluatorSummary,
  type OfficialGradeDisposition,
  type OfficialGradeEvaluatorMeta,
  type OfficialGradeReason,
  type OfficialGradeReceipt,
  type OfficialGradeReceiptAccepted,
  type OfficialGradeReceiptFailure,
  type OfficialGradeReceiptFailureCode,
  type OfficialGradeReceiptRejected,
  type OfficialGradeReceiptResult,
  type OfficialGradeState,
  type OfficialGradeSummary,
  type RawArtifactRef,
} from "./types"
