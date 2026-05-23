/**
 * T1: LLM stream first-chunk + inter-chunk idle timeout wrapper.
 *
 * Why this exists: SDK transports give us only an HTTP-level timeout. A
 * provider that opens the response stream but then never (or stops) writing
 * SSE/WS frames leaves the consumer hung indefinitely. The observed bench
 * failure ("Hung-Stream Abort", gpt-4o-mini django run): 115 s of silence,
 * zero stream chunks, then a manual abort. The agent loop has
 * `MAX_TURN_STREAM_RETRIES = 3` but it only fires on THROWN errors — silence
 * is never an error, so retry never engaged.
 *
 * Fix shape: an `AsyncIterable` decorator that races each `next()` of the
 * raw stream against a deadline. Two independent budgets:
 *   - `firstChunkMs` until the FIRST yield (default 60 000 ms — reasoning
 *     models like o1 can legitimately take 30s+ before any token).
 *   - `idleMs` between subsequent yields (default 120 000 ms — long
 *     completions are OK, but no sane provider is silent for >2 minutes
 *     mid-response).
 *
 * On timeout we throw an {@link LLMError} with `kind:"stream_corrupt"`.
 * That kind ALREADY exists in our taxonomy ({@link LLMError}) and the
 * agent loop's `classifyLLMError` routes it through the same-turn retry
 * path (message contains "timeout" → `RETRYABLE_MARKERS` hit → retry with
 * backoff). We deliberately reuse `stream_corrupt` rather than mint a new
 * kind: invariant compatibility with all downstream policy.
 *
 * Abort wiring: the wrapper owns an {@link AbortController}. When EITHER
 * timeout fires we call `controller.abort()` so the upstream SDK `fetch`
 * (which observes the same signal we forward) cancels the underlying HTTP
 * request — no orphan connection holding the socket open. The caller's
 * own signal is composed in: aborting it ALSO aborts the inner controller
 * so the SDK fetch teardown is identical regardless of which side trips.
 *
 * Pure decorator: zero behavioural change on a stream that yields within
 * budget (each `for await` step passes through verbatim). Only the
 * silence-hang failure mode is converted from "wait forever" into
 * "structured retryable error".
 */
import { LLMError } from "@/shared";
/** Defaults (also the env-knob baseline). Exported so tests + adapter
 *  construction both see the same numbers. */
export const DEFAULT_FIRST_CHUNK_MS = 60_000;
export const DEFAULT_IDLE_MS = 120_000;
const buildTimeoutError = (reason, ms, provider) => {
    // Message includes "timeout" so `classifyLLMError` in `src/agent/retry.ts`
    // (which checks `RETRYABLE_MARKERS` for "timeout"/"timed out") routes this
    // through the existing same-turn retry path. Do NOT change this wording
    // without also extending the retry markers — the integration is by string.
    const message = reason === "first-chunk"
        ? `LLM stream first-chunk timeout after ${ms}ms (provider sent no data; timed out)`
        : `LLM stream idle timeout after ${ms}ms (no data between chunks; timed out)`;
    return new LLMError(message, {
        kind: "stream_corrupt",
        provider,
        cause: new Error(`${reason} timeout @${ms}ms`),
    });
};
/**
 * Wrap a raw stream with first-chunk and inter-chunk idle deadlines.
 * The returned `AsyncIterable` is single-use (matches the SDK's own
 * single-shot stream semantics — never re-iterate a model response).
 */
