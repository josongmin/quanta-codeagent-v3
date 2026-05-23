/**
 * Provider streaming event decoders — SSE + WebSocket.
 *
 * Wire-level decoders for streaming envelopes emerging from OpenAI Responses API
 * v2 (HTTP `text/event-stream` + `wss://chatgpt.com/backend-api/codex/responses`).
 * This module is deliberately small and decoupled from the Anthropic SDK path:
 * it parses bytes/strings off the wire into a single uniform discriminated
 * `DecodedProviderEvent` shape that higher layers (adapters, dispatcher) can
 * route into the {@link StreamEvent} union.
 *
 * ## Why this lives in v3 from day one — ADR-0048
 *
 * Round-4 forensics of Codex Desktop build 2867 confirmed 12 documented WS event
 * `kind` values; Codex itself **silently drops `response.in_progress`** (forward
 * compat gap). v3 absorbs the gap up front: every documented event MAY be
 * decoded; unknown events return `null` plus a rate-limited debug log so the
 * caller never throws or blocks the stream. The `response.in_progress` variant
 * is wired through so the dispatcher can surface a "thinking..." indicator to
 * UIs without losing semantic information.
 *
 * ## Parser contract
 *
 * - **Pure & total**: every entry point returns `null` on malformed input. None
 *   of `parseSseFrame` / `decodeSseEvent` / `decodeWsEvent` ever throws.
 * - **SSE spec compliance (§9.2)**: multiple `data:` lines on one frame are
 *   concatenated with `"\n"`; CRLF and LF line endings both accepted; BOM
 *   stripped on the first frame; empty data field collapses to "".
 * - **WS shape**: a single JSON object per message, top-level `kind: string`.
 *   BOM-prefixed JSON is stripped before parse.
 * - **Forward compat (Codex gap)**: unknown `kind` values do NOT throw — they
 *   surface as a `decoded.kind === "unknown"` value the caller can drop with a
 *   rate-limited debug log. {@link logUnknownEventRateLimited} ships the
 *   rate-limiter so a runaway event flood never spams the log.
 */
import { logger } from "@/shared/logger";
/** The set of known WS `kind` strings (12 entries — Codex round-4 inventory). */
export const KNOWN_EVENT_KINDS = new Set([
    "response.created",
    "response.in_progress",
    "response.completed",
    "response.output_item.added",
    "response.output_item.done",
    "response.content_part.added",
    "response.content_part.done",
    "response.output_text.delta",
    "response.output_text.done",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.custom_tool_call_input.delta",
]);
// ---------------------------------------------------------------------------
// SSE — frame parser
/** Strip a single UTF-8 BOM (U+FEFF) from the start of a string, if present. */
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
/**
 * Parse one fully-terminated SSE frame (text between two blank lines, or up to
 * EOF). The block must NOT contain the blank-line separator itself — callers
 * are responsible for splitting on `/\r?\n\r?\n/` first (see
 * {@link splitSseFrames}).
 *
 * Returns `null` if no `data:` line was present (the spec allows comment-only
 * or pure-event-name frames, but our pipeline has nothing to do with them).
 *
 * Per WHATWG HTML §9.2 "Server-sent events" parsing rules:
 *   - lines split on LF, CR, or CRLF (we normalize CRLF → LF first);
 *   - leading colon → comment, skipped;
 *   - `field` + colon + value pairs; value's leading space stripped exactly
 *     once;
 *   - multiple `data:` lines concatenated with `"\n"`;
 *   - `event:` overrides the default event name (empty string).
 */
/** Parse one already-trimmed, non-comment SSE line into a `(field, value)`
 *  pair per WHATWG HTML §9.2: strip a single leading space from the value
 *  after the colon. A line with no colon is a field with empty value. */
const parseSseLine = (line) => {
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 0x20 /* ' ' */)
        value = value.slice(1);
    return { field, value };
};
/** Apply one parsed SSE field to the frame accumulator. `id` and `retry` are
 *  spec-defined but irrelevant to our pipeline and dropped on the floor. */
