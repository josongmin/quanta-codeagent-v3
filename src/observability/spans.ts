/**
 * Lightweight span emission (Codex 10-step OTel span-tree absorption — core 4
 * stages: `session_loop` / `turn` / `run_sampling_request` / `handle_tool_call`).
 *
 * Why this module exists
 * ----------------------
 * Codex's hot-path is wrapped in a 10–11 deep OTel span tree per turn — every
 * dispatched submission, the turn itself, the sampling request to the
 * provider, and every tool call sit inside their own span. That nested shape
 * is what makes a 6,386-session corpus searchable ("show me turns where
 * `handle_tool_call{name=bash}` exceeded 5s under `session_loop{thread_id=…}`").
 *
 * v3 has not historically emitted OTel spans — only flat AgentEvents (RFC-0002)
 * and in-process counters (`AgentRecorder`). Adopting the OTel SDK upfront
 * would force a dependency + a runtime exporter on every loop start, which
 * violates RFC §1.2 (default-OFF byte-identical contract).
 *
 * Approach
 * --------
 * This file ships a minimal, SDK-FREE seam:
 *
 *   1. A {@link SpanSink} interface — three methods (`onStart` / `onEnd` /
 *      `onError`). Anything that wants to receive spans implements this.
 *      The actual mapping to OTel / Honeycomb / a JSONL file lives in the
 *      consumer, not here.
 *   2. A module-level mutable sink that defaults to `null`. When `null`
 *      every span call returns a single shared no-op {@link Span} object —
 *      no allocations, no try/finally cost beyond a function call.
 *   3. {@link startSpan} / {@link endSpan} helpers wrap the open/close pair
 *      with the canonical `try/finally` pattern. Errors caught by `finally`
 *      should flow through {@link endSpan}'s `status` argument.
 *
 * Default-OFF guarantee
 * ---------------------
 *   - With no sink registered (the only shipped default), every helper is a
 *     constant-time function returning the shared {@link NOOP_SPAN}. The
 *     loop's hot-path becomes a few stack-allocated calls; observable
 *     behavior is byte-identical to the pre-span loop.
 *   - With a sink registered, exceptions thrown FROM the sink are caught and
 *     swallowed here — observability bugs MUST NOT abort the agent loop.
 *
 * Attribute discipline
 * --------------------
 *   - Span attributes go through the canonical {@link Attrs} type from
 *     `attrs.ts`. New keys live ONLY in `vocabulary.ts`, NEVER as raw
 *     string literals in this file. The vocabulary-orphan scan in
 *     `tests/unit/observability/vocabulary-migration.test.ts` enforces
 *     this at CI time.
 *
 * Related: ADR-0032 (OTel vocabulary), Codex build-2867 round-4 §1
 * (10-step span tree), RFC §1.2 (default-OFF byte-identical).
 */

import type { Attrs } from "./attrs"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Canonical span names for the Codex 10-step tree core 4 stages.
 *
 * Frozen `as const` so a typo in a loop site fails `tsc` (the helper signature
 * narrows `name` to this union). Mirrors Codex's `otel.name` literals
 * verbatim — these are the names a downstream OTel exporter or trace UI will
 * see, so they MUST stay byte-stable. */
export const SPAN_NAMES = {
  /** Root of a session — one per `runAgent` invocation, covers the whole
   *  loop. Carries `quanta.conversation.id` (sessionId) + `quanta.thread.id`. */
  sessionLoop: "session_loop",
  /** One per logical turn (a turn that retries SAME-TURN does NOT open a new
   *  span — same `quanta.turn.id`). Carries `quanta.turn.id` + `quanta.turn.kind`. */
  turn: "session_task.turn",
  /** One per provider stream call inside a turn (a same-turn retry opens a
   *  fresh `run_sampling_request` since each is a new HTTP/SSE call). */
  runSamplingRequest: "run_sampling_request",
  /** One per dispatched tool call. Carries `quanta.tool.name` +
   *  `quanta.tool.call_id` + `quanta.tool.call.status`. */
  handleToolCall: "handle_tool_call",
} as const

export type SpanName = (typeof SPAN_NAMES)[keyof typeof SPAN_NAMES]

/** Outcome of a closed span — three terminal states (mirrors OTel SpanStatusCode
 *  collapsed for our usage). `ok` is success; `error` is a thrown / rejected
 *  exception; `aborted` is a cancellation (AbortSignal trip) — distinguished
 *  because a cancel is not a defect. */
export type SpanStatus = "ok" | "error" | "aborted"

/** Live span handle returned by {@link startSpan}. Holds the sink-issued token
 *  and the wall-clock start so {@link endSpan} can compute `durationMs`
 *  without forcing the caller to pass it in. */
export interface Span {
  /** Sink-assigned identifier OR `null` when the active sink is absent
   *  (no-op span). Loop callers should NEVER inspect this; it is plumbed
   *  through {@link endSpan}. */
  readonly token: unknown
  /** Span name (one of {@link SPAN_NAMES}). Plumbed back to the sink on
   *  end so a sink that batches doesn't need to track it itself. */
  readonly name: SpanName
  /** `performance.now()` at start. Used to compute `durationMs` on close. */
  readonly startedAt: number
}

