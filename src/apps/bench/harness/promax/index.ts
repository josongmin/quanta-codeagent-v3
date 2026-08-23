/**
 * PMX-03 — the ONE ProMax evaluator-harness surface.
 *
 * What lives here: the pinned evaluator's output schema, the argv/predictions
 * boundary, the classification table, the gold-sentinel contract, and the
 * adapter that projects one evaluator run into the GENERIC official-grade
 * receipt owned by `@/runner/batch/eval/official-grade`.
 *
 * What deliberately does NOT live here: any reimplementation of `test_run.py`.
 * The evaluator is an immutable executable dependency — invoked and classified,
 * never copied, patched, or corrected.
 *
 * DEFERRED (not in this stage): the process spawn itself, live Docker, and
 * threading the disposition through `InstanceResult`/report. Each consumes the
 * types exported here without changing them.
 */
export {
  buildProMaxOfficialGradeReceipt,
  type ProMaxEvaluatorRun,
  type ProMaxGradeInput,
} from "./adapter"
export {
  admitProMaxCampaignForLaunch,
  freezeProMaxCampaignImages,
  PROMAX_FREEZE_STAGE_REASONS,
  PROMAX_FREEZE_STAGES,
  type ProMaxCampaignAdmissionInput,
  type ProMaxCampaignFreeze,
  type ProMaxCampaignFreezeInput,
  type ProMaxCampaignFreezeRefused,
  type ProMaxCampaignFrozen,
  type ProMaxFreezeStage,
} from "./campaign-freeze"
export {
  assertClassificationTablesInSync,
  type ClassificationTables,
  classifyOfficialPair,
  classifyWithTables,
  GOLDEN_AUTHORITY_TABLE,
  type GoldenAuthority,
  MODEL_OUTCOME_TABLE,
  type ModelOutcome,
  PRODUCTION_CLASSIFICATION_TABLES,
} from "./classify"
export {
  type BuildProMaxBootstrapSpecInput,
  buildProMaxBootstrapPlan,
  buildProMaxBootstrapSpec,
  evaluateProMaxBootstrapReadiness,
  PROMAX_BOOTSTRAP_STEPS,
  PROMAX_MIN_FREE_DISK_BYTES,
  type ProMaxBootstrapCommand,
  type ProMaxBootstrapObservation,
  type ProMaxBootstrapStep,
  type ProMaxEvaluatorBootstrapSpec,
  type ProMaxUpstreamFile,
} from "./evaluator-bootstrap"
export { PROMAX_EVALUATOR_PYTHON_FLOOR } from "./evaluator-python"
export {
  buildProMaxEvaluatorIdentity,
  buildProMaxGateReceiptDocument,
  checkProMaxGatePython,
  countVerdicts,
  PROMAX_EVALUATOR_ID,
  PROMAX_GATE_RECEIPT_FILENAME,
  PROMAX_GOLD_SENTINEL_GATE,
  PROMAX_MODEL_SMOKE_GATE,
  PROMAX_PASS_RATE_FILENAME,
  PROMAX_PREDICTIONS_FILENAME,
  PROMAX_V1_EVALUATOR_PINS,
  type ProMaxEvaluatorPins,
  type ProMaxGateGraded,
  type ProMaxGateJudged,
  type ProMaxGateName,
  type ProMaxGateProduced,
  type ProMaxGateReceiptDocument,
  type ProMaxGateRefusal,
  type ProMaxGateRefused,
  type ProMaxGateRunInput,
  type ProMaxGateRunPorts,
  type ProMaxGateRunResult,
  type ProMaxGateStage,
  type ProMaxIdentityInput,
  type ProMaxIdentityResult,
  type ProMaxSpawnObservation,
  type ProMaxVerdictCount,
  type ProMaxVerifiedEvaluator,
  type ProMaxVerifyResult,
  runProMaxGate,
  verifyPinnedEvaluator,
} from "./gate-run"
export {
  buildGoldSentinelPatch,
  evaluateGoldSentinelGate,
  type GoldSentinelGateFailure,
  type GoldSentinelGateFailureCode,
  type GoldSentinelGateResult,
  goldSentinelPath,
  goldSentinelPathToken,
} from "./gold-sentinel"
export {
  assertGoldenDerivationIsImageOnly,
  CAMPAIGN_GOLDEN_MUTABLE_FIELD,
  type CampaignGoldenDerivation,
  type CampaignGoldenDerived,
  type CampaignGoldenPin,
  type CampaignGoldenRejected,
  type DeriveCampaignGoldenInput,
  deriveCampaignGolden,
  diffGoldenDocuments,
  GOLDEN_DIFF_VIOLATION_CODES,
  GOLDEN_DIFF_VIOLATION_REASONS,
  type GoldenDerivationFailure,
  type GoldenDerivationFailureCode,
  type GoldenDiffViolation,
  type GoldenDiffViolationCode,
  type GoldenFieldChange,
  type GoldenStructuralDiff,
  type GoldenStructuralDiffOk,
} from "./golden-derive"
export {
  assertImageFreezeReadyForModelLaunch,
  isDigestPinnedReference,
  PROMAX_DIGEST_REFERENCE_RE,
  PROMAX_IMAGE_FAULT_CODES,
  PROMAX_IMAGE_FAULT_REASONS,
  PROMAX_REQUIRED_ARCHITECTURE,
  PROMAX_REQUIRED_OS,
  type ProMaxArtifactDigest,
  type ProMaxImageFault,
  type ProMaxImageFaultCode,
  type ProMaxImageFreezeReceipt,
  type ProMaxImageReceiptFailure,
  type ProMaxImageReceiptFailureCode,
  type ProMaxImageReceiptParse,
  type ProMaxImageRecord,
  type ProMaxPreflightStage,
  parseProMaxImageFreezeReceipt,
  serializeProMaxImageFreezeReceipt,
} from "./image-freeze"
export {
  type DockerPort,
  PROMAX_PREFLIGHT_CP_TARGET,
  type ProMaxImagePreflightInput,
  type ProMaxImageTarget,
  proMaxPreflightContainerName,
  proMaxPreflightProbeScript,
  runProMaxImagePreflight,
} from "./image-preflight"
export {
  buildProMaxEvaluatorInvocation,
  PROMAX_EVAL_META_RELATIVE_PATH,
  PROMAX_EVALUATOR_RELATIVE_PATH,
  type ProMaxEvaluatorInvocation,
  type ProMaxEvaluatorInvocationInput,
  type ProMaxInvocationFailure,
  type ProMaxInvocationFailureCode,
  type ProMaxInvocationResult,
  type ProMaxPrediction,
  type ProMaxPredictionFailure,
  type ProMaxPredictionFailureCode,
  type ProMaxPredictionRow,
  type ProMaxPredictionsResult,
  serializeProMaxPredictions,
} from "./invocation"
export {
  isOfficialFinalResult,
  OFFICIAL_FINAL_RESULTS,
  type OfficialDocumentParse,
  type OfficialFinalResult,
  type OfficialRowAccepted,
  type OfficialRowDrifted,
  type OfficialRowParse,
  type OfficialSideDrift,
  type OfficialSideRecord,
  parseOfficialPassRateDocument,
  parseOfficialPassRateRow,
} from "./official-result"
export {
  buildProMaxSubmission,
  type ProMaxSubmission,
  type ProMaxSubmissionFailure,
  type ProMaxSubmissionResult,
  type ProMaxSubmittedPatch,
} from "./submission"
