/**
 * Consecutive-empty-stream circuit breaker (jun-26).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * A bench LLM turn can receive a content-LESS stream: the adapter emits only
 * NON-content telemetry (the OpenAI-Responses
 * `{type:"llm_continuation", phase:"prepare", reason:"no_prompt_cache_key"}`
 * observation, optionally a `usage` / `message_stop`) and then NO content
 * arrives, so the inter-chunk idle timeout in `src/llm/stream-timeout.ts` trips.
 * That timeout is classified transient, so the SAME request (identical
 * request-hash) is retried — each retry burns the FULL idle window
 * (`DEFAULT_IDLE_MS = 120_000`) producing zero content. Reproduced locally
 * (cassette `/tmp/g55-traj.jsonl`, records #2-5): the repro-test-generation turn
 * retried 4+ times, identical request id `ad9aa008339eaa04`, every one partial
 * with "LLM stream idle timeout … no data between chunks" and `events` carrying
 * ONLY the `llm_continuation` telemetry. With the default 120s idle this silently
 * burns many minutes per phase → the bench box sits idle for tens of minutes.
 *
 * ── The guard ────────────────────────────────────────────────────────────────
 * A pure `LLMPort` decorator (mirrors `recordingLlmPort`) that observes the
 * yielded `StreamEvent`s and tracks how many CONSECUTIVE content-less streams a
 * route has produced. The first CONTENT event (text / tool-call / thinking
 * delta) on a stream marks it non-empty and RESETS the route's counter. A stream
 * that ends — OR throws (e.g. the idle-timeout `stream_corrupt`) — having yielded
 * zero content events increments the counter. Once the counter reaches K
 * (default {@link DEFAULT_EMPTY_STREAM_BREAKER_K} = 2) the breaker throws a
 * TERMINAL, non-retryable {@link LLMError} (kind `bad_request`, which is in
 * `src/agent/retry.ts` FATAL_KINDS and the recovery-router `fatal` action)
 * instead of letting the transient-retry path loop. An optional short backoff is
 * awaited before re-opening a route that has at least one prior empty, so a
 * throttling endpoint is not hammered.
 *
 * ── Time-based decay / half-open (no permanent latch) ────────────────────────
 * The empties are TRANSIENT (throttle / auth wall / a momentary content-less
 * stream); a route that trips must NOT stay fatal for the rest of a long CLI
 * session after the throttle has passed. Each empty stamps the route with the
 * injected clock ({@link EmptyStreamBreakerOpts.now}); once
 * {@link DEFAULT_EMPTY_STREAM_BREAKER_DECAY_MS} of wall-time has elapsed since a
 * route's LAST empty, the next open HALF-OPENS — the consecutive count resets to
 * 0 and ONE trial is allowed through. A content trial fully closes the route; a
 * still-empty trial re-arms from 1 (NOT from the latched cap), so the route is
 * not instantly re-fatal. The clock is INJECTED (the `@/llm` slice never reads
 * the wall-clock in pure code).
 *
 * ── Safety-guard, not a posture knob ─────────────────────────────────────────
 * This is a failure-path safety guard. The default-OFF byte-identical invariant
 * does NOT apply (the guard is always active on the empty-stream failure path).
 * It IS byte-identical for the HEALTHY path: any stream that produces content
 * passes through verbatim and never trips, no matter how many in a row.
 *
 * ── Loud surfacing ───────────────────────────────────────────────────────────
 * The terminal throw carries an explicit, string-stable marker
 * ({@link EMPTY_STREAM_BREAKER_ERROR_MARKER}) and the route + count, and a
 * `logger.error` line is emitted — no silent burn (memory: no silent caps).
 */

import { errMessage, LLMError, type LLMProvider, logger } from "@/shared"
import type { LLMPort } from "./ports"
import { defaultHashRequest } from "./replay/jsonl-store"
import type { StreamEvent, StreamInput } from "./types"

/** Default K — small by design. After this many CONSECUTIVE content-less streams
 *  on the same route the breaker trips. 2 = "one empty might be a blip; two in a
 *  row is a throttle/auth wall, not a turn we should keep retrying". */
export const DEFAULT_EMPTY_STREAM_BREAKER_K = 2

