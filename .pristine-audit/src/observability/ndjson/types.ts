/**
 * NDJSON live-event introspection sink — shared types (ADR-0468).
 *
 * Faithful to Cursor's `cursor-ndjson-ingest`: a per-workspace monitor accepts
 * a stream of newline-delimited JSON event records for real-time introspection
 * / tracing, and also tails them to a debug log. This slice provides the PURE,
 * plane-clean half of that mechanism:
 *
 *   - `NdjsonEvent`    — the loosely-typed envelope a producer emits.
 *   - `NdjsonSinkPort` — no-throw `emit(event): Result<void, …>` port.
 *   - `NdjsonEncoder`  — deterministic event → single NDJSON line.
 *   - ring-buffer backpressure policy (pure, bounded, drop-oldest|block).
 *
 * The actual HTTP server / file-tail ADAPTER (the thing that opens a socket on
 * the Cursor 7242-7942 port range and writes `.cursor/debug.log`) does NOT live
 * here — `@/observability` may import ONLY `@/shared`, so a net/fs adapter
 * cannot be expressed in this slice. It is wired at the composition root in
 * `@/apps`; see the ADR's integration TODO for the exact port shape it must
 * satisfy (`NdjsonSinkPort`).
 *
 * Plane-clean: imports ONLY `@/shared`. Zero `@/agent` / `@/tool` / `@/llm` /
 * `@/stream` / net / fs. NDJSON introspection is an observation channel — it
 * never reaches up the dependency graph.
 *
 * NO-THROW contract: every port method returns `Result<…>`; programmer-bug
 * inputs (e.g. a value with a `BigInt`, a circular reference) are encoded as
 * `Err`, never thrown past the boundary.
 *
 * DEFAULT-OFF: when no port/path is configured the composition root wires a
 * {@link NullNdjsonSink} whose `emit()` is a no-op returning `ok()`. That path
 * is byte-identical to "no NDJSON wired" — a deployment that does not set
 * `QUANTA_NDJSON_INGEST_PORT` (nor a path) sees zero change.
 */

import type { Result } from "@/shared"

/** The envelope a producer emits. Deliberately loose: NDJSON introspection is
 *  a firehose of heterogeneous agent events (tool start/stop, LLM stream
 *  deltas, permission decisions, subagent forks), so we do NOT close this into
 *  a union — that would couple the sink to every producing slice. The encoder
 *  is responsible for turning any of these into a deterministic line; values
 *  it cannot serialize (BigInt, function, circular) become an `Err`, never a
 *  throw.
 *
 *  Only `type` is required so a consumer can route without parsing the whole
 *  record; `ts` (epoch ms) is conventional but optional — the encoder does NOT
 *  inject a clock (that would make the encoder non-deterministic / impure). */
export interface NdjsonEvent {
  /** Event discriminator the downstream monitor routes on. */
  readonly type: string
  /** Conventional epoch-ms timestamp. Optional — supplied by the producer,
   *  never synthesized by the encoder (purity). */
  readonly ts?: number
  /** Arbitrary additional fields. Encoded with stable key order. */
  readonly [key: string]: unknown
}

/** Backpressure discipline for the bounded ring buffer.
 *
 *  - `"drop-oldest"`  — when full, evict the oldest buffered line to make room
 *    for the newest. Matches a live introspection firehose where the most
 *    recent events matter most and lossy is acceptable (Cursor's debug stream
 *    is best-effort, not an audit log).
 *  - `"reject-newest"` — when full, refuse the new event (`Err` with
 *    `kind:"buffer-full"`) and keep the buffered tail intact. The "block"
 *    option in the spec is realized as synchronous back-signalling: a pure
 *    buffer cannot suspend, so we return a typed full-signal and let the
 *    caller decide (await a drain, sleep, or drop). */
export type BackpressurePolicy = "drop-oldest" | "reject-newest"

/** Required ring-buffer configuration. `capacity` is a REQUIRED field, not a
 *  magic default baked into the buffer — the caller must state how many lines
 *  it is willing to hold so the cap is auditable at the wire site. */
export interface RingBufferConfig {
  /** Max number of NDJSON lines retained. MUST be a positive integer; a
   *  non-positive or non-integer capacity is an `Err` at construction
   *  (`kind:"invalid-config"`), never a silent clamp. */
  readonly capacity: number
  /** What to do on overflow. No default — the caller picks the loss model. */
  readonly policy: BackpressurePolicy
}

/** Closed-union sink errors. Consumers branch on `kind` exhaustively. */
export type NdjsonSinkError =
  /** The event could not be encoded to a stable line (BigInt, function value,
   *  circular reference, …). Carries the human-readable reason. */
  | { readonly kind: "encode-failed"; readonly reason: string }
  /** The bounded buffer is full and the policy is `reject-newest`. The event
   *  was NOT buffered; the caller decides whether to retry or drop. */
  | { readonly kind: "buffer-full"; readonly capacity: number }
  /** A downstream/adapter operational failure (socket closed, write error).
   *  Reserved for the composition-root adapter; pure sinks never produce it. */
  | { readonly kind: "sink-closed"; readonly reason: string }

/** Construction-time configuration errors (separate union so construction and
 *  emission failures never alias). */
export type NdjsonConfigError = {
  readonly kind: "invalid-config"
  readonly reason: string
}

/** The no-throw sink port. A producer calls `emit(event)`; the sink encodes +
 *  buffers/forwards. The OFF path (NullNdjsonSink) returns `ok()` without
 *  doing anything. */
export interface NdjsonSinkPort {
  /** Emit one event. NEVER throws — bad events return `Err({kind:"encode-
   *  failed"})`, a full reject-newest buffer returns `Err({kind:"buffer-
   *  full"})`. */
  emit(event: NdjsonEvent): Result<void, NdjsonSinkError>
}

/** Deterministic event → single NDJSON line (no trailing newline; the writer
 *  adds the framing). Pure + no-throw. */
export interface NdjsonEncoder {
  /** Encode `event` to a stable, single-line JSON string with deterministic
   *  key ordering and every control character (including embedded newlines)
   *  escaped per JSON. Returns `Err({kind:"encode-failed"})` for values JSON
   *  cannot represent. */
  encode(event: NdjsonEvent): Result<string, NdjsonSinkError>
}
