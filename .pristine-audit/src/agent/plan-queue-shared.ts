/**
 * Shared types + leaf helpers for the plan-queue (ADR-0128 + ADR-0221).
 *
 * Extracted from `plan-queue.ts` so the factory body and its internal
 * helpers (`plan-queue/internals.ts`) can both import these WITHOUT a
 * parent↔child import cycle. `plan-queue.ts` re-exports the public surface
 * verbatim so existing `@/agent/plan-queue` consumers are unaffected.
 *
 * Plane-clean: imports only `node:crypto` + `@/shared` Result type
 * (type-only).
 */

import { createHash } from "node:crypto"

/** Where the follow-up originated. Closed enum so callers cannot smuggle a
 *  free-form source and so the replayer can branch deterministically. */
export type FollowUpSource =
  | "user_keystroke"
  | "voice_transcript"
  | "api_call"
  | "scheduled_reminder"
  /** ADR-0240 — saved-file inline-trigger dispatch (Aider `AI!`-style).
   *  A playbook frontmatter's `trigger: { comment-marker, watch-glob }`
   *  detected a marker in a saved file; the watcher enqueued a `/play
   *  <playbook>` follow-up so the next-turn boundary picks it up. */
  | "inline_trigger"

/** Why the current turn was paused when the follow-up arrived. Captured so
 *  the replayer can branch on staleness (e.g. drop follow-ups whose
 *  `pausedReason` was `rate_limit` if the user already retried). */
export type PausedReason =
  | "tool_in_flight"
  | "subagent_running"
  | "review_blocked"
  | "compaction"
  | "rate_limit"
  | "other"

/** 12-field follow-up context. Mirrors `codex-follow-up-queue-pattern`
 *  memory but typed and trimmed to fields the v3 consumer surfaces ACTUALLY
 *  read (Codex's are JSON-attached blobs; ours are typed scalars). */
export interface FollowUp {
  /** Stable id within ONE thread: `fu-${thread}-${n}`. Counter is per-store
   *  (not per-thread) so the suffix is monotone across threads too. */
  readonly id: string
  /** Owning thread / session id. */
  readonly threadId: string
  /** Free text the user submitted (or transcript / API call body). */
  readonly text: string
  /** Source surface — keystroke vs voice vs API vs scheduled. */
  readonly source: FollowUpSource
  /** Epoch ms when enqueued (from the injected clock). */
  readonly enqueuedAtMs: number
  /** Reason the current turn was paused when this arrived. */
  readonly pausedReason: PausedReason
  /** The turn index that was in-flight when this was enqueued. */
  readonly arrivedDuringTurn: number
  /** User-marked urgent (UI hint). Replayer may re-order; LRU eviction
   *  prefers to drop non-urgent first. MUTABLE inside the store (OR-in
   *  during dedup); external readers see it via the `FollowUp` shape but
   *  must not mutate. */
  urgent: boolean
  /** When the replayer surfaced this back into the active prompt, the
   *  resulting turn index. `null` until `drain()` claims it. */
  drainedIntoTurn: number | null
  /** Free metadata payload — caller-controlled (e.g. {viewportFile: "..."}). */
  readonly metadata: Readonly<Record<string, string>>
  /** Hash of the text — for dedup on identical re-types. */
  readonly textHash: string
  /** Optional user-facing label — UI-visible chip in the queue inspector.
   *  Omitted (not `undefined`) when the caller didn't supply one. */
  readonly label?: string
}

/** Result of `PlanQueueStore.enqueue`. ADR-0167 — expanded from bare `string`
 *  so observability wrap can emit a collapse counter (caller could not see
 *  dedup collapses when only the id was returned). */
export interface EnqueueResult {
  /** Assigned id (existing entry's id when collapsed). */
  readonly id: string
  /** True when this enqueue collapsed into an existing live entry
   *  (same threadId + same textHash, both with drainedIntoTurn===null).
   *  When true, `id` is the existing entry's id. */
  readonly collapsed: boolean
}

/** Error variants for the four per-msg mutators (ADR-0221).
 *
 *   - `not-found`     — `entryId` does not match any LIVE entry across all
 *                       threads (drained entries are tombstones — they NEVER
 *                       resurrect via retry/edit/delete; sendNow ignores
 *                       them too).
 *   - `already-active`— `retry` only. The entry is still LIVE in the queue,
 *                       so a "retry" would dedup to itself rather than
 *                       enqueue a second copy. Caller should `delete` then
 *                       `enqueue` if intent is "force a fresh entry".
 *   - `invalid-text`  — `edit` only. The new text is empty / whitespace-only
 *                       (after `.trim()`), or exceeds {@link MAX_FOLLOWUP_TEXT_BYTES}.
 *                       Symmetric with future enqueue-side validation.
 *   - `send-not-possible` — `sendNow` only. A TERMINAL delivery failure: no
 *                       {@link SendNowSink} was wired at construction time, OR
 *                       the sink threw, OR the sink returned `{ok:false}`
 *                       WITHOUT `retryable:true`. The entry is REMOVED (the
 *                       caller can re-enqueue if intent demands). `sendNow`
 *                       NEVER throws — it converts sink throws to this.
 *   - `send-not-ready`— `sendNow` only. A TRANSIENT delivery failure: the sink
 *                       is wired but its downstream target is not installed YET
 *                       (the first-turn composition-root timing WINDOW — the
 *                       REPL `sendNowSink` closure exists at store-construction
 *                       but the loop-owned `ExternalPromptQueue` target is
 *                       late-bound). FAIL-CLOSED: the entry is KEPT IN THE QUEUE
 *                       (NOT removed) so a `/queue send-now` fired inside the
 *                       window is never a silent drop — the caller gets an
 *                       explicit "not ready, try again" and the entry survives
 *                       for the retry. The sink signals this by returning
 *                       `{ok:false, reason, retryable:true}`. */
