/**
 * Pillar A — the AGGREGATED bench knob SSOT. `ALL_BENCH_SCHEMAS` lists every
 * authored {@link AnyKnobSchema} (one per bench knob) in the EXACT order the
 * entries appear in src/config/knob-inventory/bench.ts (envKey order). The
 * inventory `BENCH` array is DERIVED from this list
 * (`ALL_BENCH_SCHEMAS.map(deriveInventoryEntry)`), so the hand-maintained
 * parallel literal is gone and a new knob is declared ONCE (as a schema) here.
 *
 * ORDER IS LOAD-BEARING: the bench-inventory-cutover-identity test proves the
 * derived `BENCH` is byte-identical (same entries, same order, same fields) to
 * the pre-cutover hand-written array. Reordering this list, or adding/removing a
 * schema, changes `BENCH` and trips that gate.
 */

import type { AnyKnobSchema } from "../contracts"
import {
  benchInLoopExecSchema,
  branchSearchSchema,
  faultEvidenceSchema,
  issueHintExpectedActualSchema,
  issueHintSchema,
  noPatchBreakerSchema,
  patchHygieneSchema,
  primaryRailSchema,
  repairEscalationSchema,
  specFidelitySteerSchema,
  subagentSchema,
  verificationPlanSchema,
} from "./bench-a"
import {
  adversarialReproSchema,
  chaMultisiteGeneralSchema,
  chaMultisiteSteerSchema,
  closureRepairSchema,
  dynamicMessageMatcherSchema,
  forwardLocalizeSchema,
  localizeBudgetSchema,
  modelLaneDiversitySchema,
  pairedControlSchema,
  patchBudgetSchema,
  patchBudgetStrictSchema,
  regressionMaxTestsSchema,
  repairBreadthSchema,
  repairSpecGateSchema,
  specFidelityInvariantSchema,
  verifySelectConcurrencySchema,
  verifySelectLlmRiskGateSchema,
  verifySelectSchema,
} from "./bench-b"
import {
  closeoutGuardSchema,
  hooksSchema,
  multiVoterSchema,
  verifySelectRegressionSchema,
  verifySelectReproSchema,
  workingStateSchema,
} from "./bench-c"
import {
  lspCheapSchema,
  lspSchema,
  lspSteerSchema,
  mustPassSchema,
  skillsSchema,
  verifySelectCounterfactualSchema,
  verifySelectEarlyAcceptSchema,
  verifySelectProofRequiredSchema,
  verifySelectRiskGateSchema,
} from "./bench-gap-1"
import {
  campaignIdSchema,
  fullRemoteAmiSchema,
  fullRemoteConcurrencySchema,
  fullRemoteInstanceTypeSchema,
  fullRemoteOndemandSchema,
  fullRemoteReadyPollsSchema,
  instanceIdSchema,
  modelLanesSchema,
  resumeIamProfileSchema,
  resumeS3BucketSchema,
  resumeSchema,
} from "./bench-gap-2"
import {
  benchClosureDiagSchema,
  benchConcurrencySchema,
  benchExposeDatasetVerifierSchema,
  benchFindRefsSchema,
  benchPresetSchema,
  benchProtectTestsSchema,
  benchRecordTrajectorySchema,
  benchReplayOnMissSchema,
  benchReplayTrajectorySchema,
  benchSiblingSchema,
  benchSimplicitySchema,
  benchSotaSchema,
  noPatchForceFractionSchema,
} from "./bench-gap-3"
import {
  localizePhaseSchema,
  repoMapSchema,
  retryTransientSchema,
  selectorModeSchema,
} from "./bench-loop"
import {
  reproDoubtSchema,
  reproExecTimeoutSchema,
  reproTestSchema,
  reproVoteSchema,
} from "./bench-repro"

/**
 * ALL 76 bench knob schemas, IN THE EXACT ORDER their entries appear in
 * src/config/knob-inventory/bench.ts (envKey order). Do NOT reorder.
 */
