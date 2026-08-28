/**
 * Recording `LLMPort` adapter (ADR-0192).
 *
 * Wraps an inner `LLMPort` so every `stream()` call is captured into a
 * `ReplayStore` after the stream completes. Events flow to the caller in
 * real-time — the recorder is on the side, never a buffer in front.
 *
 * On `inner.stream` throwing mid-stream, we still write a `partial: true`
 * record holding everything we did capture. That's deliberate: a real bug-
 * reproduction cassette must include the failing turn, even if the model
 * died half-way through.
 */

import { createHash } from "node:crypto"
import { errMessage, logger } from "@/shared"
import { forwardPortIdentity } from "../port-identity"
import type { LLMPort } from "../ports"
import type { StreamEvent, StreamInput } from "../types"
import { defaultHashRequest } from "./jsonl-store"
import type { RecordedInteraction, ReplayStore } from "./types"

export interface RecordingLlmOpts {
  /** The real adapter doing the actual provider work. */
  readonly inner: LLMPort
  /** Where to append recorded interactions. */
  readonly store: ReplayStore
  /**
   * Optional scrub pass run BEFORE `store.append`. Sibling of ADR-0171 PII
   * redaction: callers wire their redactor in so secrets / PII never reach
   * disk. The scrubber may return a fresh `RecordedInteraction` or mutate +
   * return the input — we treat the return value as authoritative.
   */
  readonly scrubber?: (record: RecordedInteraction) => RecordedInteraction
  /** Override the request → id hash. Defaults to the JSONL store's stable
   *  sorted-key SHA-256. Useful for tests / shared id between recorder and
   *  store. */
  readonly hashRequest?: (req: StreamInput) => string
  /** Override `Date.now` for deterministic `recordedAt` in tests. */
  readonly now?: () => number
  /**
   * Optional per-call context threaded in from the bench harness so each
   * recorded turn carries instance/run/attempt labels. Metadata-only — does
   * NOT affect the request hash (cassette key unchanged).
   */
  readonly callCtx?: {
    readonly instanceId?: string
    readonly runId?: string
    readonly attempt?: number
  }
  /**
   * Optional DEBUG drain, called once per turn at commit. Returns the keyed
   * debug slices accumulated for that turn (or `undefined` for none), attached
   * as `metadata.debug`. Metadata-only — does NOT affect the request hash, so
   * debug enrichment can never invalidate a cassette match. The bench harness
   * wires the process-scoped debug sink here; generic callers leave it unset.
   */
  readonly debugDrain?: () => Record<string, unknown> | undefined
  /**
   * Optional DI provider for the ACTIVE OTel span identity (jul-12 OTel
   * unification, C4). Called ONCE per `stream()` at START and its result is
   * persisted into `metadata.{traceId,spanId,parentSpanId}` so a cassette turn
   * joins the OTLP/OBSERVE trace tree on `{traceId,spanId}`. DI (not an
   * `@/observability` import) because `@/llm/replay` may NOT reach across the
   * slice boundary — the bench composition (`@/apps/bench`) supplies the real
   * `getActiveTraceRef`, mirroring how `callCtx`/`debugDrain` are threaded.
   * Metadata-only ⇒ REPLAY-NEUTRAL: the request hash never reads metadata, so
   * this can NEVER change the cassette key. Returns `undefined` when no
   * `withSpan` scope is active ⇒ no trace keys ⇒ byte-identical.
   */
  readonly getActiveTraceRef?: () =>
    | { traceId: string; spanId: string; parentSpanId?: string }
    | undefined
  /**
   * ADR-0539 rule 5 enforcement (jul-13, "no per-event legacy fallback in
   * unified mode"). DI seam answering "was a live trace context EXPECTED for
   * this recorded turn?" — the bench composition binds it to
   * `() => getSpanSink() !== null` (a live sink means `withActiveSpanScope`
   * wraps every recorded unit, so `getActiveTraceRef()` should ALWAYS return a
   * ref). When this returns `true` AND `getActiveTraceRef()` yields `undefined`,
   * that is a correlation DEFECT (context expected-but-missing): the recorder
   * surfaces ONE `observability_degraded` signal — a durable, greppable
   * `logger.warn` PLUS a replay-neutral `metadata.observabilityDegraded` marker
   * on the committed turn (metadata is never hashed ⇒ the cassette key is
   * unchanged). Latched per port instance (systemic ⇒ never spam).
   *
   * When ABSENT or returning `false`, no context is expected (OTel off /
   * context-never-wired — the LEGITIMATE case): no marker, no warn ⇒
   * BYTE-IDENTICAL to today. Mirrors the `getActiveTraceRef` DI so
   * `@/llm/replay` never imports `@/observability` (slice boundary).
   */
  readonly traceContextExpected?: () => boolean
}

