/** Fast-apply fallback slice barrel (ADR-0417, absorption gap A2). */

/** jun-7-misc 06 (ADR ≥0497) — model-based fast-apply MERGE rung. */
export {
  buildMergePrompt,
  createFastApplyMerge,
  extractMergedFile,
  verifyMergeStructural,
} from "./merge-runner"
export {
  buildFastApplyPrompt,
  createFastApplyFallback,
  extractPatchBlock,
} from "./runner"
export type {
  ApplyRoleResolverLike,
  FastApplyAttemptResult,
  FastApplyFailure,
  FastApplyFallbackDeps,
  FastApplyFallbackPort,
  FastApplyMergeDeps,
  FastApplyMergeResult,
  FastApplyPort,
  RoleResolverLike,
  SideConversationLike,
} from "./types"