/** Stable substring on the terminal error message so triage / tests can match
 *  without depending on the surrounding prose. */
export const EMPTY_STREAM_BREAKER_ERROR_MARKER = "consecutive empty streams (no content)"

/** Default cooldown (ms) after which a latched route DECAYS / HALF-OPENS. The
 *  empties that trip the breaker are caused by a TRANSIENT condition (throttle /
 *  auth wall / momentary content-less stream); without decay a route that hit K
 *  empties stays fatal for the rest of a long CLI session even after the throttle
 *  has long passed. After this much wall-time has elapsed since the route's LAST
 *  empty, the next open HALF-OPENS: the consecutive count is reset to 0 and ONE
 *  trial is allowed through. ~5 min — long enough that we are not re-hammering a
 *  still-throttling endpoint, short enough that a long session recovers on its
 *  own. */
export const DEFAULT_EMPTY_STREAM_BREAKER_DECAY_MS = 300_000

/**
 * True iff `ev` is a CONTENT event — assistant text, extended-thinking, or a
 * tool-call delta. These are the only events that constitute model output; a
 * stream that yields at least one is non-empty.
 *
 * Everything else is TELEMETRY / control: `llm_continuation` (continuation-wire
 * observation), `usage` / `output_progress` (token accounting), `message_stop`
 * (synthetic terminator), `response_in_progress` (heartbeat), `stream_reset`
 * (fallback tombstone), `signature_delta` (thinking-block signature — carries no
 * model SAY on its own). A stream that yields ONLY these is content-LESS.
 */
export const isStreamEventContentful = (ev: StreamEvent): boolean => {
  switch (ev.type) {
    case "text_delta":
    case "thinking_delta":
    case "tool_use_start":
    case "tool_use_delta":
    case "tool_use_end":
      return true
    default:
      return false
  }
}

export interface EmptyStreamBreakerOpts {
  /** Trip after this many CONSECUTIVE content-less streams on a route. Resolve
   *  the env override at the composition root and pass it here (the `@/llm`
   *  slice does not read `process.env`). Pass `Number.POSITIVE_INFINITY` to
   *  disable the breaker (test seam / red-on-injection control). Defaults to
   *  {@link DEFAULT_EMPTY_STREAM_BREAKER_K}. */
  readonly maxConsecutiveEmpty?: number
  /** Optional per-route key. The breaker keys its consecutive-empty counter by
   *  this string so UNRELATED requests do not cross-contaminate (an empty
   *  repro-gen stream must not count toward an unrelated localize stream).
   *  Defaults to the request's stable exact hash ({@link defaultHashRequest}),
   *  so only genuinely-identical requests — the cassette case: the SAME request
   *  (request-hash `ad9aa008339eaa04`) retried — accumulate consecutively. */
  readonly routeKey?: (input: StreamInput) => string
  /** Optional backoff (ms) awaited BEFORE re-opening a route that already has at
   *  least one prior empty stream — so a throttling endpoint is spaced out
   *  rather than hammered. Omitted / 0 ⇒ no backoff (byte-identical timing). */
  readonly backoffMs?: number
  /** Cooldown (ms) after which a latched route DECAYS / HALF-OPENS so a TRANSIENT
   *  throttle does not permanently poison a route in a long CLI session. Once
   *  this much time has elapsed since the route's LAST empty stream, the next open
   *  resets the consecutive count to 0 and lets ONE trial through (half-open). A
   *  successful (content) trial fully closes the route; another empty re-arms from
   *  1, NOT from the latched cap, so the route is not instantly re-fatal. Defaults
   *  to {@link DEFAULT_EMPTY_STREAM_BREAKER_DECAY_MS}. Pass
   *  `Number.POSITIVE_INFINITY` to DISABLE decay (the route latches permanently —
   *  the pre-decay behaviour; test seam). */
  readonly decayMs?: number
  /** Injectable clock (ms) so the decay/half-open is deterministic in tests. The
   *  `@/llm` slice does not read the wall-clock directly in pure code — resolve
   *  the real clock at the composition root. Defaults to `Date.now`. */
  readonly now?: () => number
  /** Injectable sleep for deterministic tests. Defaults to an abort-aware
   *  `setTimeout` that settles early on the stream's cancellation signal. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Abort-aware backoff sleep: settles immediately once `signal` aborts, so an
 *  aborted turn does not strand the breaker waiting out the full backoff delay
 *  (mirrors src/agent/loop/sleep.ts; kept local to avoid an @/llm→@/agent slice
 *  edge). With no signal it behaves like a plain timer. */
const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve()
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })

/** Relay every event of `inner`, flipping `flag.sawContent` true on the first
 *  CONTENT event. Extracted as a top-level generator so the decorator's
 *  coordinator stays within the biome cognitive-complexity cap. Re-throws the
 *  inner stream's error verbatim (the coordinator's catch decides the verdict).
 */
async function* relayCounting(
  inner: AsyncIterable<StreamEvent>,
  flag: { sawContent: boolean },
): AsyncIterable<StreamEvent> {
  for await (const ev of inner) {
    if (isStreamEventContentful(ev)) flag.sawContent = true
    yield ev
  }
}

/** Narrow a `LLMPort.provider` (a wide `string | undefined`) to the typed
 *  {@link LLMProvider} union, or `undefined` when it is absent / not a known
 *  tag. Keeps the breaker's error `provider` field type-correct without forcing
 *  an unchecked cast. */
const resolveProviderTag = (provider: string | undefined): LLMProvider | undefined =>
  provider === "anthropic" || provider === "openai" || provider === "chatgpt-oauth"
    ? provider
    : undefined

/**
 * Wrap an inner `LLMPort` with the consecutive-empty circuit breaker. Returns a
 * new `LLMPort`; the inner port is never mutated. Pure aside from the per-route
 * counter state captured in the closure (one decorator instance = one breaker).
 */
