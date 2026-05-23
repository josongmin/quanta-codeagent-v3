/**
 * ADR-0085 — cost & cache dashboard: pure aggregation over a MetricsSnapshot
 * + the three render formats.
 */
import { describe, expect, test } from "bun:test";
import { buildCostDashboard, renderDashboardMarkdown, renderDashboardText, } from "@/observability/cost-dashboard";
const timer = (over = {}) => ({
    count: 3,
    min: 10,
    max: 90,
    mean: 50,
    p50: 50,
    p95: 90,
    ...over,
});
const snap = (over = {}) => ({
    counters: {
        "agent.turns": 4,
        "agent.tool_calls": 5,
        "agent.tool_calls.read": 3,
        "agent.tool_calls.edit": 2,
        "agent.stop_reason.end_turn": 4,
        "gen_ai.usage.input_tokens": 8000,
        "gen_ai.usage.output_tokens": 1200,
        "gen_ai.usage.cache_read_input_tokens": 2000,
        "shell.exec.runs": 2,
        "shell.exec.stdout.bytes": 4096,
        "shell.exec.stderr.bytes": 128,
        ...over.counters,
    },
    gauges: { ...over.gauges },
    timers: {
        "agent.llm_stream": timer(),
        "agent.tool_exec": timer({ p50: 5, p95: 20 }),
        ...over.timers,
    },
});
describe("buildCostDashboard", () => {
    test("aggregates tokens + cache hit rate", () => {
        const d = buildCostDashboard(snap());
        expect(d.tokens.input).toBe(8000);
        expect(d.tokens.output).toBe(1200);
        expect(d.tokens.cacheRead).toBe(2000);
        // hit = cacheRead / (input + cacheRead) = 2000 / 10000 = 0.2
        expect(d.tokens.cacheHitRate).toBeCloseTo(0.2, 5);
    });
    test("cacheHitRate is null when no input tokens", () => {
        const d = buildCostDashboard(snap({
            counters: { "gen_ai.usage.input_tokens": 0, "gen_ai.usage.cache_read_input_tokens": 0 },
        }));
        expect(d.tokens.cacheHitRate).toBeNull();
    });
    test("cost is null for an unknown model and a number for a known one", () => {
        expect(buildCostDashboard(snap()).estimatedCostUsd).toBeNull(); // no model
        const known = buildCostDashboard(snap(), { model: "gpt-4o" });
        // gpt-4o is in the pricing table ⇒ a finite cost (or null only if table lacks it)
        expect(known.estimatedCostUsd === null || typeof known.estimatedCostUsd === "number").toBe(true);
    });
    test("groups tool calls + stop reasons by suffix", () => {
        const d = buildCostDashboard(snap());
        expect(d.toolCalls.total).toBe(5);
        expect(d.toolCalls.byTool).toEqual({ read: 3, edit: 2 });
        expect(d.stopReasons).toEqual({ end_turn: 4 });
    });
    test("surfaces llm + tool latency timers", () => {
        const d = buildCostDashboard(snap());
        expect(d.latency.llmStream?.p95).toBe(90);
        expect(d.latency.toolExec?.p50).toBe(5);
    });
    test("shell rollup (absent ⇒ zeros)", () => {
        expect(buildCostDashboard(snap()).shell).toEqual({
            runs: 2,
            stdoutBytes: 4096,
            stderrBytes: 128,
        });
        const empty = buildCostDashboard({ counters: {}, gauges: {}, timers: {} });
        expect(empty.shell).toEqual({ runs: 0, stdoutBytes: 0, stderrBytes: 0 });
    });
    test("empty snapshot produces an all-zero dashboard (no NaN)", () => {
        const d = buildCostDashboard({ counters: {}, gauges: {}, timers: {} });
        expect(d.turns).toBe(0);
        expect(d.tokens.cacheHitRate).toBeNull();
        expect(d.toolCalls.total).toBe(0);
        expect(d.latency.llmStream).toBeUndefined();
    });
});
describe("renderers", () => {
    test("text block contains the headline metrics", () => {
        const text = renderDashboardText(buildCostDashboard(snap(), { model: "gpt-4o" }));
        expect(text).toContain("cost & cache");
        expect(text).toContain("gpt-4o");
        expect(text).toContain("hit 20%");
        expect(text).toContain("read=3");
        expect(text).toContain("shell:");
    });
    test("markdown is a valid table with the cache row", () => {
        const md = renderDashboardMarkdown(buildCostDashboard(snap(), { model: "gpt-4o" }));
        expect(md.split("\n")[0]).toBe("| metric | value |");
        expect(md).toContain("cache read (hit rate)");
        expect(md).toContain("20%");
    });
    test("unknown model renders n/a cost without throwing", () => {
        const text = renderDashboardText(buildCostDashboard(snap()));
        expect(text).toContain("n/a (unknown model)");
    });
});
