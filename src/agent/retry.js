import { LLMError } from "@/shared";
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
/** Backoff ceiling (~15s) regardless of attempt count. */
const MAX_DELAY_MS = 15_000;
/** Substrings (lowercased) marking a transient, safe-to-retry failure. */
const RETRYABLE_MARKERS = [
    "429",
    "500",
    "502",
    "503",
    "504",
    "timeout",
    "timed out",
    "econnreset",
    "econnrefused",
    "etimedout",
    "socket hang up",
    "overloaded",
    "rate limit",
    "rate-limit",
    "ratelimit",
    "temporarily",
    "try again",
];
/** Substrings (lowercased) that force a NON-retryable classification even if a
 *  retryable marker also appears (auth/client errors are never transient). */
const FATAL_MARKERS = [
    "401",
    "403",
    "400",
    "404",
    "invalid api key",
    "authentication",
    "unauthorized",
    "permission",
    "malformed",
    "invalid request",
    "not found",
];
/** Substrings (lowercased) marking a "prompt too long" / context-overflow
 *  failure. These need reactive compaction, NOT plain retry (a retry of the
 *  same oversized prompt fails identically). */
const PTL_MARKERS = [
    "prompt is too long",
    "prompt too long",
    "context length",
    "context_length",
    "context window",
    "maximum context",
    "too many tokens",
];
/** {@link LLMErrorKind} values (from `@/shared`, the boundary classifier) that
 *  unambiguously map to "transient, safe to retry". */
const RETRYABLE_KINDS = new Set([
    "overloaded",
    "rate_limit",
    "server_error",
    "network",
]);
/** {@link LLMErrorKind} values that unambiguously map to "never retry".
 *  `not_implemented` is here because a stub adapter throws identically every
 *  call — same-provider retry is pure waste. (It IS fallback-eligible: see
 *  `FALLBACK_KINDS` in `src/llm/fallback.ts`, which lets the chain advance to
 *  the next provider instead.) */
const FATAL_KINDS = new Set([
    "auth",
    "bad_request",
    "not_found",
    "not_implemented",
    "stream_corrupt",
    "aborted",
]);
/** True iff `e` looks like a transient LLM failure worth retrying. Only
 *  {@link LLMError} is ever retryable; unknown error types are treated fatal.
 *
 *  Branches on the boundary-assigned `.kind` discriminator first: when the
 *  classifier (`LLMError.fromSdkError`) tagged a definitive kind, that decides
 *  it without re-sniffing the message. Only when `.kind` is `"unknown"` (no
 *  structured signal was available — e.g. a bare `new LLMError(msg)`) do we
 *  fall back to the legacy message-marker scan, preserving prior behavior
 *  byte-for-byte for that path. */
export const isRetryable = (e) => {
    if (!(e instanceof LLMError))
        return false;
    if (RETRYABLE_KINDS.has(e.kind))
        return true;
    if (FATAL_KINDS.has(e.kind))
        return false;
    // e.kind === "unknown": no boundary classification — fall back to markers.
    const msg = e.message.toLowerCase();
    if (FATAL_MARKERS.some((m) => msg.includes(m)))
        return false;
    return RETRYABLE_MARKERS.some((m) => msg.includes(m));
};
/** True iff `e`'s message indicates the prompt exceeded the model's context
 *  window. Checked BEFORE {@link isRetryable} (PTL must drive compaction, and
 *  some providers phrase it with a 400 that would otherwise read as fatal).
 *
 *  NOTE: this one stays message-based deliberately. The {@link LLMErrorKind}
 *  vocabulary has no `prompt_too_long` member — providers surface PTL as a
 *  400, which the boundary classifies as `bad_request` (indistinguishable from
 *  other client errors at the status level). The specific "context window"
 *  wording is the only available signal, so the marker scan is the correct
 *  (not legacy-fallback) mechanism here until a dedicated kind exists. */
export const isPromptTooLong = (e) => {
    if (!(e instanceof LLMError))
        return false;
    const msg = e.message.toLowerCase();
    return PTL_MARKERS.some((m) => msg.includes(m));
};
/** Single classification entry point for the in-loop recovery state machine.
 *  PTL takes precedence over retry/fatal so an oversized prompt always routes
 *  to reactive compaction instead of being retried (or wrongly declared fatal). */
export const classifyLLMError = (e) => {
    if (isPromptTooLong(e))
        return "prompt_too_long";
    if (isRetryable(e))
        return "retryable";
    return "fatal";
};
/** Full-jitter exponential backoff for retry attempt `n` (0-based). Exported
 *  so the in-loop turn-retry path uses byte-identical math to {@link
 *  RetryingLLM}. `random` defaults to `Math.random`; inject for tests. */
export const backoffDelayMs = (n, baseDelayMs = DEFAULT_BASE_DELAY_MS, random = Math.random) => {
    const exp = Math.min(MAX_DELAY_MS, baseDelayMs * 2 ** n);
    return Math.floor(random() * exp);
};
const throwIfAborted = (signal) => {
    if (signal?.aborted)
        throw new LLMError("aborted");
};
export class RetryingLLM {
    /** Forward the wrapped provider's configured model id so a decorated chain
     *  (the CLI always wraps the adapter in RetryingLLM) still reports a
     *  faithful model for the pre-stream `llm_request` (RFC-0002 §5.2/§9)
     *  instead of degrading to `"unknown"`. Set conditionally (never an explicit
     *  `undefined`) to satisfy `exactOptionalPropertyTypes`, mirroring
     *  `FallbackLLM`. */
    model;
    inner;
    maxRetries;
    baseDelayMs;
    signal;
    sleep;
    random;
    constructor(opts) {
        this.inner = opts.inner;
        const innerModel = opts.inner.model;
        if (innerModel !== undefined)
            this.model = innerModel;
        this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
        this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
        this.signal = opts.signal;
        this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
        this.random = opts.random ?? Math.random;
    }
    /** Full-jitter exponential backoff for retry attempt `n` (0-based). */
    backoffFor(n) {
        return backoffDelayMs(n, this.baseDelayMs, this.random);
    }
    async *stream(input) {
        for (let attempt = 0;; attempt++) {
            throwIfAborted(this.signal);
            let yielded = false;
            try {
                for await (const ev of this.inner.stream(input)) {
                    yielded = true;
                    yield ev;
                }
                return;
            }
            catch (e) {
                // Mid-stream failure: rethrow — retrying would duplicate output.
                if (yielded)
                    throw e;
                if (attempt >= this.maxRetries || !isRetryable(e))
                    throw e;
                throwIfAborted(this.signal);
                await this.sleep(this.backoffFor(attempt));
                throwIfAborted(this.signal);
            }
        }
    }
}
