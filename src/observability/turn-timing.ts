/**
 * Turn-timing capture — ADR-0077.
 *
 * Records the three wall-clock anchors that pin down a single LLM-stream turn:
 *
 *   1. `requestSentAt`  — the moment the loop hands the request to the LLM
 *      adapter (i.e. `llm.stream(...)` is called).
 *   2. `firstTokenAt`   — the moment the FIRST piece of model output (text,
 *      thinking, or tool_use start) arrives off the stream. Idempotent: only
 *      the first call records; later calls are no-ops. `null` when the
 *      capture never saw a chunk (e.g. an empty stream / immediate abort) —
 *      we MUST NOT fabricate a value.
 *   3. `streamEndAt`    — the moment the stream finishes draining (or aborts).
 *
 * From these three anchors two derived quantities are surfaced:
 *
 *   - `firstTokenLatencyMs`  — `firstTokenAt - requestSentAt`, or `null` when
 *     `firstTokenAt` itself is `null`.
 *   - `totalDurationMs`      — `streamEndAt - requestSentAt`. Always a number
 *     because both anchors are forced by the loop (request must be sent before
 *     the stream can end).
 *
 * Pure / no IO. The clock is injected so tests can pin time deterministically;
 * the default is `Date.now`. There are no probabilistic decisions and no
 * fallback paths — `markFirstToken` either records on the first call or does
 * nothing on every subsequent call, and `snapshot` returns exactly what was
 * recorded (no synthesis, no swallowed undefined).
 */

/** Frozen snapshot of one turn's wall-clock anchors. All four timestamps are
 *  in milliseconds since the unix epoch (or the injected clock's origin).
 *
 *  INVARIANT: `requestSentAt <= streamEndAt` and (when present)
 *  `requestSentAt <= firstTokenAt <= streamEndAt`. Enforced by the order in
 *  which the loop calls the capture methods, not by runtime checks here —
 *  any violation is a programming bug in the wiring, not user data.
 *
 *  SOTA-mirror (Cursor `setTtftMs(n)`): `ttftMs` / `totalTtftMs` are the
 *  scalar projections explicitly emit-guarded against non-finite (NaN /
 *  Infinity) and negative (clock-skew) values — exactly the two failure
 *  modes the Cursor surface rejects before writing telemetry. A value that
 *  fails either guard surfaces as `null` here so the OTel emit can omit
 *  the attribute rather than poison the dashboard with a junk number.
 */
export interface TurnTiming {
  readonly requestSentAt: number
  readonly firstTokenAt: number | null
  readonly firstTokenLatencyMs: number | null
  readonly streamEndAt: number
  readonly totalDurationMs: number
  /** SOTA Cursor `ttft_ms`: scalar first-token latency, post-guard.
   *  `null` iff (a) no first token was ever stamped, OR (b) the raw
   *  arithmetic produced a non-finite / negative value (clock skew /
   *  out-of-order marks). Mirrors `firstTokenLatencyMs` on the happy path. */
  readonly ttftMs: number | null
  /** SOTA Cursor `total_ttft_ms`: scalar total duration, post-guard.
   *  `null` iff the raw arithmetic produced a non-finite / negative value.
   *  Mirrors `totalDurationMs` on the happy path. */
  readonly totalTtftMs: number | null
}

/** SOTA emit-guard mirroring Cursor `setTtftMs`: reject non-finite (NaN /
 *  ±Infinity) AND negative values. Returns the input verbatim on the happy
 *  path; `null` otherwise. Exported so a downstream OTel emitter can apply
 *  the same guard to externally-sourced latency values (the dashboard
 *  contract is "ttft_ms is a non-negative finite ms — or absent"). */
export const safeTtftMs = (raw: number | null): number | null => {
  if (raw === null) return null
  if (!Number.isFinite(raw)) return null
  if (raw < 0) return null
  return raw
}

