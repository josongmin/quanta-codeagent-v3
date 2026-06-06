/**
 * `apps/agent/mode-presets/stream-json-sink.ts` — P26 headless STDOUT machine
 * contract (`--output-format json|stream-json`).
 *
 * WHY HERE: concrete output adapters are constructed at the composition root
 * (ARCHITECTURE.md §intro). `@/stream` is slice-isolated to `@/shared` (biome
 * restricts the `src/stream` tree), so it CANNOT reach the session-protocol
 * codec — but `src/apps` may. This file is the seam that bridges the live
 * agent observation plane (`AgentEvent` via `StreamPort`) onto the ALREADY-
 * COMPLETE, versioned session wire (`encodeSessionEvent` →
 * `{ version, kind:"event", payload }`). We REUSE that codec verbatim; we do
 * NOT invent a new encoding.
 *
 * STDOUT CONTRACT (the P26 crux):
 *   • `stream-json` — every emitted line is exactly one `encodeSessionEvent(...)`
 *     envelope: independently `jq`-parseable valid JSON, terminated by `\n`,
 *     and round-trippable through `decodeSessionEvent`. NO human-formatted log
 *     line is ever written to this stdout sink — diagnostics go to stderr via
 *     the `@/shared` logger (which is stderr-bound), so the stream is clean.
 *   • `json` — the same `SessionEvent`s are BUFFERED and flushed as ONE
 *     `[ … ]` value at the end (a single well-formed top-level JSON value).
 *   • VERSIONING — each envelope carries `version: SESSION_PROTOCOL_VERSION`
 *     ("session.v1"); a future schema change bumps that constant so an SDK / CI
 *     consumer can branch safely. The marker is the codec's, not a bespoke one.
 *
 * DEFAULT-OFF / BYTE-IDENTICAL: this sink is constructed ONLY when the headless
 * preset resolves `output` to `json` / `stream-json`. Absent / `text` ⇒ the
 * preset uses the legacy `StdoutStream` and this file is never instantiated.
 *
 * PARTIAL GATING: streaming-delta events (`turn.output.delta`, mapped from
 * `assistant_text`) are emitted ONLY when `includePartial` is true. Milestone
 * events (turn/tool/error lifecycle) always emit. This keeps the default
 * contract small + stable while letting an opt-in consumer see token deltas.
 *
 * NO-THROW AT THE BOUNDARY: `emit` is called from inside the agent loop; a
 * throwing sink would crash the run. The map is total over the surfaced
 * `AgentEvent`s and the write is guarded so an `EPIPE` (consumer closed the
 * pipe) degrades to a logged drop, never an exception into the loop.
 */

import {
  encodeSessionEvent,
  normalizeCapabilityManifest,
  SESSION_PROTOCOL_VERSION,
  type SessionEvent,
} from "@/protocol/session"
import { errMessage, logger } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"

/** Resolved headless output mode handled by this sink. `text` is NOT one of
 *  these — the preset never constructs a stream-json sink for `text`. */
export type StructuredOutputFormat = "json" | "stream-json"

export interface StreamJsonSinkOptions {
  readonly format: StructuredOutputFormat
  /** When true, also emit `turn.output.delta` (partial assistant text). */
  readonly includePartial?: boolean
  /** STDOUT writer. Default = `process.stdout.write`. Injected in tests to
   *  capture lines; the writer owns nothing but appending bytes. */
  readonly write?: (chunk: string) => void
  /** Clock for `emittedAt`. Default = `Date`-backed `() => new Date()`.
   *  Injected in tests for determinism. */
  readonly now?: () => Date
  /** Stable id minter for `eventId`. Default = `crypto.randomUUID`. Injected
   *  in tests for determinism. */
  readonly newId?: () => string
}

/** The version of the stream-json line contract, surfaced as one greppable
 *  constant. Today it tracks the session-protocol envelope version 1:1 (each
 *  line IS a `session.v1` envelope); a future change that diverges the stream
 *  contract from the envelope bumps THIS constant. */
export const STREAM_JSON_CONTRACT_VERSION = SESSION_PROTOCOL_VERSION

/**
 * A {@link StreamPort} that maps the live {@link AgentEvent} observation plane
 * onto versioned {@link SessionEvent} NDJSON / JSON-array stdout. See the
 * file-level doc for the contract.
 */
export class StreamJsonSink implements StreamPort {
  readonly #format: StructuredOutputFormat
  readonly #includePartial: boolean
  readonly #write: (chunk: string) => void
  readonly #now: () => Date
  readonly #newId: () => string
  /** Monotonic per-run sequence — mirrors the kernel session's `seq`. */
  #seq = 0
  /** `json` mode buffer; flushed once on {@link finalize}. */
  readonly #buffered: string[] = []
  /** Idempotency guard so a double `finalize()` (preset finally + explicit)
   *  cannot emit the array twice. */
  #finalized = false

