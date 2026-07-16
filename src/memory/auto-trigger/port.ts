/**
 * ADR-0281 — `MemoryAutoTrigger` closed port.
 *
 * Wraps the Phase 1 distill → stage1 store → Phase 2 promotion gate
 * pipeline in a no-throw, default-OFF seam. The composition root
 * builds one implementation against this port and threads it into
 * the session-end + session-start callbacks.
 *
 * Contract details (cross-impl):
 *
 *  - `onSessionEnd` NEVER throws (mirrors ADR-0114 session-end hook's
 *    no-throw contract). Failures collapse to `{kind:"error", error:
 *    TriggerError}`. Abort signals (`signal.aborted`) ARE propagated
 *    unchanged so callers can distinguish cancellation.
 *  - `onSessionStart` is reserved for adapters that need a hook on
 *    session start (e.g. ranker warm-up). The cross-session inject
 *    path (ADR-0282) does NOT route through this port — the host
 *    calls the injector directly.
 *  - `shouldPromote` is pure; same inputs ⇒ same output. Hosts that
 *    plug a non-pure scorer (LLM judge) MUST wrap their adapter so
 *    failures collapse to `false` (never throw out of the predicate).
 *
 * Implementations live in `./default-trigger.ts`. No caller imports
 * the impl directly — the composition root constructs the port
 * instance and hands it back as the port type.
 */

import type { Stage1Entry } from "../stage1-store"

/** Host-injected secret redactor applied before rollout content reaches Phase 1. */
export type DistillRedactor = (content: string) => string

/** Input to {@link MemoryAutoTrigger.onSessionEnd}. */
export interface SessionEndInput {
  /** Stable thread id — Stage 1 PK. Empty ⇒ trigger skips. */
  readonly threadId: string
  /** Session slug ({@link import("../consolidate").Stage1Output.rolloutSlug}
   *  parity — accepts any non-empty string). */
  readonly sessionId: string
  /** Final rollout — passed verbatim to Phase 1's distill port. */
  readonly rolloutMessages: ReadonlyArray<{ role: string; content: unknown }>
  /** Real (non-meta) turn count. Below {@link import("../consolidate").MEMORY_CONSOLIDATE_MIN_TURNS}
   *  ⇒ Phase 1 skips internally; the trigger surface still observes
   *  a `{kind:"skipped"}` outcome (no error). */
  readonly turnCount: number
  /** Optional cancellation — `signal.aborted = true` propagates
   *  `AbortError` unchanged from `runPhase1`. */
  readonly signal?: AbortSignal
}

/** Input to {@link MemoryAutoTrigger.onSessionStart}. Reserved slot —
 *  the default impl is a no-op; future adapters use this for ranker
 *  warm-up or cache prefetch. */
export interface SessionStartInput {
  /** Stable session id — diagnostics only. */
  readonly sessionId: string
}

/** Context passed to {@link MemoryAutoTrigger.shouldPromote}. */
export interface PromoteContext {
  /** All other entries currently in the store (selected-for-phase2
   *  candidates). The default lexical Jaccard scorer composes the
   *  query corpus from these. Frozen by the port; mutation throws. */
  readonly siblings: readonly Stage1Entry[]
}

/** Discriminated outcome from {@link MemoryAutoTrigger.onSessionEnd}.
 *  Never `null`, never throws (abort signals do propagate). */
export type SessionEndOutcome =
  | { readonly kind: "skipped"; readonly reason: "empty_session" | "policy_off" }
  | {
      readonly kind: "stored"
      readonly stage1ThreadId: string
      /** Whether the entry was promoted (markSelectedForPhase2 called). */
      readonly promoted: boolean
    }
  | { readonly kind: "error"; readonly error: import("./types").TriggerError }

/**
 * `MemoryAutoTrigger` — the closed port.
 *
 * @see ADR-0281 (this slice)
 * @see ADR-0282 (cross-session inject — separate port; does not flow
 *   through this one)
 */
export interface MemoryAutoTrigger {
  onSessionEnd(input: SessionEndInput): Promise<SessionEndOutcome>
  onSessionStart(input: SessionStartInput): Promise<void>
  shouldPromote(entry: Stage1Entry, ctx: PromoteContext): boolean
}