/** Build the trace-ref metadata spread from a captured active {@link TraceRef}.
 *  Empty object when no span was active ⇒ no trace keys land ⇒ byte-identical
 *  to the pre-trace record. Metadata-only, REPLAY-NEUTRAL (never hashed). */
function traceMeta(
  ref: { traceId: string; spanId: string; parentSpanId?: string } | undefined,
): Record<string, string> {
  if (ref === undefined) return {}
  return {
    traceId: ref.traceId,
    spanId: ref.spanId,
    ...(ref.parentSpanId !== undefined ? { parentSpanId: ref.parentSpanId } : {}),
  }
}

/** Best-effort active-ref capture: a throwing provider must never fail a live
 *  turn, so failure collapses to `undefined` (no trace keys). */
function safeActiveRef(
  provider:
    | (() => { traceId: string; spanId: string; parentSpanId?: string } | undefined)
    | undefined,
): { traceId: string; spanId: string; parentSpanId?: string } | undefined {
  if (provider === undefined) return undefined
  try {
    return provider()
  } catch (e) {
    logger.warn("recording-llm: active trace reference provider failed", { error: errMessage(e) })
    return undefined
  }
}

/** Best-effort "trace context expected?" probe: a throwing predicate must never
 *  fail a live turn, so failure collapses to `false` (no defect asserted). */
function safeExpected(probe: (() => boolean) | undefined): boolean {
  if (probe === undefined) return false
  try {
    return probe() === true
  } catch (e) {
    logger.warn("recording-llm: trace-context expectation probe failed", { error: errMessage(e) })
    return false
  }
}

/** Best-effort debug drain: a throwing drainer must never sink a successful
 *  turn, so failure collapses to `undefined` (no `debug` key). */
function safeDrain(
  drain: (() => Record<string, unknown> | undefined) | undefined,
): Record<string, unknown> | undefined {
  if (drain === undefined) return undefined
  try {
    return drain()
  } catch (e) {
    logger.warn("recording-llm: debug drain failed", { error: errMessage(e) })
    return undefined
  }
}

interface DegradedSentinelParams {
  readonly cause: unknown
  readonly hashFn: (req: StreamInput) => string
  readonly input: StreamInput
  readonly startedAt: number
  readonly captured: readonly StreamEvent[]
  readonly stripEphemeralRequest: (input: StreamInput) => StreamInput
  readonly opts: RecordingLlmOpts
  readonly now: () => number
  /** Active OTel span identity captured at `stream()` START (C4). */
  readonly traceRef: { traceId: string; spanId: string; parentSpanId?: string } | undefined
}

/** F7 sentinel: a minimal degraded record so a swallowed commit failure on
 *  a successful turn leaves a VISIBLE hole-marker on the tape instead of
 *  nothing. Deliberately BYPASSES `opts.scrubber` (the scrubber is a likely
 *  culprit) — it carries no captured events, only the failing turn's key +
 *  a `partial:true`/`error` marker, so no unscrubbed content can leak. */
async function appendDegradedSentinel(params: DegradedSentinelParams): Promise<void> {
  const { cause, hashFn, input, startedAt, captured, stripEphemeralRequest, opts, now, traceRef } =
    params
  let id: string
  try {
    id = hashFn(input)
  } catch (e) {
    logger.warn("recording-llm: degraded sentinel hash failed; using fallback id", {
      error: errMessage(e),
    })
    id = createHash("sha256")
      .update(`degraded:${startedAt}:${captured.length}`)
      .digest("hex")
      .slice(0, 16)
  }
  const sentinel: RecordedInteraction = {
    id,
    request: stripEphemeralRequest(input),
    events: [],
    metadata: {
      recordedAt: startedAt,
      model: opts.inner.model ?? "unknown",
      durationMs: now() - startedAt,
      partial: true,
      error: `commit-failed: ${errMessage(cause)}`,
      ...(opts.callCtx?.instanceId !== undefined ? { instanceId: opts.callCtx.instanceId } : {}),
      ...(opts.callCtx?.runId !== undefined ? { runId: opts.callCtx.runId } : {}),
      ...(opts.callCtx?.attempt !== undefined ? { attempt: opts.callCtx.attempt } : {}),
      ...(input.recordingLane !== undefined ? { lane: input.recordingLane } : {}),
      ...traceMeta(traceRef),
    },
  }
  await opts.store.append(sentinel)
}

/** Ephemeral request fields that must NOT be persisted (kept replay-neutral).
 *  Module-scoped (pure) as part of the god-FUNCTION split that pulled the stream
 *  implementation out of {@link recordingLlmPort}. */