/** Mutable capture handle. Constructed at turn-top; mutated by the loop /
 *  stream consumer; snapshotted at turn-end. */
export interface TurnTimingCapture {
  /** Stamp `requestSentAt`. MUST be called exactly once, immediately before
   *  the LLM stream is opened. */
  markRequestSent(): void
  /** Stamp `firstTokenAt` ONLY on the very first call; idempotent on every
   *  subsequent call. Wired to fire on the first of
   *  (`text_delta` | `thinking_delta` | `content_block_start` where
   *  `type === "tool_use"`) so it measures real model-output latency, not
   *  setup overhead. */
  markFirstToken(): void
  /** Stamp `streamEndAt`. MUST be called exactly once, immediately after the
   *  stream finishes draining (or aborts). */
  markStreamEnd(): void
  /** Frozen snapshot. Safe to call multiple times — returns a new object each
   *  call, never mutated by later marks. */
  snapshot(): TurnTiming
}

/** Default millisecond clock — `Date.now`. Override in tests by passing a
 *  deterministic counter. The signature is intentionally `() => number` (not
 *  `Date`) so a test can yield a monotone sequence without faking a class. */
type Clock = () => number

/**
 * Factory — build a fresh capture pinned to the (optional) injected clock.
 *
 * Implementation notes (no-heuristic posture):
 *   - The three "mark" methods write to a closed-over numeric slot ONCE; a
 *     second mark on `markRequestSent` / `markStreamEnd` overwrites (the loop
 *     calls these exactly once by contract — overwrite is a programming bug,
 *     but we keep the slot writable to keep the runtime free of throw paths
 *     that would mask the upstream bug).
 *   - `markFirstToken` is the only method that explicitly gates on its slot:
 *     a non-null slot means "already stamped", so the call is a no-op. This
 *     matches the contract above (first chunk wins; further chunks ignored).
 *   - `snapshot()` returns a frozen object whose `firstTokenLatencyMs` is
 *     derived purely arithmetically — never undefined-coerced.
 */
export const createTurnTimingCapture = (clock: Clock = Date.now): TurnTimingCapture => {
  let requestSentAt: number | null = null
  let firstTokenAt: number | null = null
  let streamEndAt: number | null = null

  const markRequestSent = (): void => {
    requestSentAt = clock()
  }

  const markFirstToken = (): void => {
    if (firstTokenAt !== null) return
    firstTokenAt = clock()
  }

  const markStreamEnd = (): void => {
    streamEndAt = clock()
  }

  const snapshot = (): TurnTiming => {
    // The wiring contract is: markRequestSent + markStreamEnd are both called
    // (in that order) before snapshot. A `null` slot here is a programming
    // bug upstream; we read 0 so the math is defined and the bug is visible
    // (totalDurationMs = streamEndAt). Tests cover the wired path.
    const req = requestSentAt ?? 0
    const end = streamEndAt ?? 0
    const firstTokenLatencyMs = firstTokenAt === null ? null : firstTokenAt - req
    const totalDurationMs = end - req
    // SOTA mirror (Cursor `setTtftMs`): apply the non-finite/negative
    // guard to both scalar projections at snapshot time so downstream
    // emitters (`outcome.turnTiming`, OTel `gen_ai.response.time_to_first_token_ms`)
    // get the post-guard value uniformly. A `null` here means "do not
    // emit the attribute / surface the field"; the raw `firstTokenLatencyMs`
    // / `totalDurationMs` stay untouched so legacy readers keep their math.
    const ttftMs = safeTtftMs(firstTokenLatencyMs)
    const totalTtftMs = safeTtftMs(totalDurationMs)
    const out: TurnTiming = {
      requestSentAt: req,
      firstTokenAt,
      firstTokenLatencyMs,
      streamEndAt: end,
      totalDurationMs,
      ttftMs,
      totalTtftMs,
    }
    return Object.freeze(out)
  }

  return { markRequestSent, markFirstToken, markStreamEnd, snapshot }
}
