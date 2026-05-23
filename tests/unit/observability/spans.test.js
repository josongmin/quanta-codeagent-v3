/**
 * Unit tests for the lightweight span emission seam (Codex 10-step OTel tree —
 * core 4 stages absorption, ADR-0068).
 *
 * Scope:
 *   1. No-op default: with no sink registered, `startSpan`/`endSpan` are zero-
 *      side-effect — the loop's byte-identical contract.
 *   2. Sink wiring: a registered sink receives `onStart` / `onEnd` calls in
 *      order, with the correct name + attrs + duration + status.
 *   3. Defense in depth: a throwing sink does NOT propagate exceptions into
 *      the caller (observability bugs must not crash the agent loop).
 *   4. Vocabulary: span names match the documented Codex literals
 *      (`session_loop`, `session_task.turn`, `run_sampling_request`,
 *      `handle_tool_call`).
 *
 * These tests intentionally exercise the spans module in isolation — the
 * loop-level smoke test (that the wrapper actually opens/closes the 4 spans
 * during a real `runAgent`) lives in `tests/integration/spans-e2e.test.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { attrs } from "@/observability/attrs";
import { __resetSpanSink, endSpan, getSpanSink, SPAN_NAMES, setSpanSink, startSpan, } from "@/observability/spans";
import { QUANTA_ATTRS } from "@/observability/vocabulary";
/** Test sink: records every event in order so tests can assert sequencing
 *  + attrs + status. `onStart` returns a unique token so `onEnd` can
 *  correlate. */