  constructor(opts: StreamJsonSinkOptions) {
    this.#format = opts.format
    this.#includePartial = opts.includePartial ?? false
    this.#write = opts.write ?? ((chunk) => process.stdout.write(chunk))
    this.#now = opts.now ?? (() => new Date())
    this.#newId = opts.newId ?? (() => crypto.randomUUID())
  }

  emit(event: AgentEvent): void {
    const session = this.#toSessionEvent(event)
    if (session === undefined) return // unmapped / partial-gated ⇒ drop
    // Encode INSIDE the no-throw boundary: a future mapping that introduces a
    // non-JSON-safe field (BigInt / circular ref) would otherwise throw out of
    // `emit` straight into the agent loop. Degrade to a logged drop instead.
    let line: string
    try {
      line = encodeSessionEvent(session)
    } catch (e) {
      logger.warn(`[stream-json] encode failed (event dropped): ${errMessage(e)}`)
      return
    }
    if (this.#format === "stream-json") {
      // One NDJSON line per event; the encoder emits NO trailing newline, so
      // THIS sink owns the `\n` framing.
      this.#guardedWrite(`${line}\n`)
      return
    }
    // json — buffer the raw (un-newlined) encoded value for the final array.
    this.#buffered.push(line)
  }

  /**
   * Emit the trailing aggregate. In `stream-json` mode this is a no-op (every
   * line was already written). In `json` mode it writes the single JSON array
   * of all buffered events as ONE top-level value. Idempotent.
   */
  finalize(): void {
    if (this.#finalized) return
    this.#finalized = true
    if (this.#format !== "json") return
    // Compose the array WITHOUT re-parsing: each buffered entry is already a
    // valid JSON value, so `[ a, b, c ]` is a valid JSON array. A trailing
    // newline terminates the single value for line-based consumers.
    this.#guardedWrite(`[${this.#buffered.join(",")}]\n`)
  }

  /** Best-effort write — an `EPIPE` (consumer closed) degrades to a logged drop
   *  (stderr), never an exception into the agent loop. */
  #guardedWrite(chunk: string): void {
    try {
      this.#write(chunk)
    } catch (e) {
      logger.warn(`[stream-json] stdout write failed (line dropped): ${errMessage(e)}`)
    }
  }

  /** Common envelope metadata for a mapped event. `seq` is pre-incremented so
   *  the first event is `seq:1` (mirrors the kernel session, where `seq` rises
   *  monotonically and is never 0 on the wire). `revision` is held at 0 — the
   *  headless one-shot has no command-driven revision churn. */
  #meta(): { eventId: string; seq: number; revision: number; emittedAt: string } {
    this.#seq += 1
    return {
      eventId: this.#newId(),
      seq: this.#seq,
      revision: 0,
      emittedAt: this.#now().toISOString(),
    }
  }

  /**
   * Map ONE {@link AgentEvent} to a {@link SessionEvent}, or `undefined` when
   * the event has no session-wire counterpart (or is a partial gated off).
   *
   * The mapping is deliberately CONSERVATIVE: only events with a stable
   * session-protocol counterpart are surfaced. Unmapped variants (in-progress
   * heartbeats, knob telemetry, plan deltas, usage accounting, …) are dropped —
   * they are not part of the headless machine contract. A future round can
   * widen this map; the `version` marker lets consumers detect the change.
   */
  #toSessionEvent(event: AgentEvent): SessionEvent | undefined {
    switch (event.type) {
      case "session_start":
        return {
          ...this.#meta(),
          type: "session.created",
          // The headless preset negotiates no capabilities; emit the normalized
          // default manifest so the line round-trips through the codec with the
          // full, valid manifest shape.
          capabilityManifest: normalizeCapabilityManifest(undefined),
        }
      case "turn_start":
        return { ...this.#meta(), type: "turn.started", prompt: "" }
      case "llm_request":
        return {
          ...this.#meta(),
          type: "turn.llm.request",
          model: event.model,
          ...(event.provider !== undefined ? { provider: event.provider } : {}),
        }
      case "assistant_text":
        // Partial / streaming-delta — gated behind `--include-partial`.
        if (!this.#includePartial) return undefined
        return { ...this.#meta(), type: "turn.output.delta", delta: event.delta }
      case "tool_call":
        return {
          ...this.#meta(),
          type: "tool.invoked",
          toolCallId: event.id,
          toolName: event.name,
        }
      case "tool_result":
        return {
          ...this.#meta(),
          type: "tool.completed",
          toolCallId: event.id,
          toolName: event.name,
          outcome: event.ok ? "ok" : "error",
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        }
      case "error":
        return { ...this.#meta(), type: "turn.failed", message: event.message }
      case "done":
        return { ...this.#meta(), type: "turn.completed", outcomeReason: event.reason }
      default:
        // Every other AgentEvent variant has no headless machine-contract
        // counterpart (yet). Drop silently — NOT an exhaustiveness error,
        // because the AgentEvent union is intentionally broader than the
        // session wire. Adding a mapping is additive + version-detectable.
        return undefined
    }
  }
}
