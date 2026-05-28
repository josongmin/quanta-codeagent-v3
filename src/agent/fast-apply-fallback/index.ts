/** Fast-apply fallback slice barrel (ADR-0417, absorption gap A2). */
export {
  buildFastApplyPrompt,
  createFastApplyFallback,
  extractPatchBlock,
} from "./runner"
export type {
  FastApplyAttemptResult,
  FastApplyFailure,
  FastApplyFallbackDeps,
  FastApplyFallbackPort,
  RoleResolverLike,
  SideConversationLike,
} from "./types"