export type QueueMutateError =
  | "not-found"
  | "already-active"
  | "invalid-text"
  | "send-not-possible"
  | "send-not-ready"

/** Max byte length for a single follow-up text (post-`edit`). 64 KiB is the
 *  same ceiling Codex applies to keystroke buffers and roughly 16k tokens
 *  worth of text — far above any reasonable mid-turn redirect. */
export const MAX_FOLLOWUP_TEXT_BYTES = 64 * 1024

/** Injection port for `sendNow`. The caller (apps/agent bootstrap) wires
 *  this to whatever surface "deliver a user message into the next LLM turn
 *  WITHOUT interrupting the current one" maps to in their assembly:
 *
 *    - REPL surface ⇒ append to the working-message queue read at the next
 *      turn boundary. The in-flight turn keeps streaming.
 *    - Headless / API surface ⇒ append to the next-prompt buffer.
 *
 *  Contract:
 *    - MUST NOT abort/interrupt the active turn (steering bypass).
 *    - MUST return `{ok:true}` on a successful enqueue into the next-turn
 *      sink, `{ok:false, reason}` if the sink itself cannot accept.
 *    - MUST NOT throw — `sendNow` catches throws and converts them, but
 *      well-behaved sinks return `{ok:false}` instead.
 *    - TIMING WINDOW: when the sink is wired but its downstream target is not
 *      installed YET (the composition-root late-bind window), the sink MUST
 *      return `{ok:false, reason, retryable:true}` so the store maps it to the
 *      TRANSIENT `send-not-ready` error and KEEPS the entry (fail-closed — a
 *      send-now fired in the window is never a silent drop). A permanent
 *      rejection (downstream full / closed) omits `retryable` (or sets it
 *      false) ⇒ TERMINAL `send-not-possible` ⇒ the entry is removed. */
export interface SendNowSink {
  /** Submit `text` for inclusion in the NEXT LLM turn. Synchronous —
   *  the store has already done all bookkeeping by the time this is
   *  called, so the sink just needs to record the message.
   *
   *  `retryable:true` on a rejection signals the TRANSIENT timing window
   *  (target not installed yet) — the store maps it to `send-not-ready`
   *  and PRESERVES the entry. Omitted / false ⇒ TERMINAL rejection. */
  inject(input: SendNowInjection): { ok: true } | { ok: false; reason: string; retryable?: boolean }
}

/** Payload handed to {@link SendNowSink.inject}. Carries enough envelope
 *  context (threadId, source, label, metadata) that a multi-thread sink can
 *  route to the right session. */
export interface SendNowInjection {
  readonly threadId: string
  readonly text: string
  readonly source: FollowUpSource
  readonly enqueuedAtMs: number
  readonly metadata: Readonly<Record<string, string>>
  readonly label?: string
}

export interface PlanQueueStoreOpts {
  /** Cap per thread — when exceeded, OLDEST non-urgent dropped first.
   *  Default 32 (Codex ships somewhere around 16-64; 32 is the safe mid).
   *  Values < 1 are clamped to 1. */
  readonly maxPerThread?: number
  /** Injected clock; tests pin it. Default `Date.now`. */
  readonly now?: () => number
  /** Injected hasher for textHash. Default = `sha256(text).slice(0,16)`. */
  readonly hash?: (text: string) => string
  /** Optional {@link SendNowSink} for `sendNow()`. Absent ⇒ every
   *  `sendNow` returns `{ok:false, error:"send-not-possible"}`
   *  (default-OFF byte-identical to a store that pre-dates ADR-0221). */
  readonly sendNowSink?: SendNowSink
}

export const DEFAULT_MAX_PER_THREAD = 32

/** Default SHA-256 16-hex-char prefix hasher. Matches the workspaceHash
 *  posture from ADR-0108 (16 hex chars = 64 bits = collision-safe at
 *  realistic queue sizes). */
export const defaultHash = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16)

/** Internal mutable entry. We never widen `urgent` outside the store
 *  (consumer reads via `FollowUp` shape), and the `drainedIntoTurn`
 *  transition is the only other mutation. */
export type Entry = {
  readonly id: string
  readonly threadId: string
  readonly text: string
  readonly source: FollowUpSource
  readonly enqueuedAtMs: number
  readonly pausedReason: PausedReason
  readonly arrivedDuringTurn: number
  urgent: boolean
  drainedIntoTurn: number | null
  readonly metadata: Readonly<Record<string, string>>
  readonly textHash: string
  readonly label?: string
}

/** Build an external `FollowUp` snapshot from a mutable internal entry.
 *  Omits `label` when not present (exactOptionalPropertyTypes — never
 *  `label: undefined`). */
export const toSnapshot = (e: Entry): FollowUp => {
  const base: Omit<FollowUp, "label"> = {
    id: e.id,
    threadId: e.threadId,
    text: e.text,
    source: e.source,
    enqueuedAtMs: e.enqueuedAtMs,
    pausedReason: e.pausedReason,
    arrivedDuringTurn: e.arrivedDuringTurn,
    urgent: e.urgent,
    drainedIntoTurn: e.drainedIntoTurn,
    metadata: e.metadata,
    textHash: e.textHash,
  }
  if (e.label !== undefined) {
    return { ...base, label: e.label }
  }
  return base
}
