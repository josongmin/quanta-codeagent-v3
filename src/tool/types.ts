/**
 * PUBLIC TYPE BARREL for the `@/tool` slice — the stable `@/tool/types` import
 * path — plus the in-slice SEAM-MIRROR ANCHORS (the only runtime values this
 * module owns).
 *
 * The declarations themselves live in four cohesive sibling modules under
 * `./types/`, each named for one responsibility:
 *
 *   - `./types/tool-context`  — what a tool RECEIVES: the `ToolContext` seam
 *                               registry + the role-segmented `Pick` views.
 *   - `./types/context-seams` — the duck-typed MIRROR SHAPES those seams are
 *                               typed by (one per injecting slice).
 *   - `./types/tool-result`   — what a tool YIELDS: the `ToolResult` envelope,
 *                               the `ToolFailure` reason set, `ToolEvent`.
 *   - `./types/tool-contract` — what a tool IS: `Tool` and its five
 *                               Interface-Segregation groups + `ToolSpec`.
 *
 * Every name they declare is RE-EXPORTED verbatim below, so this module's
 * public surface is unchanged and no importer of `@/tool/types` (or of the
 * `@/tool` barrel) moves. The dependency edge is ONE-WAY — this file imports
 * the siblings; no sibling imports this file.
 */
import type { HITLTier } from "@/shared"
import type { BlockerSurface, GitWriteProtectReason } from "./types/context-seams"

/**
 * Re-export the FULL context-seam mirror surface (extracted to
 * `./types/context-seams.ts`) so every external importer of `@/tool/types`
 * keeps its byte-identical public API.
 */
export type {
  ActiveWorktree,
  BlockerSurface,
  CodeCellDispatchSeam,
  CriticalSectionHandle,
  CriticalSectionSeam,
  FastApplyAttemptResultMirror,
  FastApplyFailureKind,
  FastApplyFailureMirror,
  FastApplyFallbackSeam,
  FastApplyMergeResultMirror,
  FastApplyMergeReviewSeam,
  FastApplyMergeSeam,
  FileHistorySink,
  GitWriteGuard,
  GitWriteProtectReason,
  ObjectiveApprovalDecision,
  ObjectiveApprovalRequest,
  ObjectiveApprovalRequester,
  PlanDeltaKind,
  PlanEntryRequester,
  PlanExitRequester,
  PlanExitToolDecision,
  PlanExitToolOutcome,
  PlanMutationErrorCode,
  PlanMutationResult,
  PlanMutator,
  PlanMutatorNewTodo,
  PlanMutatorTodoPatch,
  PlanReadonlyView,
  ProgressSink,
  ProgressUpdateMirror,
  ProjectedPlanTaskView,
  ReviewerRequest,
  ReviewerResult,
  ReviewerRunner,
  ReviewFindingMirror,
  SessionConfigSeam,
  ShellSnapshotRestoreSeam,
  ToolDiffSink,
  UserInputOutcome,
  UserInputRequester,
  VcsEventMirror,
  VcsEventSink,
  WorkingStateHandle,
  WorkingStatePatch,
  WorkingStateSnapshot,
  WorktreeSlotHandle,
} from "./types/context-seams"

/**
 * Re-export the FULL execution-context surface (extracted to
 * `./types/tool-context.ts`) so every external importer of `@/tool/types`
 * keeps its byte-identical public API.
 */
export type {
  CoreToolContext,
  EditToolContext,
  PlanToolContext,
  ShellToolContext,
  SubagentToolContext,
  ToolContext,
} from "./types/tool-context"

/**
 * Re-export the FULL tool-contract surface (extracted to
 * `./types/tool-contract.ts`) so every external importer of `@/tool/types`
 * keeps its byte-identical public API.
 */
export type {
  Tool,
  ToolCore,
  ToolDynamicSpec,
  ToolInterruptPolicy,
  ToolResultShape,
  ToolSecurityHooks,
  ToolSpec,
  ToolStreamingInput,
} from "./types/tool-contract"

