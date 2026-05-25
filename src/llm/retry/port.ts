/**
 * RecoveryRouter port (ADR-0214). Pure typed mapping from an LLMErrorKind to
 * a single closed action the caller should take next.
 *
 * ── Design notes ─────────────────────────────────────────────────────────────
 * - Closed discriminated union of actions — six and only six. Adding a new
 *   action is an intentional contract change (must update every router
 *   implementation + every consumer's switch).
 * - The port itself carries NO state — pure `route(kind) → action`. Implementors
 *   that need per-attempt counters layer them OUTSIDE the port (e.g. in the
 *   caller's recovery state machine). This keeps the port testable as a pure
 *   table.
 * - default-OFF byte-identical invariant: the existing `RetryingLLM` +
 *   `FallbackLLM` decorators continue to work as-is when no `RecoveryRouter`
 *   is injected. The router is wired ONLY where explicitly passed; absent it,
 *   the legacy retry/fallback path runs unchanged.
 */

import type { LLMErrorKind } from "@/shared"

/**
 * One of six closed actions the caller should take in response to an LLM error.
 * The router's job is to collapse the 16-kind `LLMErrorKind` space onto this
 * six-action space so callers can branch on a small typed envelope.
 *
 *   - `retry_same_turn`     Retry without backoff (same provider, same prompt).
 *                           Used for transient steerability conflicts where
 *                           the next call is likely fine immediately.
 *   - `retry_after_backoff` Sleep then retry the same provider. Used for
 *                           rate_limit (429) and 5xx transients.
 *   - `hitl_handoff`        Halt the autonomous loop and surface to the user.
 *                           The agent cannot resolve this — cyber_policy,
 *                           sandbox_error, auth all need user intervention.
 *   - `fatal`               Terminal error — propagate up. Never retry, never
 *                           swap. Used for bad_request, not_found, stream_corrupt,
 *                           aborted, too_many_failed_attempts.
 *   - `fallback_provider`   Switch to the next provider in the chain (same
 *                           turn, possibly tombstoning a partial). Used for
 *                           overloaded (529), server_error, network, not_implemented.
 *   - `reactive_compaction` Run reactive compaction (rebuild a shorter prefix),
 *                           then retry the same turn. Used for
 *                           context_window_exceeded, thread_rollback_failed.
 */
export type RecoveryAction =
  | "retry_same_turn"
  | "retry_after_backoff"
  | "hitl_handoff"
  | "fatal"
  | "fallback_provider"
  | "reactive_compaction"

/**
 * Pure port: classify-already-done → action. The caller supplies the kind
 * (from `classify(e)` in `src/shared/error-classifier.ts` or directly from
 * `LLMError.kind`); the router returns the action.
 */
export interface RecoveryRouter {
  route(kind: LLMErrorKind): RecoveryAction
}
