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
/** SOTA emit-guard mirroring Cursor `setTtftMs`: reject non-finite (NaN /
 *  ±Infinity) AND negative values. Returns the input verbatim on the happy
 *  path; `null` otherwise. Exported so a downstream OTel emitter can apply
 *  the same guard to externally-sourced latency values (the dashboard
 *  contract is "ttft_ms is a non-negative finite ms — or absent"). */
export const safeTtftMs = (raw) => {
    if (raw === null)
        return null;
    if (!Number.isFinite(raw))
        return null;
    if (raw < 0)
        return null;
    return raw;
};
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
export const createTurnTimingCapture = (clock = Date.now) => {
    let requestSentAt = null;
    let firstTokenAt = null;
    let streamEndAt = null;
    const markRequestSent = () => {
        requestSentAt = clock();
    };
    const markFirstToken = () => {
        if (firstTokenAt !== null)
            return;
        firstTokenAt = clock();
    };
    const markStreamEnd = () => {
        streamEndAt = clock();
    };
    const snapshot = () => {
        // The wiring contract is: markRequestSent + markStreamEnd are both called
        // (in that order) before snapshot. A `null` slot here is a programming
        // bug upstream; we read 0 so the math is defined and the bug is visible
        // (totalDurationMs = streamEndAt). Tests cover the wired path.
        const req = requestSentAt ?? 0;
        const end = streamEndAt ?? 0;
        const firstTokenLatencyMs = firstTokenAt === null ? null : firstTokenAt - req;
        const totalDurationMs = end - req;
        // SOTA mirror (Cursor `setTtftMs`): apply the non-finite/negative
        // guard to both scalar projections at snapshot time so downstream
        // emitters (`outcome.turnTiming`, OTel `gen_ai.response.time_to_first_token_ms`)
        // get the post-guard value uniformly. A `null` here means "do not
        // emit the attribute / surface the field"; the raw `firstTokenLatencyMs`
        // / `totalDurationMs` stay untouched so legacy readers keep their math.
        const ttftMs = safeTtftMs(firstTokenLatencyMs);
        const totalTtftMs = safeTtftMs(totalDurationMs);
        const out = {
            requestSentAt: req,
            firstTokenAt,
            firstTokenLatencyMs,
            streamEndAt: end,
            totalDurationMs,
            ttftMs,
            totalTtftMs,
        };
        return Object.freeze(out);
    };
    return { markRequestSent, markFirstToken, markStreamEnd, snapshot };
};
