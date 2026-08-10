/**
 * `@/runner/orchestrate` — surface-AGNOSTIC orchestration drivers.
 *
 * Public API:
 *   - `resolveResume(input)` + `isPathLikeToken` / `defaultUntitled` —
 *     surface-agnostic resume FSM. The CLI's resume helpers re-export
 *     from here.
 *   - `persistTurn(input)` — per-turn save plumbing. Both `state` (path-
 *     mode) and `idMeta` (id-mode) default OFF.
 *
 * Slice rules (RFC 3.1, enforced by biome):
 *   - May import `@/agent`, `@/llm`, `@/memory`, `@/observability`,
 *     `@/permission`, `@/session`, `@/shared`, `@/stream`, `@/tool`.
 *   - MUST NOT import from `apps/**` (any surface).
 *
 * Internal-only:
 *   - The legacy interactive/session compat owner now lives in
 *     `@/host/runtime/session-host`; runtime-SDK consumers go through
 *     `@/sdk/runtime`, while tests that pin old compat helpers import the
 *     concrete files directly.
 */

export type { ApprovalDecisionResult, NormalizedApprovalDecision } from "./approval-decision"
export {
  ApprovalDecisionResultError,
  isApprovedDecision,
  normalizeApprovalDecision,
} from "./approval-decision"
export type { CrashResumeMarkerArgs } from "./crash-resume-wire"
export {
  attachCrashResumePartial,
  bootstrapCrashResumeOffers,
  selectCrashResumeReinject,
  withCrashResumeMarker,
} from "./crash-resume-wire"
export { ExternalPromptQueue } from "./external-prompt-queue"
export type { PersistTurnInput } from "./persist-turn"
export { persistTurn } from "./persist-turn"
export type { ResolveResumeInput, ResumeResolution } from "./resume-fsm"
export { defaultUntitled, isPathLikeToken, resolveResume } from "./resume-fsm"
export type {
  ApprovalResolver,
  RunSessionTurnArgs,
  SessionTurnResult,
} from "./session-turn-driver"
export { runSessionTurn as driveSessionTurn } from "./session-turn-driver"
export {
  pinTurnBoundaryCwd,
  type WorktreeCwdPinArgs,
  type WorktreeCwdPort,
} from "./worktree-cwd-pin-wire"
export {
  type ReconcileClock,
  reconcileCreatingWorktreeAtResume,
  type WorktreeReconcileArgs,
} from "./worktree-reconcile-wire"
