/**
 * BudgetMeter — pure state-machine unit tests.
 *
 * Every TickKind increments its counter. checkExhausted is propositional
 * (`dial !== undefined && observed > dial`). snapshot is stable across calls.
 */
import { describe, expect, test } from "bun:test";
import { BudgetMeter } from "@/agent";
describe("BudgetMeter.tick", () => {
    const ALL_KINDS = [
        "turn",
        "model_call",
        "tool_call",
        "shell_command",
        "test_run",
        "input_tokens",
        "output_tokens",
        "reasoning_tokens",
        "files_changed",
        "patch_bytes",
        "retry",
        "consecutive_failure",
    ];
    // Lookup map TickKind → BudgetUsage counter key (kept as data so the test
    // body stays linear / low-complexity).
    const KIND_TO_KEY = {
        turn: "turns",
        model_call: "modelCalls",
        tool_call: "toolCalls",
        shell_command: "shellCommands",
        test_run: "testRuns",
        input_tokens: "inputTokens",
        output_tokens: "outputTokens",
        reasoning_tokens: "reasoningTokens",
        files_changed: "filesChanged",
        patch_bytes: "patchBytes",
        retry: "retries",
        consecutive_failure: "consecutiveFailures",
    };
    test("every kind increments its corresponding counter", () => {
        for (const kind of ALL_KINDS) {
            const meter = new BudgetMeter();
            meter.tick(kind, 3);
            const snap = meter.snapshot();
            expect(snap[KIND_TO_KEY[kind]]).toBe(3);
        }
    });
    test("default delta is 1", () => {
        const m = new BudgetMeter();
        m.tick("turn");
        m.tick("turn");
        expect(m.snapshot().turns).toBe(2);
    });
    test("multiple ticks accumulate", () => {
        const m = new BudgetMeter();
        m.tick("tool_call", 2);
        m.tick("tool_call", 3);
        m.tick("tool_call");
        expect(m.snapshot().toolCalls).toBe(6);
    });
    test("ticks for different kinds are independent", () => {
        const m = new BudgetMeter();
        m.tick("turn", 1);
        m.tick("tool_call", 5);
        const s = m.snapshot();
        expect(s.turns).toBe(1);
        expect(s.toolCalls).toBe(5);
        expect(s.modelCalls).toBe(0);
    });
    test("recordSuccess resets consecutive_failure only", () => {
        const m = new BudgetMeter();
        m.tick("consecutive_failure", 3);
        m.tick("retry", 2);
        m.recordSuccess();
        const s = m.snapshot();
        expect(s.consecutiveFailures).toBe(0);
        expect(s.retries).toBe(2); // unchanged
    });
    test("unknown kind throws (defense)", () => {
        const m = new BudgetMeter();
        expect(() => m.tick("bogus")).toThrow(/unknown kind/);
    });
});
describe("BudgetMeter.snapshot", () => {
    test("returns a fresh object every call (stable)", () => {
        const m = new BudgetMeter();
        m.tick("turn", 2);
        const a = m.snapshot();
        const b = m.snapshot();
        expect(a).not.toBe(b);
        expect(a).toEqual(b);
    });
    test("wallClockMs is monotonically non-decreasing with injected clock", () => {
        let t = 100;
        const m = new BudgetMeter({ now: () => t });
        const a = m.snapshot().wallClockMs;
        t = 250;
        const b = m.snapshot().wallClockMs;
        expect(b).toBeGreaterThanOrEqual(a);
        expect(b - a).toBe(150);
    });
    test("costUsd uses caller-supplied estimator (no implicit pricing)", () => {
        const m = new BudgetMeter({
            estimateCostUsd: ({ inputTokens, outputTokens }) => inputTokens * 0.001 + outputTokens * 0.002,
        });
        m.tick("input_tokens", 1000);
        m.tick("output_tokens", 500);
        expect(m.snapshot().costUsd).toBeCloseTo(2.0, 5);
    });
});
describe("BudgetMeter.checkExhausted", () => {
    test("no dials = never exhausted", () => {
        const m = new BudgetMeter();
        m.tick("turn", 1_000_000);
        expect(m.checkExhausted().exhausted).toBe(false);
    });
    test("turn dial fires when observed > maxTurns", () => {
        const m = new BudgetMeter({ dials: { maxTurns: 2 } });
        m.tick("turn", 3);
        const ex = m.checkExhausted();
        expect(ex.exhausted).toBe(true);
        expect(ex.kind).toBe("turn");
        expect(ex.budget).toBe(2);
        expect(ex.observed).toBe(3);
    });
    test("strict greater-than: observed === dial is NOT exhausted", () => {
        const m = new BudgetMeter({ dials: { maxTurns: 5 } });
        m.tick("turn", 5);
        expect(m.checkExhausted().exhausted).toBe(false);
    });
    test("tool_call dial fires when observed > maxToolCalls", () => {
        const m = new BudgetMeter({ dials: { maxToolCalls: 3 } });
        m.tick("tool_call", 4);
        const ex = m.checkExhausted();
        expect(ex.exhausted).toBe(true);
        expect(ex.kind).toBe("tool_call");
    });
    test("wall_clock_ms dial fires when injected clock crosses ceiling", () => {
        let t = 0;
        const m = new BudgetMeter({ dials: { maxWallClockMs: 100 }, now: () => t });
        t = 200;
        const ex = m.checkExhausted();
        expect(ex.exhausted).toBe(true);
        expect(ex.kind).toBe("wall_clock_ms");
    });
    test("total_tokens combines input + output + reasoning", () => {
        const m = new BudgetMeter({ dials: { maxTotalTokens: 100 } });
        m.tick("input_tokens", 40);
        m.tick("output_tokens", 40);
        m.tick("reasoning_tokens", 30);
        const ex = m.checkExhausted();
        expect(ex.exhausted).toBe(true);
        expect(ex.kind).toBe("total_tokens");
    });
    test("cost_usd dial fires when estimator output exceeds cap", () => {
        const m = new BudgetMeter({
            dials: { maxCostUsd: 1 },
            estimateCostUsd: () => 2.5,
        });
        const ex = m.checkExhausted();
        expect(ex.exhausted).toBe(true);
        expect(ex.kind).toBe("cost_usd");
    });
    test("per-counter dial fires before total_tokens (deterministic order)", () => {
        const m = new BudgetMeter({ dials: { maxInputTokens: 10, maxTotalTokens: 100 } });
        m.tick("input_tokens", 50);
        const ex = m.checkExhausted();
        expect(ex.exhausted).toBe(true);
        expect(ex.kind).toBe("input_tokens");
    });
    test("consecutive_failure dial fires; recordSuccess clears it", () => {
        const m = new BudgetMeter({ dials: { maxConsecutiveFailures: 2 } });
        m.tick("consecutive_failure", 3);
        expect(m.checkExhausted().exhausted).toBe(true);
        m.recordSuccess();
        expect(m.checkExhausted().exhausted).toBe(false);
    });
});
describe("BudgetMeter constructor defaults", () => {
    test("default exhaustion policy is 'stop'", () => {
        const m = new BudgetMeter();
        expect(m.exhaustion).toBe("stop");
    });
    test("dials and caps default to empty objects", () => {
        const m = new BudgetMeter();
        expect(m.dials).toEqual({});
        expect(m.caps).toEqual({});
    });
    test("exhaustion policy passes through", () => {
        const m = new BudgetMeter({ exhaustion: "ask-user" });
        expect(m.exhaustion).toBe("ask-user");
    });
});