/** Implement this to receive spans. Constructed lazily by the host (CLI/web
 *  surface) and wired in via {@link setSpanSink}. Absent ⇒ no-op (default). */
export interface SpanSink {
  /** Open a span. Return value is opaque to callers — passed back verbatim to
   *  {@link onEnd} so the sink can correlate. */
  onStart: (name: SpanName, attrs: Attrs) => unknown
  /** Close a span with a terminal {@link SpanStatus}. `durationMs` is the
   *  measured elapsed time computed by {@link endSpan} (monotonic clock).
   *  `attrs` is the FINAL attribute bag — sinks should merge it with the
   *  start attrs themselves; this module makes no such assumption. */
  onEnd: (
    token: unknown,
    name: SpanName,
    status: SpanStatus,
    durationMs: number,
    attrs: Attrs,
  ) => void
}

// ---------------------------------------------------------------------------
// No-op default
// ---------------------------------------------------------------------------

/** Shared frozen sentinel for the no-sink path. A loop site does
 *  `const span = startSpan(...); try { ... } finally { endSpan(span, ...) }` —
 *  with no sink BOTH calls return / accept this constant, no allocation, no
 *  branch. The `token` is `null` so a future "leak this token to attribute
 *  builders" never confuses a real span with the sentinel. */
const NOOP_SPAN: Span = Object.freeze({
  token: null,
  name: SPAN_NAMES.sessionLoop,
  startedAt: 0,
})

// ---------------------------------------------------------------------------
// Sink registry (module-level mutable, BUT only setter is exported)
// ---------------------------------------------------------------------------

let activeSink: SpanSink | null = null

/** Register a {@link SpanSink}. Pass `null` to clear. Tests + hosts use this;
 *  the loop only ever reads via {@link startSpan} / {@link endSpan}.
 *
 *  This intentionally is NOT a stack — only one sink active at a time. A
 *  multi-fanout host wraps two real sinks into one composite at registration. */
export const setSpanSink = (sink: SpanSink | null): void => {
  activeSink = sink
}

/** Read-only accessor for the active sink. Exposed for diagnostics + tests;
 *  feature code MUST NOT branch on this directly — call {@link startSpan}
 *  and let it return the no-op sentinel. */
export const getSpanSink = (): SpanSink | null => activeSink

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/** Begin a span. With no active sink returns the shared {@link NOOP_SPAN}
 *  (zero allocation). With a sink, builds a fresh {@link Span} carrying the
 *  sink-issued token plus the monotonic start time.
 *
 *  A throw from the sink's `onStart` is caught + swallowed (observability
 *  bugs MUST NOT crash the loop). On such a failure this returns the no-op
 *  sentinel so the matching {@link endSpan} is also a no-op. */
export const startSpan = (name: SpanName, attrs: Attrs): Span => {
  const sink = activeSink
  if (sink === null) return NOOP_SPAN
  try {
    const token = sink.onStart(name, attrs)
    return { token, name, startedAt: performance.now() }
  } catch {
    // Swallow — see comment above. The matching `endSpan` is also a no-op
    // because the sentinel's `token === null` short-circuits below.
    return NOOP_SPAN
  }
}

/** Close a span. With the sentinel (no sink, OR `onStart` threw) this is a
 *  near-free no-op. With a real span, computes elapsed ms from the monotonic
 *  start, then dispatches to the sink. Errors thrown by the sink are caught
 *  + swallowed (same rationale as {@link startSpan}). */
export const endSpan = (span: Span, status: SpanStatus, attrs: Attrs): void => {
  // Sentinel detection: the frozen NOOP_SPAN has `token: null` AND
  // `startedAt: 0` — both real spans set `startedAt = performance.now()`
  // which is monotonically > 0 on any real runtime. Checking `token`
  // alone would be enough (a real sink may legitimately issue a non-null
  // token; an `onStart` throw inside `startSpan` falls back to the
  // sentinel) but the cheap dual-check is defensive against a future sink
  // implementation that wants to return `null` as a valid token.
  const sink = activeSink
  if (sink === null || span === NOOP_SPAN) return
  const durationMs = Math.max(0, Math.round(performance.now() - span.startedAt))
  try {
    sink.onEnd(span.token, span.name, status, durationMs, attrs)
  } catch {
    // Swallow.
  }
}

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/** Test-only: forcibly clear the registered sink. Mirrors the
 *  `__resetRuntimeConfig` pattern from `shared/runtime-config.ts` so tests
 *  don't accidentally leak a sink across cases. Production code MUST NOT
 *  call this — use {@link setSpanSink}(null) instead, which is identical
 *  but reads as an intentional clear rather than a reset. */
export const __resetSpanSink = (): void => {
  activeSink = null
}