const applyField = (acc, field, value) => {
    if (field === "event")
        acc.name = value;
    else if (field === "data") {
        acc.dataParts.push(value);
        acc.sawData = true;
    }
};
export const parseSseFrame = (block) => {
    if (block.length === 0)
        return null;
    const normalized = stripBom(block).replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n");
    const acc = { name: "", dataParts: [], sawData: false };
    for (const line of lines) {
        if (line.length === 0)
            continue;
        if (line.charCodeAt(0) === 0x3a /* ':' */)
            continue; // comment
        const { field, value } = parseSseLine(line);
        applyField(acc, field, value);
    }
    if (!acc.sawData)
        return null;
    return { name: acc.name, data: acc.dataParts.join("\n") };
};
/**
 * Split a buffer into a list of complete SSE frames plus a remainder.
 *
 * Frames are delimited by a blank line (LF/CRLF/mix). The returned `remainder`
 * is the trailing bytes that have NOT yet been terminated by a blank line — it
 * MUST be prepended to the next chunk before calling {@link splitSseFrames}
 * again. This is what lets the parser survive fragmented transport reads
 * (chunked HTTP, small TCP windows, etc.).
 */
export const splitSseFrames = (buf) => {
    // Partial-read hazard: a chunk that ends on a lone `\r` may be the first half
    // of a `\r\n` line terminator split across the transport boundary. If we
    // normalized that trailing `\r` to `\n` here and the NEXT chunk began with
    // `\n` (the back half of the CRLF), prepending the remainder would synthesize
    // a spurious `\n\n` and split ONE logical event into two. Defer a trailing
    // lone `\r` into the remainder untouched so the CRLF re-forms on the next
    // call. (A `\r` that is genuinely the last byte of the stream stays in the
    // remainder and is simply never emitted — same as any unterminated frame.)
    let head = buf;
    let carry = "";
    if (head.charCodeAt(head.length - 1) === 0x0d /* '\r' */) {
        head = head.slice(0, -1);
        carry = "\r";
    }
    const normalized = head.replace(/\r\n?/g, "\n");
    const parts = normalized.split(/\n\n/);
    const remainder = (parts.pop() ?? "") + carry;
    const frames = [];
    for (const block of parts) {
        const parsed = parseSseFrame(block);
        if (parsed !== null)
            frames.push(parsed);
    }
    return { frames, remainder };
};
/**
 * Decode a parsed SSE frame into a {@link DecodedProviderEvent}.
 *
 * Returns `null` when:
 *   - the data payload is empty (e.g. `data:\n\n` keep-alive);
 *   - JSON parse fails (logged at debug, NOT thrown — the wire owner is the
 *     remote, not us; we tolerate junk).
 *
 * The SSE `event:` name is treated as a hint only; the authoritative `kind` is
 * taken from the JSON body (matches Codex's own dispatcher which keys on
 * `payload.type`). When the JSON body lacks a string `type`/`kind`, we fall
 * back to the SSE `event:` name; if both are missing the event surfaces as
 * `kind: "unknown"`.
 */
export const decodeSseEvent = (frame) => {
    if (frame.data.length === 0)
        return null;
    if (frame.data === "[DONE]")
        return null; // OpenAI sentinel — caller handles EOF separately.
    const parsed = safeJsonParse(frame.data);
    if (parsed === null) {
        logger.debug("streaming-events: SSE JSON parse failed", {
            preview: frame.data.slice(0, 80),
        });
        return null;
    }
    return liftKind(parsed, frame.name);
};
// ---------------------------------------------------------------------------
// WebSocket — single-message decoder
/**
 * Decode one WebSocket text message into a {@link DecodedProviderEvent}.
 *
 * Per Codex round-4 forensics the WS frames are JSON objects with a top-level
 * `kind: string`. We are lenient on:
 *   - leading BOM (some servers / proxies inject one);
 *   - leading whitespace;
 *   - missing `kind` (treated as `unknown` with raw text preview in debug).
 *
 * Returns `null` on hard parse failure (so the caller can no-op without
 * branching on exceptions).
 */