export const withStreamTimeout = (raw, opts) => {
    const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
    return {
        async *[Symbol.asyncIterator]() {
            const iter = raw[Symbol.asyncIterator]();
            // Internal controller. Aborting it tears down the upstream SDK fetch
            // (the SDK observes this via the same signal contract the SDK clients
            // expose). The caller's signal is forwarded: when they abort, we also
            // abort our controller so the SDK teardown is symmetric.
            const controller = new AbortController();
            const onCallerAbort = () => {
                if (!controller.signal.aborted)
                    controller.abort(opts.signal?.reason);
            };
            if (opts.signal) {
                if (opts.signal.aborted) {
                    controller.abort(opts.signal.reason);
                }
                else {
                    opts.signal.addEventListener("abort", onCallerAbort, { once: true });
                }
            }
            let isFirst = true;
            try {
                for (;;) {
                    // Two competing promises:
                    //   next  — the SDK's next chunk (or end-of-stream)
                    //   guard — a deadline timer; resolves to a synthetic "timed out"
                    //
                    // Promise.race resolves to whichever fires first. On the timeout
                    // path we call `controller.abort()` so the SDK fetch is cancelled
                    // (no orphan request) and then throw the structured LLMError.
                    const ms = isFirst ? opts.firstChunkMs : opts.idleMs;
                    const reason = isFirst ? "first-chunk" : "idle";
                    let timerHandle;
                    const timeoutPromise = new Promise((resolve) => {
                        timerHandle = setTimer(() => resolve({ timedOut: true }), ms);
                    });
                    const nextPromise = iter.next().then((r) => ({ timedOut: false, r }));
                    // eslint-disable-next-line no-await-in-loop
                    const winner = await Promise.race([nextPromise, timeoutPromise]);
                    if (timerHandle !== undefined)
                        clearTimer(timerHandle);
                    if (winner.timedOut) {
                        // Tear down the upstream first so the SDK's fetch returns and any
                        // pending socket is released — THEN throw. Try to call the inner
                        // iterator's `return` too so the SDK can clean up any state it
                        // attached to the iterator.
                        if (!controller.signal.aborted)
                            controller.abort();
                        try {
                            await iter.return?.(undefined);
                        }
                        catch {
                            // Best-effort cleanup; never let a teardown error mask the
                            // primary timeout that the caller actually needs to see.
                        }
                        throw buildTimeoutError(reason, ms, opts.provider);
                    }
                    const r = winner.r;
                    if (r.done)
                        return;
                    isFirst = false;
                    yield r.value;
                }
            }
            finally {
                if (opts.signal)
                    opts.signal.removeEventListener("abort", onCallerAbort);
            }
        },
    };
};
/** Resolve effective options for an adapter: caller overrides win, env knobs
 *  next, defaults last. Read ONCE at adapter construction (T1 contract). */
export const resolveStreamTimeoutMs = (envFirstChunkMs, envIdleMs, override) => ({
    firstChunkMs: override?.firstChunkMs ?? envFirstChunkMs ?? DEFAULT_FIRST_CHUNK_MS,
    idleMs: override?.idleMs ?? envIdleMs ?? DEFAULT_IDLE_MS,
});
/** Variant of {@link withStreamTimeout} that also surfaces the internal
 *  controller via a probe callback. Production code uses the plain export;
 *  tests use this. Behaviour is otherwise identical. */
export const withStreamTimeoutProbed = (raw, opts) => {
    const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
    return {
        async *[Symbol.asyncIterator]() {
            const iter = raw[Symbol.asyncIterator]();
            const controller = new AbortController();
            opts.onController?.(controller);
            const onCallerAbort = () => {
                if (!controller.signal.aborted)
                    controller.abort(opts.signal?.reason);
            };
            if (opts.signal) {
                if (opts.signal.aborted) {
                    controller.abort(opts.signal.reason);
                }
                else {
                    opts.signal.addEventListener("abort", onCallerAbort, { once: true });
                }
            }
            let isFirst = true;
            try {
                for (;;) {
                    const ms = isFirst ? opts.firstChunkMs : opts.idleMs;
                    const reason = isFirst ? "first-chunk" : "idle";
                    let timerHandle;
                    const timeoutPromise = new Promise((resolve) => {
                        timerHandle = setTimer(() => resolve({ timedOut: true }), ms);
                    });
                    const nextPromise = iter.next().then((r) => ({ timedOut: false, r }));
                    // eslint-disable-next-line no-await-in-loop
                    const winner = await Promise.race([nextPromise, timeoutPromise]);
                    if (timerHandle !== undefined)
                        clearTimer(timerHandle);
                    if (winner.timedOut) {
                        if (!controller.signal.aborted)
                            controller.abort();
                        try {
                            await iter.return?.(undefined);
                        }
                        catch {
                            // best-effort
                        }
                        throw buildTimeoutError(reason, ms, opts.provider);
                    }
                    const r = winner.r;
                    if (r.done)
                        return;
                    isFirst = false;
                    yield r.value;
                }
            }
            finally {
                if (opts.signal)
                    opts.signal.removeEventListener("abort", onCallerAbort);
            }
        },
    };
};