export const ALL_BENCH_SCHEMAS: readonly AnyKnobSchema[] = [
  benchSotaSchema, // QUANTA_BENCH_SOTA
  lspSchema, // QUANTA_BENCH_LSP
  subagentSchema, // QUANTA_BENCH_SUBAGENT
  benchRecordTrajectorySchema, // QUANTA_BENCH_RECORD_TRAJECTORY
  benchReplayTrajectorySchema, // QUANTA_BENCH_REPLAY_TRAJECTORY
  benchReplayOnMissSchema, // QUANTA_BENCH_REPLAY_ON_MISS
  benchClosureDiagSchema, // QUANTA_BENCH_CLOSURE_DIAG
  fullRemoteConcurrencySchema, // QUANTA_FULL_REMOTE_CONCURRENCY
  skillsSchema, // QUANTA_BENCH_SKILLS
  localizePhaseSchema, // QUANTA_BENCH_LOCALIZE_PHASE
  branchSearchSchema, // QUANTA_BENCH_BRANCH_SEARCH
  issueHintSchema, // QUANTA_BENCH_ISSUE_HINT
  issueHintExpectedActualSchema, // QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL
  reproTestSchema, // QUANTA_BENCH_REPRO_TEST
  benchInLoopExecSchema, // QUANTA_BENCH_IN_LOOP_EXEC
  retryTransientSchema, // QUANTA_BENCH_RETRY_TRANSIENT
  benchPresetSchema, // QUANTA_BENCH_PRESET
  benchConcurrencySchema, // QUANTA_BENCH_CONCURRENCY
  faultEvidenceSchema, // QUANTA_BENCH_FAULT_EVIDENCE
  verificationPlanSchema, // QUANTA_BENCH_VERIFICATION_PLAN
  primaryRailSchema, // QUANTA_BENCH_PRIMARY_RAIL
  patchHygieneSchema, // QUANTA_BENCH_PATCH_HYGIENE
  noPatchBreakerSchema, // QUANTA_BENCH_NO_PATCH_BREAKER
  repairEscalationSchema, // QUANTA_BENCH_REPAIR_ESCALATION
  specFidelitySteerSchema, // QUANTA_BENCH_SPEC_FIDELITY_STEER
  specFidelityInvariantSchema, // QUANTA_BENCH_SPEC_FIDELITY_INVARIANT
  dynamicMessageMatcherSchema, // QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER
  repairSpecGateSchema, // QUANTA_BENCH_REPAIR_SPEC_GATE
  repairBreadthSchema, // QUANTA_BENCH_REPAIR_BREADTH
  forwardLocalizeSchema, // QUANTA_BENCH_FORWARD_LOCALIZE
  chaMultisiteSteerSchema, // QUANTA_BENCH_CHA_MULTISITE_STEER
  chaMultisiteGeneralSchema, // QUANTA_BENCH_CHA_MULTISITE_GENERAL
  pairedControlSchema, // QUANTA_BENCH_PAIRED_CONTROL
  modelLaneDiversitySchema, // QUANTA_BENCH_MODEL_LANE_DIVERSITY
  modelLanesSchema, // QUANTA_BENCH_MODEL_LANES
  closureRepairSchema, // QUANTA_BENCH_CLOSURE_REPAIR
  lspSteerSchema, // QUANTA_BENCH_LSP_STEER
  lspCheapSchema, // QUANTA_BENCH_LSP_CHEAP
  patchBudgetSchema, // QUANTA_BENCH_PATCH_BUDGET
  patchBudgetStrictSchema, // QUANTA_BENCH_PATCH_BUDGET_STRICT
  reproVoteSchema, // QUANTA_BENCH_REPRO_VOTE
  adversarialReproSchema, // QUANTA_BENCH_ADVERSARIAL_REPRO
  reproDoubtSchema, // QUANTA_BENCH_REPRO_DOUBT
  verifySelectSchema, // QUANTA_BENCH_VERIFY_SELECT
  reproExecTimeoutSchema, // QUANTA_BENCH_REPRO_EXEC_TIMEOUT_MS
  localizeBudgetSchema, // QUANTA_BENCH_LOCALIZE_BUDGET
  noPatchForceFractionSchema, // QUANTA_BENCH_NO_PATCH_FORCE_FRACTION
  regressionMaxTestsSchema, // QUANTA_BENCH_REGRESSION_MAX_TESTS
  verifySelectConcurrencySchema, // QUANTA_BENCH_VERIFY_SELECT_CONCURRENCY
  verifySelectEarlyAcceptSchema, // QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT
  verifySelectRiskGateSchema, // QUANTA_BENCH_VERIFY_SELECT_RISK_GATE
  verifySelectLlmRiskGateSchema, // QUANTA_BENCH_VERIFY_SELECT_LLM_RISK_GATE
  verifySelectProofRequiredSchema, // QUANTA_BENCH_VERIFY_SELECT_PROOF_REQUIRED
  selectorModeSchema, // QUANTA_BENCH_SELECTOR_MODE
  verifySelectCounterfactualSchema, // QUANTA_BENCH_VERIFY_SELECT_COUNTERFACTUAL
  verifySelectRegressionSchema, // QUANTA_BENCH_VERIFY_SELECT_REGRESSION
  verifySelectReproSchema, // QUANTA_BENCH_VERIFY_SELECT_REPRO
  benchFindRefsSchema, // QUANTA_BENCH_FIND_REFS
  benchSimplicitySchema, // QUANTA_BENCH_SIMPLICITY
  benchSiblingSchema, // QUANTA_BENCH_SIBLING
  benchProtectTestsSchema, // QUANTA_BENCH_PROTECT_TESTS
  hooksSchema, // QUANTA_BENCH_HOOKS
  workingStateSchema, // QUANTA_BENCH_WORKING_STATE
  closeoutGuardSchema, // QUANTA_BENCH_CLOSEOUT
  repoMapSchema, // QUANTA_REPO_MAP
  multiVoterSchema, // QUANTA_MULTI_VOTER
  mustPassSchema, // QUANTA_BENCH_MUST_PASS
  fullRemoteAmiSchema, // QUANTA_FULL_REMOTE_AMI
  fullRemoteInstanceTypeSchema, // QUANTA_FULL_REMOTE_INSTANCE_TYPE
  fullRemoteOndemandSchema, // QUANTA_FULL_REMOTE_ONDEMAND
  fullRemoteReadyPollsSchema, // QUANTA_FULL_REMOTE_READY_POLLS
  benchExposeDatasetVerifierSchema, // QUANTA_BENCH_EXPOSE_DATASET_VERIFIER
  resumeSchema, // QUANTA_BENCH_RESUME
  resumeS3BucketSchema, // QUANTA_BENCH_RESUME_S3_BUCKET
  campaignIdSchema, // QUANTA_BENCH_CAMPAIGN_ID
  resumeIamProfileSchema, // QUANTA_BENCH_RESUME_IAM_PROFILE
  instanceIdSchema, // QUANTA_BENCH_INSTANCE_ID
]