/**
 * Re-export the FULL tool-result / tool-failure surface (extracted to
 * `./types/tool-result.ts`) so every external importer of `@/tool/types` keeps
 * its byte-identical public API.
 */
export type {
  DeferredHandle,
  DeferredToolResult,
  DenyLayerMirror,
  DenyPillarMirror,
  DenyReasonValue,
  DenyStackSourceMirror,
  NextAction,
  SandboxViolationReason,
  ToolEvent,
  ToolFailure,
  ToolResult,
  ToolResultEvidence,
} from "./types/tool-result"

/**
 * Codex HITL 4-tier taxonomy (hitl-audit.md). Re-exported from the canonical
 * `@/shared` declaration — NOT redeclared — so the `@/tool` and `@/permission`
 * copies can never drift. `@/tool` reaching `@/shared` is allowed (the leaf
 * layer); biome only forbids the `@/tool ↔ @/permission` direction. Dispatch
 * still composes the two slices via duck-typing.
 */
export type { HITLTier }

/**
 * SEAM-MIRROR STRUCTURAL HASH (literal anchor; no cross-slice import).
 *
 * The `@/tool` slice CANNOT import from `@/agent` or `@/permission` (RFC §3.1
 * slice fence; biome enforces structurally), so a direct cross-slice
 * `Equals<>`/`satisfies` compile check is impossible HERE. The closed-union
 * mirrors above (`GitWriteProtectReason`, `BlockerSurface`) are documented as
 * convention-only — reviewers verify on PR and a consumer-side round-trip test
 * in `tests/unit/` (which CAN see both slices) catches drift at test time.
 *
 * This `as const` tuple is a literal grep anchor: a future drift in the union
 * literal MUST be reflected here too, and a consumer-side test asserts the
 * tuple matches the producer's `ALL_*` array. The `satisfies` clauses below
 * are pure in-slice checks — they verify the tuple's literal set matches THIS
 * file's mirror exactly (catches drift between the mirror and the anchor).
 *
 * If you add a 6th `GitWriteProtectReason`:
 *   1. add the literal to the producer (`src/permission/git-write-guard.ts`).
 *   2. add it to the mirror union above.
 *   3. add it to this anchor tuple.
 *   4. extend `ALL_GIT_WRITE_PROTECT_REASONS` in the producer.
 * Steps 2-3 are local — the satisfies below will fail to compile if you skip
 * either. Steps 1+4 are caught by the consumer-side round-trip test.
 */
export const GIT_WRITE_PROTECT_REASONS_MIRROR = [
  "git_hooks",
  "git_hooks_dir",
  "git_config",
  "git_attributes",
  "editor_config",
] as const satisfies ReadonlyArray<GitWriteProtectReason>

export const BLOCKER_SURFACES_MIRROR = [
  "type",
  "owner",
  "wire",
  "test",
  "runtime",
  "build",
  "other",
] as const satisfies ReadonlyArray<BlockerSurface>

// In-slice structural check: every literal in the closed mirror union must
// appear in the anchor tuple. A `satisfies` on the other direction — every
// anchor entry is a valid union member — is enforced by the `as const
// satisfies ReadonlyArray<…>` above. Together they pin the set exactly.
type _GitWriteProtectReasonAnchorCoversUnion =
  GitWriteProtectReason extends (typeof GIT_WRITE_PROTECT_REASONS_MIRROR)[number]
    ? true
    : { error: "GIT_WRITE_PROTECT_REASONS_MIRROR is missing a union member" }
type _BlockerSurfaceAnchorCoversUnion =
  BlockerSurface extends (typeof BLOCKER_SURFACES_MIRROR)[number]
    ? true
    : { error: "BLOCKER_SURFACES_MIRROR is missing a union member" }
// Force evaluation — if either lookup degrades to the error object the
// assignment fails at `tsc`, producing the message above.
const _gitWriteProtectReasonAnchorCheck: _GitWriteProtectReasonAnchorCoversUnion = true
const _blockerSurfaceAnchorCheck: _BlockerSurfaceAnchorCoversUnion = true
void _gitWriteProtectReasonAnchorCheck
void _blockerSurfaceAnchorCheck