const stripEphemeralRequest = (input: StreamInput): StreamInput => {
  const {
    signal: _signal,
    turnTimingCapture: _turnTimingCapture,
    onChunk: _onChunk,
    onCheckpoint: _onCheckpoint,
    responsesContinuation: _responsesContinuation,
    // recordingLane is a correlation label, NOT request content: strip it from
    // the stored request (kept replay-neutral) and stamp it into metadata.lane.
    recordingLane: _recordingLane,
    ...rest
  } = input
  return rest
}

/** Every optional field of a committed turn's metadata.
 *
 *  MODULE scope (not a closure inside the stream impl) on purpose: a nested
 *  function definition is itself a nesting level, so the nine conditional
 *  spreads below each cost DOUBLE when written inside `recordingStreamImpl`.
 *  Hoisting them out is what puts the commit path under the cap; every input is
 *  an explicit parameter so nothing is captured.
 *
 *  All nine fields are REPLAY-NEUTRAL: metadata is never hashed, so the
 *  cassette key is unchanged and an absent field is byte-identical to
 *  pre-feature output. */
interface CommitMetadataParams {
  readonly opts: RecordingLlmOpts
  readonly input: StreamInput
  readonly startedAt: number
  readonly durationMs: number
  readonly partial: boolean
  readonly writeError: Error | null
  readonly traceRef: { traceId: string; spanId: string; parentSpanId?: string } | undefined
  readonly traceContextMissing: boolean
  readonly debug: Record<string, unknown> | undefined
}

function commitMetadata(p: CommitMetadataParams): RecordedInteraction["metadata"] {
  const { opts, input, partial, writeError } = p
  return {
    recordedAt: p.startedAt,
    model: opts.inner.model ?? "unknown",
    durationMs: p.durationMs,
    ...(partial ? { partial: true } : {}),
    ...(partial && writeError !== null ? { error: writeError.message } : {}),
    ...(opts.callCtx?.instanceId !== undefined ? { instanceId: opts.callCtx.instanceId } : {}),
    ...(opts.callCtx?.runId !== undefined ? { runId: opts.callCtx.runId } : {}),
    ...(opts.callCtx?.attempt !== undefined ? { attempt: opts.callCtx.attempt } : {}),
    // Per-call parallel-lane label (replay-neutral; see StreamInput.recordingLane).
    ...(input.recordingLane !== undefined ? { lane: input.recordingLane } : {}),
    // C4: active OTel span identity (replay-neutral; joins the trace tree).
    ...traceMeta(p.traceRef),
    // ADR-0539 rule 5: expected-but-missing trace context DEFECT marker
    // (replay-neutral — metadata is never hashed, so the cassette key is
    // unchanged). Absent on the off/never-expected path ⇒ byte-identical.
    ...(p.traceContextMissing
      ? {
          observabilityDegraded: {
            component: "recordingLlmPort",
            reason: "missing_trace_context",
          },
        }
      : {}),
    ...(p.debug !== undefined ? { debug: p.debug } : {}),
  }
}

interface RecordingStreamCtx {
  readonly opts: RecordingLlmOpts
  readonly now: () => number
  readonly hashFn: (req: StreamInput) => string
  /** ADR-0539 rule 5 latch: a SYSTEMIC missing trace context affects every turn,
   *  so warn ONCE per PORT instance. Threaded as a per-port ref (was a closure
   *  `let missingRefReported`) so the stream impl can live at module scope. */
  readonly missingRef: { reported: boolean }
}

/** The recording `stream()` implementation — extracted from `recordingLlmPort`
 *  to keep both under the god-FUNCTION ratchet. Behavior-identical to the prior
 *  inline closure; the only change is that the per-port warn-once latch is
 *  `ctx.missingRef.reported` instead of a closure `let`. */
