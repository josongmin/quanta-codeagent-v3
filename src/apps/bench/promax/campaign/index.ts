/**
 * PMX-06 — the ONE campaign-gate surface.
 *
 * What lives here: the frozen campaign RECORD (the precondition), the six GATE
 * predicates over the landed receipt types, the versioned upstream-EXCEPTION
 * manifest, the source-owner AUDIT, and the verification RAILS.
 *
 * What deliberately does NOT live here: any execution. Every function is pure
 * over data the caller supplies, so a live campaign driver is a thin shell that
 * reads artefacts and calls these — and so the whole promotion policy is
 * testable without Docker, EC2, or a single model token.
 */

export {
  type CampaignCliPorts,
  PROMAX_CAMPAIGN_CLI_USAGE,
  runProMaxCampaignCli,
} from "./cli"
export {
  decodeProMaxArmEvidence,
  decodeProMaxChunks,
  decodeProMaxGateResults,
  decodeProMaxModelStageEvidence,
  decodeProMaxStageEvidence,
  type ProMaxDecode,
} from "./evidence-decode"
export {
  PROMAX_EXCEPTION_DISPOSITION_REASONS,
  PROMAX_EXCEPTION_DISPOSITIONS,
  type ProMaxExceptionDisposition,
  type ProMaxExceptionManifest,
  type ProMaxUpstreamException,
  validateExceptionManifest,
} from "./exceptions"
export {
  admitProMaxFullRun,
  evaluateProMaxCanaryGate,
  evaluateProMaxGoldGate,
  evaluateProMaxModelSmokeGate,
  evaluateProMaxPairedGate,
  PROMAX_GATE_FAILURE_CODES,
  PROMAX_GATE_FAILURE_REASONS,
  PROMAX_GATE_ORDER,
  PROMAX_GATE_SAMPLE,
  PROMAX_LEAKAGE_CHECK_IDS,
  PROMAX_LEAKAGE_CHECKS,
  type ProMaxArmEvidence,
  type ProMaxChunkEvidence,
  type ProMaxContinuationOutcome,
  type ProMaxGateCoverage,
  type ProMaxGateFailure,
  type ProMaxGateFailureCode,
  type ProMaxGateId,
  type ProMaxGateResult,
  type ProMaxGoldGateInput,
  type ProMaxLeakageCheckId,
  type ProMaxModelGateInput,
  type ProMaxModelStageEvidence,
  type ProMaxPairedRow,
  type ProMaxStageEvidence,
} from "./gates"
export {
  assertOwnerAuditAdmitsLiveSpend,
  auditProMaxSourceOwners,
  collectOwnerAuditSources,
  DETECTOR_IDS,
  type OwnerAuditHit,
  type OwnerAuditSourceFile,
  PROMAX_OWNER_AUDIT_BASELINE,
  PROMAX_OWNER_AUDIT_ROOTS,
  PROMAX_OWNER_CLASSES,
  PROMAX_OWNER_ROLES,
  type ProMaxOwnerAuditCounters,
  type ProMaxOwnerAuditReceipt,
  type ProMaxOwnerClass,
  type ProMaxOwnerRole,
} from "./owner-audit"
export {
  assertRailSelectionsNonEmpty,
  PROMAX_VERIFICATION_RAILS,
  type ProMaxRailKind,
  type ProMaxRailResolution,
  type ProMaxVerificationRail,
  railRelative,
  resolveProMaxVerificationRails,
} from "./rails"
export {
  type FreezeProMaxCampaignInput,
  freezeProMaxCampaignRecord,
  PROMAX_CAMPAIGN_RECORD_FAILURE_CODES,
  PROMAX_CAMPAIGN_RECORD_FAILURE_REASONS,
  PROMAX_CAMPAIGN_RECORD_VERSION,
  type ProMaxCampaignArm,
  type ProMaxCampaignArmInput,
  type ProMaxCampaignArmRole,
  type ProMaxCampaignBudgets,
  type ProMaxCampaignConcurrency,
  type ProMaxCampaignModel,
  type ProMaxCampaignModelInput,
  type ProMaxCampaignRecordFailure,
  type ProMaxCampaignRecordFailureCode,
  type ProMaxCampaignRecordResult,
  type ProMaxCampaignSampleRecord,
  type ProMaxContinuationRule,
  type ProMaxFrozenCampaignRecord,
  type ProMaxRecordedReasoningEffort,
  type ProMaxRetryPolicy,
  type ProMaxUpstreamExceptionPolicy,
  parseProMaxCampaignRecord,
  proMaxCampaignSample,
  serializeProMaxCampaignRecord,
} from "./record"