export const withEmptyStreamCircuitBreaker = (
  inner: LLMPort,
  opts: EmptyStreamBreakerOpts = {},
): LLMPort => {
  const k = opts.maxConsecutiveEmpty ?? DEFAULT_EMPTY_STREAM_BREAKER_K
  const keyOf = opts.routeKey ?? ((input: StreamInput) => defaultHashRequest(input, "exact"))
  const backoffMs = opts.backoffMs ?? 0
  const decayMs = opts.decayMs ?? DEFAULT_EMPTY_STREAM_BREAKER_DECAY_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? realSleep
  // Per-route record of CONSECUTIVE content-less streams: `count` and the
  // wall-clock (via the injected `now`) of the LAST empty, so a latched route can
  // DECAY / half-open after `decayMs` rather than staying fatal forever.
  interface RouteState {
    count: number
    lastEmptyAt: number
  }
  const consecutiveEmpty = new Map<string, RouteState>()

  const buildTerminal = (route: string, count: number, cause?: string): LLMError => {
    const where = route === "" ? "" : ` [route=${route}]`
    const message =
      `LLM returned ${count} ${EMPTY_STREAM_BREAKER_ERROR_MARKER}${where} ` +
      "— likely throttle/auth; aborting (not retrying a content-less stream loop)"
    logger.error("llm.empty_stream_breaker.tripped", {
      route,
      consecutiveEmpty: count,
      cap: k,
      provider: inner.provider,
      ...(cause !== undefined ? { cause } : {}),
    })
    // `bad_request` is a FATAL (never-retry) kind: src/agent/retry.ts FATAL_KINDS
    // and the recovery-router `fatal` action. This makes the breaker's verdict
    // terminal everywhere, so the transient-retry path stops instead of looping.
    // `provider` is carried only when it is one of the narrow LLMProvider tags
    // (LLMPort.provider is a wider `string`); the message itself is the SSOT.
    const provider = resolveProviderTag(inner.provider)
    return new LLMError(message, {
      kind: "bad_request",
      ...(provider !== undefined ? { provider } : {}),
    })
  }

  /** The route's prior consecutive-empty count, DECAYED. If `decayMs` has elapsed
   *  since the route's last empty stream, the latch is considered stale (a passed
   *  throttle) and the count half-opens to 0 — so the next open is allowed one
   *  trial instead of tripping the circuit-open pre-check forever. */
  const priorEmptyOf = (route: string): number => {
    const state = consecutiveEmpty.get(route)
    if (state === undefined) return 0
    if (now() - state.lastEmptyAt >= decayMs) return 0
    return state.count
  }

  /** Record that the route produced a content-LESS stream (clean end or throw).
   *  Increments the route's consecutive-empty count (stamping the decay clock) and
   *  returns the breaker's TERMINAL error to throw when the cap is reached, else
   *  `null` (let the original outcome stand). `cause` is the underlying throw
   *  message, if any. */
  const recordEmpty = (route: string, priorEmpty: number, cause?: string): LLMError | null => {
    const next = priorEmpty + 1
    consecutiveEmpty.set(route, { count: next, lastEmptyAt: now() })
    return next >= k ? buildTerminal(route, next, cause) : null
  }

  /** Decide what to throw when the inner stream REJECTED. Content seen before
   *  the throw ⇒ a real partial failure (reset, re-throw original). No content ⇒
   *  count it as empty and surface the breaker's terminal once the cap is hit,
   *  else re-throw the original error. Returns the error to throw. */
  const onStreamThrow = (
    route: string,
    priorEmpty: number,
    sawContent: boolean,
    err: unknown,
  ): unknown => {
    if (sawContent) {
      consecutiveEmpty.delete(route)
      return err
    }
    const cause = errMessage(err)
    return recordEmpty(route, priorEmpty, cause) ?? err
  }

  /** Decide what (if anything) to throw when the inner stream ENDED cleanly.
   *  Content ⇒ reset and return `null` (no throw). Content-less ⇒ count it and
   *  return the breaker's terminal once the cap is hit, else `null`. */
  const onStreamEnd = (route: string, priorEmpty: number, sawContent: boolean): LLMError | null => {
    if (sawContent) {
      consecutiveEmpty.delete(route)
      return null
    }
    return recordEmpty(route, priorEmpty)
  }

  const port: LLMPort = {
    ...(inner.model !== undefined ? { model: inner.model } : {}),
    ...(inner.contextWindowKey !== undefined ? { contextWindowKey: inner.contextWindowKey } : {}),
    ...(inner.provider !== undefined ? { provider: inner.provider } : {}),
    ...(inner.surfaceId !== undefined ? { surfaceId: inner.surfaceId } : {}),
    ...(inner.transportId !== undefined ? { transportId: inner.transportId } : {}),
    ...(inner.authMode !== undefined ? { authMode: inner.authMode } : {}),
    stream(input: StreamInput): AsyncIterable<StreamEvent> {
      const route = keyOf(input)
      // DECAYED read: a route that latched at K but whose last empty was longer
      // than `decayMs` ago HALF-OPENS to 0, so the circuit-open pre-check below
      // does not trip and one trial is allowed through (a transient throttle that
      // has passed must not poison the route for the rest of the session).
      const priorEmpty = priorEmptyOf(route)

      async function* iterate(): AsyncIterable<StreamEvent> {
        // CIRCUIT-OPEN pre-check: if the route already hit K empties on a prior
        // call AND the cooldown has NOT elapsed (so `priorEmpty` is still ≥ K),
        // trip immediately on the NEXT open rather than burning another full idle
        // window. (The end-of-stream check below is the primary trip; this guards
        // the re-entry path so we never re-issue past the cap while still latched.)
        if (priorEmpty >= k) throw buildTerminal(route, priorEmpty)

        // Backoff BEFORE re-opening a route that already had ≥1 empty — space out
        // a throttling endpoint. Skipped on the first attempt / when disabled.
        if (priorEmpty > 0 && backoffMs > 0) await sleep(backoffMs, input.signal)

        const flag = { sawContent: false }
        try {
          yield* relayCounting(inner.stream(input), flag)
        } catch (err) {
          // A stream that THREW (e.g. the idle-timeout `stream_corrupt`) having
          // yielded no content is an empty stream too — `onStreamThrow` decides
          // whether the breaker's terminal or the original error surfaces.
          throw onStreamThrow(route, priorEmpty, flag.sawContent, err)
        }
        // Clean end: count a content-less stream and trip at the cap.
        const terminal = onStreamEnd(route, priorEmpty, flag.sawContent)
        if (terminal !== null) throw terminal
      }

      return iterate()
    },
  }
  return port
}