const makeRecordingSink = () => {
    const events = [];
    const tokens = [];
    const sink = {
        onStart: (name, a) => {
            events.push({ kind: "start", name, attrs: a });
            const token = Symbol(`span-${tokens.length}`);
            tokens.push(token);
            return token;
        },
        onEnd: (token, name, status, durationMs, a) => {
            // Capture so callers can verify the token actually round-trips.
            tokens.push(token);
            events.push({ kind: "end", name, status, durationMs, attrs: a });
        },
    };
    return { sink, events, tokens };
};
afterEach(() => {
    // Always clear so a leaked sink doesn't bleed across tests.
    __resetSpanSink();
});
// ---------------------------------------------------------------------------
// No-op default
// ---------------------------------------------------------------------------
describe("spans — no-op default", () => {
    test("getSpanSink() returns null when nothing is registered", () => {
        expect(getSpanSink()).toBeNull();
    });
    test("startSpan + endSpan are silent with no sink", () => {
        const span = startSpan(SPAN_NAMES.sessionLoop, attrs({}));
        expect(span.token).toBeNull();
        // No throw, no side effect — the sentinel handles both ends.
        endSpan(span, "ok", attrs({}));
    });
    test("the no-sink Span is the SAME object reference across calls (zero allocation)", () => {
        const a = startSpan(SPAN_NAMES.sessionLoop, attrs({}));
        const b = startSpan(SPAN_NAMES.turn, attrs({}));
        const c = startSpan(SPAN_NAMES.handleToolCall, attrs({}));
        // Identity equality — the module-level NOOP_SPAN sentinel is reused so
        // hot-path callers do not allocate per span open.
        expect(a).toBe(b);
        expect(b).toBe(c);
    });
});
// ---------------------------------------------------------------------------
// Sink wiring
// ---------------------------------------------------------------------------
describe("spans — sink wiring", () => {
    test("onStart receives the span name + attrs and returns an opaque token", () => {
        const { sink, events, tokens } = makeRecordingSink();
        setSpanSink(sink);
        const span = startSpan(SPAN_NAMES.sessionLoop, attrs({ [QUANTA_ATTRS.conversation.id]: "sess-1" }));
        expect(events).toHaveLength(1);
        const ev = events[0];
        expect(ev?.kind).toBe("start");
        if (ev?.kind === "start") {
            expect(ev.name).toBe(SPAN_NAMES.sessionLoop);
            expect(ev.attrs[QUANTA_ATTRS.conversation.id]).toBe("sess-1");
        }
        // The span carries the sink-issued token (a Symbol in the fixture).
        expect(span.token).toBe(tokens[0]);
    });
    test("endSpan delivers status + durationMs + attrs back to the sink", async () => {
        const { sink, events } = makeRecordingSink();
        setSpanSink(sink);
        const span = startSpan(SPAN_NAMES.turn, attrs({ [QUANTA_ATTRS.turn.id]: "turn-7" }));
        // Sleep ~5 ms so durationMs is non-zero (the sink rounds to an integer).
        await new Promise((resolve) => setTimeout(resolve, 5));
        endSpan(span, "ok", attrs({ [QUANTA_ATTRS.turn.kind]: "main" }));
        expect(events).toHaveLength(2);
        const endEv = events[1];
        if (endEv?.kind === "end") {
            expect(endEv.name).toBe(SPAN_NAMES.turn);
            expect(endEv.status).toBe("ok");
            // durationMs must be ≥0 + a non-negative integer (rounded by endSpan).
            expect(endEv.durationMs).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(endEv.durationMs)).toBe(true);
            expect(endEv.attrs[QUANTA_ATTRS.turn.kind]).toBe("main");
        }
    });
    test("status:'error' / status:'aborted' round-trip through the sink", () => {
        const { sink, events } = makeRecordingSink();
        setSpanSink(sink);
        const sErr = startSpan(SPAN_NAMES.runSamplingRequest, attrs({}));
        endSpan(sErr, "error", attrs({}));
        const sAbt = startSpan(SPAN_NAMES.runSamplingRequest, attrs({}));
        endSpan(sAbt, "aborted", attrs({}));
        const ends = events.filter((e) => e.kind === "end");
        expect(ends.map((e) => e.status)).toEqual(["error", "aborted"]);
    });
    test("setSpanSink(null) restores the no-op default mid-run", () => {
        const { sink, events } = makeRecordingSink();
        setSpanSink(sink);
        const a = startSpan(SPAN_NAMES.sessionLoop, attrs({}));
        endSpan(a, "ok", attrs({}));
        expect(events).toHaveLength(2);
        setSpanSink(null);
        const b = startSpan(SPAN_NAMES.turn, attrs({}));
        endSpan(b, "ok", attrs({}));
        // No new events captured after the sink was cleared.
        expect(events).toHaveLength(2);
        // And the silent span returns the sentinel (null token).
        expect(b.token).toBeNull();
    });
});
// ---------------------------------------------------------------------------
// Defense in depth — sink failures must not crash the caller
// ---------------------------------------------------------------------------
describe("spans — defense in depth", () => {
    test("a throwing onStart does not propagate; matching endSpan stays a no-op", () => {
        const throwingSink = {
            onStart: () => {
                throw new Error("sink onStart blew up");
            },
            onEnd: () => {
                throw new Error("sink onEnd should never be called");
            },
        };
        setSpanSink(throwingSink);
        // startSpan must NOT throw — and must return the no-op sentinel.
        const span = startSpan(SPAN_NAMES.sessionLoop, attrs({}));
        expect(span.token).toBeNull();
        // The matching endSpan must also NOT throw — it short-circuits on the
        // sentinel without ever reaching the would-throw onEnd.
        endSpan(span, "ok", attrs({}));
    });
    test("a throwing onEnd does not propagate to the caller", () => {
        let started = 0;
        const throwingEndSink = {
            onStart: () => {
                started += 1;
                return { token: started };
            },
            onEnd: () => {
                throw new Error("sink onEnd blew up");
            },
        };
        setSpanSink(throwingEndSink);
        const span = startSpan(SPAN_NAMES.turn, attrs({}));
        expect(started).toBe(1);
        // The onEnd throw is swallowed — endSpan returns normally.
        endSpan(span, "ok", attrs({}));
    });
});
// ---------------------------------------------------------------------------
// Vocabulary — span names match Codex's documented literals
// ---------------------------------------------------------------------------
describe("spans — Codex literal name parity", () => {
    test("SPAN_NAMES carries the four Codex literals verbatim", () => {
        expect(SPAN_NAMES.sessionLoop).toBe("session_loop");
        expect(SPAN_NAMES.turn).toBe("session_task.turn");
        expect(SPAN_NAMES.runSamplingRequest).toBe("run_sampling_request");
        expect(SPAN_NAMES.handleToolCall).toBe("handle_tool_call");
    });
    test("SpanName union has exactly 4 members", () => {
        const all = [
            SPAN_NAMES.sessionLoop,
            SPAN_NAMES.turn,
            SPAN_NAMES.runSamplingRequest,
            SPAN_NAMES.handleToolCall,
        ];
        expect(new Set(all).size).toBe(4);
    });
});