function recordingStreamImpl(
  input: StreamInput,
  ctx: RecordingStreamCtx,
): AsyncIterable<StreamEvent> {
  const { opts, now, hashFn, missingRef } = ctx
  const startedAt = now()
  // C4: sample the ACTIVE OTel span identity HERE, at stream() START — the
  // enclosing `chat` span. Captured once (not at commit, which runs later on
  // the async iterator's frame where the active context may have unwound)
  // and stamped into metadata so the cassette turn joins the trace tree.
  const traceRef = safeActiveRef(opts.getActiveTraceRef)
  // ADR-0539 rule 5 (NOW ENFORCED): a trace context was EXPECTED (span sink
  // live) but the active ref is undefined ⇒ correlation DEFECT. Stamp a
  // replay-neutral marker on the committed turn and warn ONCE. When no
  // context was expected (probe absent / false) this is `false` ⇒
  // byte-identical off path.
  const traceContextMissing = traceRef === undefined && safeExpected(opts.traceContextExpected)
  const captured: StreamEvent[] = []
  const inner = opts.inner.stream(input)
  // We delay `id` computation until after `now` is sampled so a custom
  // hash that includes time can do so; the default hash ignores it.
  let writeError: Error | null = null

  /** The record id, with a degenerate-but-stable fallback so a hash failure
   *  never aborts the append. A unit because it is the only try/catch in the
   *  commit path and its fallback (SHA-256 of start-time + event count) is a
   *  self-contained rule: a content-free constant would collide on every miss.
   *  Declared here (not module scope) so it closes over nothing — every input
   *  is a parameter. */
  function commitId(capturedLen: number): string {
    try {
      return hashFn(input)
    } catch (e) {
      logger.warn("recording-llm: request hash failed; using fallback id", { error: errMessage(e) })
      return createHash("sha256")
        .update(`fallback:${startedAt}:${capturedLen}`)
        .digest("hex")
        .slice(0, 16)
    }
  }

  async function commit(partial: boolean): Promise<void> {
    const durationMs = now() - startedAt
    const id = commitId(captured.length)
    // Drain debug slices (metadata-only, replay-neutral). Drained AFTER the id
    // so a hash-failure warn still precedes the drain, as it always did.
    const debug = safeDrain(opts.debugDrain)
    const baseRecord: RecordedInteraction = {
      id,
      request: stripEphemeralRequest(input),
      events: captured.slice(),
      metadata: commitMetadata({
        opts,
        input,
        startedAt,
        durationMs,
        partial,
        writeError,
        traceRef,
        traceContextMissing,
        debug,
      }),
    }
    // ADR-0539 rule 5: warn ONCE per port (systemic ⇒ no per-turn spam) —
    // the durable, greppable operator signal that OTel correlation is broken.
    if (traceContextMissing && !missingRef.reported) {
      missingRef.reported = true
      logger.warn("recording-llm: trace context expected but missing (observability degraded)", {
        reason: "missing_trace_context",
        instanceId: opts.callCtx?.instanceId,
        runId: opts.callCtx?.runId,
        attempt: opts.callCtx?.attempt,
      })
    }
    const finalRecord = opts.scrubber !== undefined ? opts.scrubber(baseRecord) : baseRecord
    await opts.store.append(finalRecord)
  }

  async function commitBestEffort(partial: boolean): Promise<void> {
    try {
      await commit(partial)
    } catch (commitErr) {
      // F7: recording is a sidecar after a successful live turn, so we must
      // NEVER flip the already-successful stream into a surfaced LLM failure
      // (that's the caller contract — unlike the partial:true path which
      // rethrows). But swallowing the error SILENTLY turned a lost turn into
      // an invisible hole: a scrubber or store.append that threw on a
      // SUCCEEDED stream left no record and no signal. So we (1) warn — a
      // durable, greppable operator signal — and (2) attempt a minimal
      // degraded record so the lost turn is at least VISIBLE on the tape.
      logger.warn("recording-llm: commit failed on a successful turn (turn NOT recorded)", {
        error: errMessage(commitErr),
        instanceId: opts.callCtx?.instanceId,
        runId: opts.callCtx?.runId,
        attempt: opts.callCtx?.attempt,
        capturedEvents: captured.length,
      })
      await appendDegradedSentinel({
        cause: commitErr,
        hashFn,
        input,
        startedAt,
        captured,
        stripEphemeralRequest,
        opts,
        now,
        traceRef,
      }).catch(() => {
        // The sentinel is itself best-effort: if store.append is what broke,
        // this degraded append will break too. The `logger.warn` above is the
        // guaranteed non-silent signal; the sentinel is a bonus when the
        // failure was in the scrubber (append still works).
      })
    }
  }

  async function* iterate(): AsyncIterable<StreamEvent> {
    try {
      for await (const ev of inner) {
        captured.push(ev)
        yield ev
      }
    } catch (err) {
      writeError = err instanceof Error ? err : new Error(String(err))
      await commit(true).catch(() => {
        // Swallow append failure — original error is the more important
        // signal to surface.
      })
      throw writeError
    }
    await commitBestEffort(false)
  }

  return iterate()
}

export function recordingLlmPort(opts: RecordingLlmOpts): LLMPort {
  const now = opts.now ?? Date.now
  const hashFn = opts.hashRequest ?? ((req: StreamInput) => defaultHashRequest(req, "exact"))
  const missingRef = { reported: false }
  return {
    // aug-28 — ONE forwarder (see `@/llm/port-identity`). The inline copy this
    // replaces already forwarded `contextWindowKey` (its comment says why) but
    // still dropped `listModels`; routing through the helper means the NEXT port
    // capability cannot be dropped here either.
    ...forwardPortIdentity(opts.inner),
    stream: (input: StreamInput): AsyncIterable<StreamEvent> =>
      recordingStreamImpl(input, { opts, now, hashFn, missingRef }),
  }
}
