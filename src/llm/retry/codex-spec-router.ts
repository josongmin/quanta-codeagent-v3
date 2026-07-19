/**
 * Codex-spec `RecoveryRouter` implementation (ADR-0214).
 *
 * Verbatim adoption of Codex 0.131.0-alpha.9's 16-kind `CodexErr` → action
 * mapping, ported to our `LLMErrorKind` vocabulary. This is the SINGLE
 * canonical routing table — adding a new `LLMErrorKind` requires extending
 * the switch below (the exhaustiveness `assertNever` will fail compile if
 * a new union member is added without a route).
 *
 * ── Mapping (Codex memory: codex-feature-catalog-2026-05-21 §error-enum) ─────
 *
 *   overloaded               → fallback_provider     (provider over capacity)
 *   rate_limit               → retry_after_backoff   (per-account 429 cap)
 *   server_error             → fallback_provider     (5xx → try next)
 *   network                  → fallback_provider     (transport → try next)
 *   auth                     → hitl_handoff          (user must fix creds)
 *   bad_request              → fatal                 (caller bug, never retry)
 *   not_found                → fatal                 (model/route missing)
 *   not_implemented          → fallback_provider     (stub adapter, fall back)
 *   stream_corrupt           → fatal                 (SDK shape drift)
 *   aborted                  → fatal                 (signal fired, propagate)
 *   unknown                  → fatal                 (no structured signal)
 *   context_window_exceeded  → reactive_compaction   (compact then retry)
 *   cyber_policy             → hitl_handoff          (user must resolve)
 *   too_many_failed_attempts → fatal                 (budget burned)
 *   thread_rollback_failed   → reactive_compaction   (rebuild shorter prefix)
 *   sandbox_error            → hitl_handoff          (user review host)
 *   sandbox_blocked          → hitl_handoff          (user-gated escalation;
 *                                                     NEVER auto-grants)
 *   invalid_image            → fatal                 (sanitize-retry happens
 *                                                     at the adapter wrap layer
 *                                                     — ADR-0328. By the time
 *                                                     the kind reaches THIS
 *                                                     router the wrap has
 *                                                     already exhausted its
 *                                                     retry budget; further
 *                                                     retry / fallback would
 *                                                     re-poison the history.
 *                                                     Same policy as
 *                                                     `bad_request`.)
 *
 * ── Why `activeTurnNotSteerable` (Codex) does NOT map to retry_same_turn ─────
 * The user's spec asks for `activeTurnNotSteerable → retry_same_turn` NOT to
 * be the case. We collapse it into the `aborted` kind because our turn-lifecycle
 * never re-issues an in-flight identical stream — the next user input creates a
 * new turn. So the action is `fatal` (propagate to the loop, which then accepts
 * the next user-visible input). This is the negative invariant the hellgate
 * test pins.
 *
 * NOTE: `retry_same_turn` is intentionally UNUSED by this router today — the
 * action exists in the closed union so a downstream router (e.g. a future
 * mid-turn-steerable provider) can use it without widening the type. The
 * `routerActionsExercised` export documents which actions this concrete table
 * emits so a consumer audit can detect future drift.
 */

import { assertNever, type LLMErrorKind } from "@/shared"
import type { RecoveryAction } from "./port"

/** Pure routing function — exposed for direct testing without instantiating
 *  the class. Identical to `CodexSpecRouter.prototype.route`. */
export const codexSpecRoute = (kind: LLMErrorKind): RecoveryAction => {
  switch (kind) {
    case "overloaded":
      return "fallback_provider"
    case "rate_limit":
      return "retry_after_backoff"
    case "server_error":
      return "fallback_provider"
    case "network":
      return "fallback_provider"
    case "auth":
      return "hitl_handoff"
    case "bad_request":
      return "fatal"
    case "not_found":
      return "fatal"
    case "not_implemented":
      return "fallback_provider"
    case "stream_corrupt":
      return "fatal"
    case "aborted":
      return "fatal"
    case "unknown":
      return "fatal"
    case "context_window_exceeded":
      return "reactive_compaction"
    case "cyber_policy":
      return "hitl_handoff"
    case "too_many_failed_attempts":
      return "fatal"
    case "thread_rollback_failed":
      return "reactive_compaction"
    case "sandbox_error":
      return "hitl_handoff"
    case "sandbox_blocked":
      // RFC jun-6: the OS sandbox RAN and BLOCKED a syscall. Unlike
      // `sandbox_error` (host couldn't enforce — user inspects the host), a
      // block is a recoverable, user-gated event: route to the escalation
      // prompt surface (hand-off to the human who decides whether to re-run
      // the byte-same argv unsandboxed). NEVER auto-grants.
      return "hitl_handoff"
    case "invalid_image":
      // ADR-0328: by the time the kind reaches this canonical router, the
      // `withImageSanitizationRetry` wrap (when wired) has already attempted
      // sanitize-and-retry and failed. Same policy as `bad_request` — the
      // history is poisoned in a way the agent could not mechanically fix.
      return "fatal"
    default:
      return assertNever(kind)
  }
}

/**
 * Actions actually emitted by `codexSpecRoute`. Exported for the hellgate so
 * a future contributor cannot silently drop an action mapping (a kind switching
 * to `retry_same_turn` without an audit note would change this set). Tests
 * assert membership; we do NOT assert equality (a future router may emit more).
 */
export const codexSpecRouterEmittedActions: ReadonlySet<RecoveryAction> = new Set([
  "fallback_provider",
  "retry_after_backoff",
  "hitl_handoff",
  "fatal",
  "reactive_compaction",
])
