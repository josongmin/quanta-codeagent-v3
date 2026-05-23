/**
 * clampDials tests — propositional clamping + surface log line on every clamp.
 *
 * The logger writes a `[budget-cap]` line to stderr; we capture stderr via
 * process.stderr.write monkey-patching for the duration of the test.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clampDials } from "@/agent";
const captureStderr = (fn) => {
    const original = process.stderr.write.bind(process.stderr);
    const lines = [];
    process.stderr.write = (chunk) => {
        lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
    };
    try {
        fn();
    }
    finally {
        process.stderr.write = original;
    }
    return { lines };
};
describe("clampDials — propositional clamping", () => {
    // Ensure logger output is enabled at warn threshold (default) by clearing
    // any test-suite-wide override; we don't import runtime-config here.
    const PRIOR_LOG_LEVEL = process.env.QUANTA_LOG_LEVEL;
    beforeEach(() => {
        process.env.QUANTA_LOG_LEVEL = "debug";
    });
    afterEach(() => {
        if (PRIOR_LOG_LEVEL === undefined)
            delete process.env.QUANTA_LOG_LEVEL;
        else
            process.env.QUANTA_LOG_LEVEL = PRIOR_LOG_LEVEL;
    });
    test("requested below cap passes through unchanged", () => {
        const out = clampDials({ maxTurns: 5 }, { maxTurns: 100 });
        expect(out.maxTurns).toBe(5);
    });
    test("requested equal to cap passes through (strict greater-than)", () => {
        const out = clampDials({ maxTurns: 100 }, { maxTurns: 100 });
        expect(out.maxTurns).toBe(100);
    });
    test("requested above cap clamps to cap", () => {
        const out = clampDials({ maxWallClockMs: 999_999_999 }, { maxWallClockMs: 1_800_000 });
        expect(out.maxWallClockMs).toBe(1_800_000);
    });
    test("absent request preserves cap (cap-as-default)", () => {
        const out = clampDials({}, { maxTurns: 50 });
        expect(out.maxTurns).toBe(50);
    });
    test("absent cap passes request through", () => {
        const out = clampDials({ maxTurns: 9999 }, {});
        expect(out.maxTurns).toBe(9999);
    });
    test("clamp emits a [budget-cap] log line on stderr", () => {
        const { lines } = captureStderr(() => {
            clampDials({ maxWallClockMs: 999_999_999 }, { maxWallClockMs: 1_800_000 });
        });
        const joined = lines.join("");
        expect(joined).toContain("[budget-cap]");
        expect(joined).toContain("maxWallClockMs");
    });
    test("no clamp = no log line", () => {
        const { lines } = captureStderr(() => {
            clampDials({ maxTurns: 5 }, { maxTurns: 100 });
        });
        const joined = lines.join("");
        expect(joined).not.toContain("[budget-cap]");
    });
    test("onClamp callback fires structured event for each clamp", () => {
        const events = [];
        clampDials({ maxWallClockMs: 999_999, maxTurns: 100, maxToolCalls: 5000 }, { maxWallClockMs: 1000, maxTurns: 50 }, (e) => events.push(e));
        // maxTurns 100>50 ⇒ clamp; maxWallClockMs 999_999>1000 ⇒ clamp; maxToolCalls has no cap.
        expect(events.length).toBe(2);
        const dials = events.map((e) => e.dial).sort();
        expect(dials).toEqual(["maxTurns", "maxWallClockMs"]);
    });
    test("returns a fresh object — inputs are not mutated", () => {
        const dials = { maxTurns: 10 };
        const out = clampDials(dials, { maxTurns: 5 });
        expect(out).not.toBe(dials);
        expect(dials.maxTurns).toBe(10); // unchanged
        expect(out.maxTurns).toBe(5);
    });
    test("clamps multiple fields independently", () => {
        const out = clampDials({ maxTurns: 1000, maxToolCalls: 50_000, maxCostUsd: 100 }, { maxTurns: 50, maxToolCalls: 100, maxCostUsd: 5 });
        expect(out.maxTurns).toBe(50);
        expect(out.maxToolCalls).toBe(100);
        expect(out.maxCostUsd).toBe(5);
    });
    test("NaN / non-finite / negative requested or cap is dropped (treated as absent)", () => {
        // A NaN/Inf/negative dial would otherwise poison the meter's comparisons
        // (NaN > dial === false silently disables a cap) or set a nonsensical
        // negative budget. The guard drops the invalid value rather than clamping.
        expect(clampDials({ maxTurns: Number.NaN }, { maxTurns: 100 }).maxTurns).toBe(100);
        expect(clampDials({ maxTurns: Number.POSITIVE_INFINITY }, { maxTurns: 100 }).maxTurns).toBe(100);
        expect(clampDials({ maxTurns: -5 }, { maxTurns: 100 }).maxTurns).toBe(100);
        // An invalid CAP is treated as absent ⇒ a valid request passes through.
        expect(clampDials({ maxTurns: 7 }, { maxTurns: Number.NaN }).maxTurns).toBe(7);
        expect(clampDials({ maxTurns: 7 }, { maxTurns: -1 }).maxTurns).toBe(7);
        // Both invalid ⇒ field is dropped entirely (undefined).
        expect(clampDials({ maxTurns: Number.NaN }, { maxTurns: Number.NaN }).maxTurns).toBeUndefined();
    });
    test("invalid request does NOT emit a [budget-cap] clamp log line", () => {
        const { lines } = captureStderr(() => {
            clampDials({ maxTurns: Number.NaN }, { maxTurns: 100 });
        });
        expect(lines.join("")).not.toContain("[budget-cap]");
    });
    test("valid positive inputs are unaffected by the finiteness guard", () => {
        const out = clampDials({ maxTurns: 30, maxCostUsd: 0 }, { maxTurns: 50, maxCostUsd: 5 });
        expect(out.maxTurns).toBe(30);
        // 0 is a valid non-negative budget and must pass through.
        expect(out.maxCostUsd).toBe(0);
    });
});
