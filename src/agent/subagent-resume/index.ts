/**
 * Barrel for SUBAGENT WORK-RESUME family.
 *  - Phase 2 (ADR-0159): resume policy + orchestrator
 *  - Phase 2.5 (ADR-0166): conversation-seed replay
 *  - Phase 3 (ADR-0174): tool-history replay (idempotency + tool-history +
 *    tool-replay)
 *
 * No code in this slice is wired to the agent loop / dispatch / apps
 * bootstrap — callers opt in by constructing a scheduler + store + policy
 * + (optional) replay/tool-replay wires and invoking
 * {@link resumeInterruptedHandles} directly. Same default-OFF posture as
 * ADR-0158.
 */

export {
  DEFAULT_IDEMPOTENCY_TABLE,
  defaultIdempotencyClassifier,
  type IdempotencyClassifier,
  type IdempotencyTier,
} from "./idempotency"
export {
  alwaysResumePolicy,
  askUserResumePolicy,
  type DefaultResumePolicyOpts,
  defaultResumePolicy,
  type ResumeDecision,
  type ResumePolicy,
} from "./policy"
export {
  alwaysReplayPolicy,
  buildReplaySpec,
  type DefaultReplayPolicyOpts,
  defaultReplayPolicy,
  type ReplayContext,
  type ReplayDecision,
  type ReplayedSpec,
  type ReplayPolicy,
  skipReplayPolicy,
} from "./replay"
export {
  type ResumeOutcome,
  type ResumerOpts,
  resumeInterruptedHandles,
} from "./resumer"
export {
  defaultJsonlToolHistoryStore,
  hashToolArgs,
  type JsonlToolHistoryStoreOpts,
  type ToolCallRecord,
  type ToolHistoryStore,
} from "./tool-history"
export {
  defaultToolReplayPolicy,
  type ReplayToolHistoryOpts,
  replayToolHistory,
  type ShadowCommitRestorer,
  type ToolReplayDecision,
  type ToolReplayOutcome,
  type ToolReplayPolicy,
} from "./tool-replay"
