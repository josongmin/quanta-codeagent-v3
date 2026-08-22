/**
 * ADR-0192 — LLM session record/replay typed port.
 *
 * The `LLMPort` is the DOMAIN; record + replay are sibling ADAPTERS that wrap
 * a real `LLMPort` (recording) or replace it entirely (replay-from-store).
 * Default-OFF — bootstraps never auto-wire either; surfaces opt in.
 *
 * Inspired by VCR (Ruby), polly-js (JS), nock recorder — all HTTP-level. Ours
 * is `LLMPort`-level (richer: stream events, tool calls, system prompts,
 * provider/model metadata) and JSONL on disk (git-friendly + grep-friendly).
 */

import type { StreamEvent, StreamInput } from "../types"

/**
 * One serialized LLM call. One line per call in the JSONL store.
 *
 * `id` is the stable hash of the normalized request (sorted JSON keys) per the
 * configured `MatchPolicy`. Same request → same id, so replay is a simple
 * filter against the cassette.
 */
export interface RecordedInteraction {
  /** Stable hash of the normalized request — the matchable key. */
  readonly id: string
  /** Full request that produced these events. */
  readonly request: StreamInput
  /** All stream events captured, in arrival order. */
  readonly events: ReadonlyArray<StreamEvent>
  readonly metadata: {
    /** epoch milliseconds */
    readonly recordedAt: number
    /** model id from the inner port (or `"unknown"` for test doubles) */
    readonly model: string
    /** wall-clock from first byte to stream end (ms) */
    readonly durationMs: number
    /** TRUE when `inner.stream` threw before completion — events are partial. */
    readonly partial?: boolean
    /** Error message if `partial === true`. */
    readonly error?: string
    /** SWE-bench instance id (e.g. "psf__requests-5414"). Optional — absent on
     *  old recordings that pre-date this field. */
    readonly instanceId?: string
    /** Bench run id (e.g. "run-1783358407538"). Optional — absent on old recordings. */
    readonly runId?: string
    /** 0-based attempt index within the instance. Optional — absent on old recordings. */
    readonly attempt?: number
    /** Parallel-lane correlation label (e.g. "repair-breadth#2", "verify-select#0")
     *  identifying WHICH concurrent candidate produced this turn. Set from
     *  `StreamInput.recordingLane` so N candidates sharing one recording port stay
     *  distinguishable on the single tape. REPLAY-NEUTRAL: never part of the hash.
     *  Absent on serial turns / old recordings. */
    readonly lane?: string
    /**
     * Active OTel `chat` span identity captured at `stream()` START (jul-12 OTel
     * unification, C4). Lets a cassette turn JOIN the OTLP/OBSERVE trace tree on
     * `{traceId,spanId}` — the SAME correlation key the OBSERVE recorder stamps.
     * REPLAY-NEUTRAL by contract: the request hash (`defaultHashRequest`) reads
     * ONLY request fields (messages/system/tools/thinking/toolChoice/
     * promptCacheKey/promptCacheRetention), never metadata, so trace ids can
     * never invalidate a cross-box cassette match. Absent when no `withSpan`
     * scope was active (off mode) / on old recordings. 16-hex lowercase ids. */
    readonly traceId?: string
    /** Active span id at capture (sibling of {@link traceId}). REPLAY-NEUTRAL. */
    readonly spanId?: string
    /** Parent span id of the active span, when it was a child (root ⇒ absent).
     *  REPLAY-NEUTRAL. */
    readonly parentSpanId?: string
    /**
     * Debug-mode enrichment (only populated when the recorder runs in `debug`
     * tier — `QUANTA_BENCH_RECORD_TRAJECTORY=debug`). A single OPAQUE, keyed slot
     * that any subsystem contributes a slice to (tool-exec timings, edit shas,
     * phase-gate rationale, …). REPLAY-NEUTRAL by contract: metadata never
     * participates in the request hash, so debug data can never invalidate a
     * cross-box cassette match. Absent on non-debug / old recordings.
     */
    readonly debug?: Readonly<Record<string, unknown>>
    /**
     * ADR-0539 rule 5 (jul-13) — expected-but-missing trace-context DEFECT
     * marker. Present ONLY when a live span sink was expected for this turn
     * (`traceContextExpected() === true`) but the active OTel ref was undefined,
     * i.e. a genuine correlation defect (NOT the legitimate off/unwired case).
     * REPLAY-NEUTRAL: metadata is never part of the request hash, so this can
     * never invalidate a cassette match. Absent on the byte-identical off path.
     */
    readonly observabilityDegraded?: Readonly<{
      readonly component: string
      readonly reason: string
    }>
  }
}

/**
 * Match policy decides which fields of `StreamInput` participate in the hash.
 *
 * - `exact` — every field: messages + system + tools + thinking + toolChoice.
 *   Strictest and the default; what most bug-reproduction recordings want.
 * - `messages-only` — only `messages[]`. System / tool / thinking drift between
 *   record and replay does not invalidate the match. Useful when refactoring
 *   the prompt scaffolding while keeping the conversation under test stable.
 * - `fuzzy-content` — concatenated text content of every message (role +
 *   stripped text, whitespace-collapsed). Survives prompt template tweaks that
 *   don't change the visible content (e.g. timestamp injection, trailing
 *   newlines).
 */
export type MatchPolicy = "exact" | "messages-only" | "fuzzy-content"

export interface ReplayMatchOpts {
  /** Defaults to the store's configured policy when omitted. */
  readonly policy?: MatchPolicy
  /**
   * Reserved for `messages-only` future widening — today the policy already
   * uses `role` + `content`. Accepted (and stored verbatim) so callers can
   * opt into a narrower field set in a follow-up without an API break.
   */
  readonly messageFields?: ReadonlyArray<"role" | "content">
}

/**
 * Persistence + lookup port. The recording adapter writes via `append`; the
 * replay adapter reads via `match` (which marks the hit as used so the next
 * call against the same request gets the next recording — supports replaying
 * a session that called the model twice with identical input).
 */
export interface ReplayStore {
  /** Append a recorded interaction. Idempotent at the disk level: each call
   *  writes exactly one JSONL line. Callers that need atomic-batch semantics
   *  should buffer in memory then call `save`. */
  append(record: RecordedInteraction): Promise<void>
  /** Find the FIRST UNUSED interaction matching `request` per `opts`. Marks
   *  the returned record as used in-memory so the next call returns the next
   *  match. Returns `null` when no unused match is left. */
  match(request: StreamInput, opts?: ReplayMatchOpts): Promise<RecordedInteraction | null>
  /** Load every record from disk. Malformed lines are skipped (and reported
   *  via the store's `onMalformed` callback when supplied). */
  load(): Promise<ReadonlyArray<RecordedInteraction>>
  /** Overwrite the file with the supplied records. Used by tooling that
   *  curates / scrubs / re-orders cassettes; the normal recording flow uses
   *  `append`. */
  save(records: ReadonlyArray<RecordedInteraction>): Promise<void>
  /** Clear all in-memory used markers so the same recording can be replayed
   *  again (typical: between two test cases sharing one cassette). */
  reset(): void
}

/**
 * Thrown by the replay adapter when no recording matches the incoming request
 * and `onMiss === "throw"`. Carries the request + policy so the caller can
 * decide whether to re-record or to fix the test.
 */
export class ReplayMissError extends Error {
  constructor(
    public readonly request: StreamInput,
    public readonly policy: MatchPolicy,
  ) {
    super(`No matching recording for request (policy=${policy})`)
    this.name = "ReplayMissError"
  }
}
