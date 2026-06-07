/**
 * ADR-0409 — Recovery-reason taxonomy (closed enum) + provenance shape.
 *
 * Compaction is currently a silent internal optimization: a transcript is
 * folded, the loop continues, and the user has no record of *why* the agent
 * "forgot" things. That breaks the resume contract — when a user picks up a
 * thread the next day, they should see a typed record of what happened during
 * compaction (token threshold? PTL recovery? operator override?) plus a
 * human-readable "resume from here" pointer.
 *
 * This file defines the CLOSED enum + the provenance record that ADR-0409
 * wires through `compaction.ts`'s `post_compact` hook event AND (optionally,
 * via injected port) into the Objective's `nextActions`.
 *
 * Slice fence: LEAF — pure types, ZERO imports. No `@/agent` core, no peer
 * slices, no `@/shared`. Importing this barrel touches no process state.
 *
 * exactOptional: optional fields are OMITTED when absent (never `: undefined`).
 */

/** Closed enum: every possible reason the agent's transcript was compacted.
 *  Adding a new variant requires an ADR + hellgate update (the enum is
 *  consumed exhaustively by post_compact consumers + observability emitters).
 *
 *  Arm meanings (verbatim):
 *  - `"token_budget_exceeded"` — primary trigger. `compactIfNeeded` saw the
 *    token estimate cross `thresholdTokens` (DEFAULT_THRESHOLD=120k by default).
 *  - `"ptl_reactive"` — mid-stream prompt-too-long recovery. The provider
 *    returned a PTL-shaped error and `reactiveCompact` salvaged the transcript.
 *  - `"drift_breaker"` — the {@link CompactionBreaker} (ADR-0011 thrash guard)
 *    forced a compaction after the no-progress counter exceeded its threshold.
 *  - `"manual"` — operator/agent invoked compaction explicitly (e.g. via a
 *    future `/compact` tool or `force_now` from the preflight HITL hook).
 *  - `"context_change"` — ADR-0321 context-change detector fired (file/git
 *    state diverged from the transcript's assumptions; partial reset is
 *    cheaper than continuing with stale context).
 *  - `"fork_branch"` — a session fork created a new compaction point on the
 *    parent (the fork inherits a snapshot; the parent records the split).
 *  - `"microcompact"` — a tier-1 tool_result eviction (the orphan-safe
 *    `microcompactToolResults` in `tool-result-evict`) replaced bulky tool
 *    output with a spill reference rather than a full transcript reset.
 */
export type RecoveryReason =
  | "token_budget_exceeded"
  | "ptl_reactive"
  | "drift_breaker"
  | "manual"
  | "context_change"
  | "fork_branch"
  | "microcompact"

/** Frozen list of every variant, in declaration order. Consumers that need
 *  to iterate (e.g. an enum-round-trip test, a metrics emitter labelling
 *  buckets) read this rather than re-listing strings.
 *
 *  Kept `as const readonly` so it stays a tuple of literal types — a stray
 *  push() would tsc-fail. */
export const RECOVERY_REASONS: readonly RecoveryReason[] = Object.freeze([
  "token_budget_exceeded",
  "ptl_reactive",
  "drift_breaker",
  "manual",
  "context_change",
  "fork_branch",
  "microcompact",
] as const)

/** Typed runtime guard. Returns `true` ONLY when `v` is a `RecoveryReason`
 *  literal. Used by the hook subscriber + the test harness to reject typo'd
 *  reasons at the bus boundary instead of letting them through as `string`. */
export const isRecoveryReason = (v: unknown): v is RecoveryReason =>
  typeof v === "string" && (RECOVERY_REASONS as readonly string[]).includes(v)

/**
 * Provenance record carried on every `post_compact` event. Everything readonly
 * — provenance is observed, never mutated by a downstream consumer.
 *
 * Fields:
 * - `reason`: WHY the compaction happened (closed enum above).
 * - `tokensBefore` / `tokensAfter`: pre-/post-compaction token estimates.
 *   Both are integers >= 0; `tokensAfter <= tokensBefore` is the usual
 *   invariant but NOT enforced here (a degenerate compaction that grew the
 *   transcript should be observable, not silenced).
 * - `turnsDropped` / `turnsKept`: count of messages folded into the summary
 *   vs. retained verbatim. Their sum equals the input message count.
 * - `summaryRef?`: optional opaque pointer (path/id) to the archived summary
 *   when the host wired ConversationSummaryArchive. Omitted when no archive.
 * - `resumeStep?`: human-readable "agent compacted: reason X — resuming at
 *   step Y" string the Objective surfaces in `nextActions`. Omitted when the
 *   compactor cannot derive a meaningful next step (one-giant-turn case).
 * - `compactedAt`: epoch-ms timestamp of the compaction event. Captured via
 *   the injected `now` clock so deterministic tests stay reproducible.
 */
export interface RecoveryProvenance {
  readonly reason: RecoveryReason
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly turnsDropped: number
  readonly turnsKept: number
  readonly summaryRef?: string
  readonly resumeStep?: string
  readonly compactedAt: number
}
