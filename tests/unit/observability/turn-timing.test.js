/**
 * ADR-0077 — `createTurnTimingCapture` unit contract.
 *
 * Pins:
 *   - `markFirstToken` idempotency (only the FIRST call records);
 *   - `firstTokenAt === null` when `markFirstToken` is never called;
 *   - latency arithmetic under an injected deterministic clock;
 *   - frozen snapshot (mutations after `snapshot()` are not retroactive).
 */
import { describe, expect, test } from "bun:test";
import { createTurnTimingCapture } from "@/observability";
/** Deterministic monotone clock — returns successive values from `seq`. */
const seqClock = (seq) => {
    let i = 0;
    return () => {
        const v = seq[i] ?? seq[seq.length - 1];
        if (i < seq.length - 1)
            i++;
        return v ?? 0;
    };
};
describe("createTurnTimingCapture — mark/snapshot contract", () => {
    test("snapshot after full mark sequence — arithmetic matches injected clock", () => {
        const cap = createTurnTimingCapture(seqClock([100, 150, 250]));
        cap.markRequestSent(); // 100
        cap.markFirstToken(); // 150
        cap.markStreamEnd(); // 250
        const snap = cap.snapshot();
        expect(snap.requestSentAt).toBe(100);
        expect(snap.firstTokenAt).toBe(150);
        expect(snap.firstTokenLatencyMs).toBe(50);
        expect(snap.streamEndAt).toBe(250);
        expect(snap.totalDurationMs).toBe(150);
    });
    test("markFirstToken idempotent — only the FIRST call records the timestamp", () => {
        // The idempotent early-return SKIPS the clock call entirely, so consumed
        // clock ticks are: requestSent (0), firstToken[1st] (10), streamEnd (20).
        const cap = createTurnTimingCapture(seqClock([0, 10, 20]));
        cap.markRequestSent(); // 0
        cap.markFirstToken(); // 10 (records)
        cap.markFirstToken(); // no-op, no clock call
        cap.markFirstToken(); // no-op, no clock call
        cap.markStreamEnd(); // 20
        const snap = cap.snapshot();
        expect(snap.firstTokenAt).toBe(10);
        expect(snap.firstTokenLatencyMs).toBe(10);
        expect(snap.streamEndAt).toBe(20);
    });
    test("firstTokenAt === null when markFirstToken is never called", () => {
        const cap = createTurnTimingCapture(seqClock([1000, 1500]));
        cap.markRequestSent(); // 1000
        cap.markStreamEnd(); // 1500
        const snap = cap.snapshot();
        expect(snap.firstTokenAt).toBeNull();
        expect(snap.firstTokenLatencyMs).toBeNull();
        expect(snap.totalDurationMs).toBe(500);
    });
    test("snapshot is frozen — caller cannot retroactively mutate fields", () => {
        const cap = createTurnTimingCapture(seqClock([5, 10, 15]));
        cap.markRequestSent();
        cap.markFirstToken();
        cap.markStreamEnd();
        const snap = cap.snapshot();
        expect(Object.isFrozen(snap)).toBe(true);
        // Object.freeze blocks writes silently in non-strict, throws in strict — the
        // contract is "snapshot is not mutable from outside"; assert frozen flag.
    });
    test("default clock is Date.now (sanity — produces a positive number)", () => {
        const cap = createTurnTimingCapture();
        cap.markRequestSent();
        cap.markFirstToken();
        cap.markStreamEnd();
        const snap = cap.snapshot();
        expect(snap.requestSentAt).toBeGreaterThan(0);
        expect(snap.firstTokenAt ?? 0).toBeGreaterThanOrEqual(snap.requestSentAt);
        expect(snap.streamEndAt).toBeGreaterThanOrEqual(snap.firstTokenAt ?? 0);
    });
});