export const decodeWsEvent = (raw) => {
    if (raw.length === 0)
        return null;
    const trimmed = stripBom(raw).trimStart();
    if (trimmed.length === 0)
        return null;
    const parsed = safeJsonParse(trimmed);
    if (parsed === null) {
        logger.debug("streaming-events: WS JSON parse failed", {
            preview: raw.slice(0, 80),
        });
        return null;
    }
    return liftKind(parsed, "");
};
/** Token-bucket-ish: emit at most `LIMIT` log lines per `WINDOW_MS`. When the
 *  bucket overflows we count drops and flush a summary on the next window. */
const LIMIT = 10;
const WINDOW_MS = 60_000;
const state = {
    windowStart: 0,
    windowCount: 0,
    totalDropped: 0,
};
/** Reset the rate-limiter window. Test-only — exported because rate-limited
 *  diagnostics should never leak across test cases. */
export const __resetUnknownEventRateLimitForTests = () => {
    state.windowStart = 0;
    state.windowCount = 0;
    state.totalDropped = 0;
};
/**
 * Log an unknown event at debug level, rate-limited so a flood of unknown
 * events from a misbehaving server does NOT churn the log.
 *
 * Cap: `LIMIT` lines / `WINDOW_MS`. Overflow within a window is counted and
 * summarized at the start of the next window (single `"+N dropped"` line).
 *
 * Returns whether a log line was actually emitted — useful for tests that
 * assert the rate-limit holds without depending on the logger's threshold
 * (which is `info` by default in `runtime-config.ts`, so debug writes drop
 * silently to stderr-tap-counters).
 *
 * @param ev   the decoded `unknown` event being dropped
 * @param now  injectable clock for deterministic tests (defaults to `Date.now`)
 * @returns    `true` if the call resulted in a log emission, `false` if it
 *             was suppressed by the rate-limit window
 */
export const logUnknownEventRateLimited = (ev, now = Date.now) => {
    const t = now();
    if (t - state.windowStart > WINDOW_MS) {
        if (state.totalDropped > 0) {
            logger.debug("streaming-events: unknown-event window summary", {
                droppedInPrevWindow: state.totalDropped,
            });
        }
        state.windowStart = t;
        state.windowCount = 0;
        state.totalDropped = 0;
    }
    if (state.windowCount >= LIMIT) {
        state.totalDropped += 1;
        return false;
    }
    state.windowCount += 1;
    logger.debug("streaming-events: unknown provider event dropped", {
        rawKind: ev.rawKind,
    });
    return true;
};
// ---------------------------------------------------------------------------
// Internal helpers
/** `JSON.parse` that returns null on any failure, never throws. */
const safeJsonParse = (s) => {
    try {
        return JSON.parse(s);
    }
    catch {
        return null;
    }
};
/** Coerce a parsed JSON value into the discriminated `DecodedProviderEvent`
 *  union. `sseEventName` is the optional SSE `event:` field used as a fallback
 *  when the payload itself lacks a `kind`/`type`. */
const liftKind = (raw, sseEventName) => {
    if (raw === null || typeof raw !== "object")
        return null;
    const obj = raw;
    const fromBody = typeof obj.type === "string" ? obj.type : typeof obj.kind === "string" ? obj.kind : "";
    const kind = fromBody.length > 0 ? fromBody : sseEventName;
    if (kind.length === 0) {
        return { kind: "unknown", rawKind: "", data: obj };
    }
    if (KNOWN_EVENT_KINDS.has(kind)) {
        // Type assertion is safe: we just checked `kind` is in the known set; the
        // resulting object's `data` payload remains a `Record<string, unknown>`.
        return { kind, data: obj };
    }
    return { kind: "unknown", rawKind: kind, data: obj };
};
