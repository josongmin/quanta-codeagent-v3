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
  buildGoldSentinelPatch,
  evaluateGoldSentinelGate,
  type GoldSentinelGateFailure,
  type GoldSentinelGateFailureCode,
  type GoldSentinelGateResult,
  goldSentinelPath,
  goldSentinelPathToken,
} from "./gold-sentinel"
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
