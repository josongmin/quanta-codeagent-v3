/**
 * BudgetExhaustionPolicy — closed literal union, every value preserved by the
 * meter constructor; per-policy shape assertions for the trajectory event.
 */
import { describe, expect, test } from "bun:test";
import { BudgetMeter, isBudgetEvent, makeClampEvent, } from "@/agent";
describe("BudgetExhaustionPolicy literal union", () => {
    const ALL = [
        "ask-user",
        "stop",
        "stop-with-summary",
        "emit-partial",
        "fail-run",
    ];
    test("every policy value is accepted by the constructor", () => {
        for (const policy of ALL) {
            const m = new BudgetMeter({ exhaustion: policy });
            expect(m.exhaustion).toBe(policy);
        }
    });
    test("each policy produces a distinct value (no aliasing)", () => {
        expect(new Set(ALL).size).toBe(ALL.length);
    });
    test("default policy when omitted is 'stop'", () => {
        const m = new BudgetMeter();
        expect(m.exhaustion).toBe("stop");
    });
});
describe("budget events are a closed discriminated union", () => {
    test("makeClampEvent produces a properly tagged event", () => {
        const e = makeClampEvent("maxTurns", 1000, 100);
        expect(e.type).toBe("budget_clamp");
        expect(e.dial).toBe("maxTurns");
        expect(e.requested).toBe(1000);
        expect(e.cap).toBe(100);
    });
    test("isBudgetEvent narrows known events", () => {
        const clamp = makeClampEvent("maxTurns", 10, 5);
        expect(isBudgetEvent(clamp)).toBe(true);
        expect(isBudgetEvent({ type: "tool_call" })).toBe(false);
    });
    test("event union shape is exhaustive (compile-time + runtime spot)", () => {
        const tick = { type: "budget_tick", kind: "turn", delta: 1, observed: 1 };
        const exh = {
            type: "budget_exhausted",
            kind: "turn",
            budget: 2,
            observed: 3,
            usage: {
                turns: 3,
                modelCalls: 0,
                toolCalls: 0,
                shellCommands: 0,
                testRuns: 0,
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                filesChanged: 0,
                patchBytes: 0,
                retries: 0,
                consecutiveFailures: 0,
                wallClockMs: 0,
                costUsd: 0,
            },
        };
        const clamp = makeClampEvent("maxTurns", 10, 5);
        expect(tick.type).toBe("budget_tick");
        expect(exh.type).toBe("budget_exhausted");
        expect(clamp.type).toBe("budget_clamp");
    });
});
describe("exhaustion shape returned by checkExhausted", () => {
    test("includes kind/budget/observed when exhausted", () => {
        const m = new BudgetMeter({ dials: { maxTurns: 1 } });
        m.tick("turn", 5);
        const ex = m.checkExhausted();
        expect(ex.exhausted).toBe(true);
        expect(ex.kind).toBeDefined();
        expect(ex.budget).toBe(1);
        expect(ex.observed).toBe(5);
    });
    test("omits kind/budget/observed when not exhausted", () => {
        const m = new BudgetMeter({ dials: { maxTurns: 100 } });
        m.tick("turn", 1);
        const ex = m.checkExhausted();
        expect(ex.exhausted).toBe(false);
        expect(ex.kind).toBeUndefined();
        expect(ex.budget).toBeUndefined();
        expect(ex.observed).toBeUndefined();
    });
});
