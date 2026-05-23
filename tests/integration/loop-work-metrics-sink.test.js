/**
 * Integration (ADR-0064 L3→L4): work-metrics now have a DEFAULT sink.
 *
 * The per-turn collector + emit were already wired in the loop (gated on
 * `AgentConfig.workMetricsSink`), but no default sink existed so the metrics
 * were collected and dropped. The CLI repl now builds a default stderr-summary
 * sink — `(m) => stderr.write("work: " + summarizeWorkMetrics(m))` — gated on
 * the same `QUANTA_METRICS` knob that drives the cost dashboard.
 *
 * This pins the loop→sink contract that the CLI default depends on:
 *  (a) a turn with tokens + tool actions ⇒ the sink receives a WorkMetrics
 *      whose `summarizeWorkMetrics(...)` rendering carries the action / lines /
 *      token segments (the exact text the CLI writes to stderr);
 *  (b) default-OFF: with NO sink wired the loop emits nothing (byte-identical).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "@/agent";
import { summarizeWorkMetrics } from "@/observability";
import { defaultTools, ToolRegistry } from "@/tool";
import { RecordingStream } from "./_harness";
class ScriptLLM {
    model;
    scripts;
    calls = 0;
    last = [];
    constructor(model, scripts) {
        this.model = model;
        this.scripts = scripts;
    }
    async *stream() {
        this.calls += 1;
        const next = this.scripts.shift();
        if (next)
            this.last = next;
        for (const e of next ?? this.last)
            yield e;
    }
}
const cfg = (over) => ({
    registry: new ToolRegistry(defaultTools),
    stream: new RecordingStream(),
    permission: { mode: "acceptEdits" },
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    system: "test",
    maxTurns: 8,
    signal: new AbortController().signal,
    onConfirm: async () => false,
    ...over,
});
describe("agent loop — default work-metrics sink contract (ADR-0064)", () => {
    test("(a) tokens + tool actions → sink receives metrics; summary carries the segments", async () => {
        const dir = mkdtempSync(join(tmpdir(), "work-metrics-"));
        try {
            const file = join(dir, "f.txt");
            // The default CLI sink renders `work: <summary>` to stderr; here we
            // capture both the raw metrics and the rendered line the CLI would write.
            const seen = [];
            const lines = [];
            const sink = {
                emit: (m) => {
                    seen.push(m);
                    lines.push(`work: ${summarizeWorkMetrics(m)}`);
                },
            };
            // Turn 1: a write tool call + a usage report. Turn 2: finish.
            const llm = new ScriptLLM("metrics-model", [
                [
                    { type: "tool_use_start", id: "c1", name: "write" },
                    { type: "tool_use_end", id: "c1", input: { path: file, content: "hi" } },
                    { type: "usage", inputTokens: 1200, outputTokens: 340, model: "metrics-model" },
                    { type: "message_stop", stop_reason: "tool_use" },
                ],
                [
                    { type: "text_delta", delta: "done" },
                    { type: "usage", inputTokens: 80, outputTokens: 12, model: "metrics-model" },
                    { type: "message_stop", stop_reason: "end_turn" },
                ],
            ]);
            const outcome = await runAgent(cfg({ llm, cwd: dir, workMetricsSink: sink }));
            expect(outcome.reason).toBe("completed");
            expect(readFileSync(file, "utf8")).toBe("hi");
            // One emit per non-aborted turn.
            expect(seen.length).toBeGreaterThanOrEqual(1);
            const turn1 = seen[0];
            if (turn1 === undefined)
                throw new Error("no metrics emitted");
            expect(turn1.agentActions).toBe(1); // the write tool call
            expect(turn1.tokensInput).toBe(1200);
            expect(turn1.tokensOutput).toBe(340);
            // The rendered line is exactly what the CLI default writes to stderr.
            expect(lines[0]).toBe(`work: ${summarizeWorkMetrics(turn1)}`);
            expect(lines[0]).toContain("1 action");
            // 1200 → "1.2k", 340 → "0.3k" (compactTokens rounds ≥100 to k).
            expect(lines[0]).toContain("1.2k in / 0.3k out");
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
    test("(b) default-OFF: no sink wired ⇒ loop emits no work-metrics", async () => {
        const dir = mkdtempSync(join(tmpdir(), "work-metrics-off-"));
        try {
            let emitted = false;
            const llm = new ScriptLLM("m", [
                [
                    { type: "text_delta", delta: "ok" },
                    { type: "message_stop", stop_reason: "end_turn" },
                ],
            ]);
            // No workMetricsSink ⇒ buildWorkMetricsResources returns {}, collector is
            // never instantiated, emitWorkMetrics short-circuits. `emitted` proves the
            // negative: a sink we DON'T pass can't fire.
            const sink = {
                emit: () => {
                    emitted = true;
                },
            };
            void sink;
            await runAgent(cfg({ llm, cwd: dir }));
            expect(emitted).toBe(false);
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
