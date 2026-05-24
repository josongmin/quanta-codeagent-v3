/**
 * Barrel for Phase 2 SUBAGENT WORK-RESUME (ADR-0159).
 *
 * Re-exports the resume-policy port + 3 stock policies + the orchestrator.
 * No code in this slice is wired to the agent loop / dispatch / apps
 * bootstrap — callers opt in by constructing a scheduler + store + policy
 * and invoking {@link resumeInterruptedHandles} directly. Same default-OFF
 * posture as ADR-0158.
 */

export {
  alwaysResumePolicy,
  askUserResumePolicy,
  type DefaultResumePolicyOpts,
  defaultResumePolicy,
  type ResumeDecision,
  type ResumePolicy,
} from "./policy"
export {
  type ResumeOutcome,
  type ResumerOpts,
  resumeInterruptedHandles,
} from "./resumer"
