/**
 * End-to-end token-usage metrics flow (Claude Desktop 1.7196.3
 * `getContextUsage` parity).
 *
 * Spec: when the model emits a `{type:"usage"}` StreamEvent, the loop's
 * recorder MUST forward input/output (and optional cacheRead) tokens into the
 * canonical OTel GenAI counters (`gen_ai.usage.input_tokens` /
 * `gen_ai.usage.output_tokens` / `gen_ai.usage.cache_read_input_tokens`),
 * accumulating across turns. With `config.metrics` absent the loop remains
 * byte-identical (no recorder is constructed) — that branch is covered by the
 * existing observability suites; this file proves the wired branch.
 *
 * Uses the shared `_harness.ts` (`ScriptedLLM` + `RecordingStream` + `cfg`).
 */
import { describe, expect, test } from "bun:test"
import { METRIC, runAgent } from "@/agent"
import type { StreamEvent } from "@/llm"
import { Metrics } from "@/observability"
import { cfg, ev, RecordingStream, ScriptedLLM, withTimeout } from "./_harness"

const turnWithUsage = (input: number, output: number, cacheRead?: number): StreamEvent[] => {
  const usageEvent: StreamEvent =
    cacheRead === undefined
      ? { type: "usage", inputTokens: input, outputTokens: output, model: "scripted-test-model" }
      : {
          type: "usage",
          inputTokens: input,
          outputTokens: output,
          cacheReadTokens: cacheRead,
          model: "scripted-test-model",
        }
  return [
    { type: "text_delta", delta: "ok" },
    usageEvent,
    { type: "message_stop", stop_reason: "end_turn" },
  ]
}

describe("agent loop — token-usage e2e", () => {
  test("single turn: usage event ⇒ recorder counters reflect input/output", async () => {
    const metrics = new Metrics()
    const stream = new RecordingStream()
    const llm = new ScriptedLLM([ev(turnWithUsage(123, 45))])

    await withTimeout(runAgent(cfg({ llm, stream, metrics })), 5000, "single-turn-usage")

    const c = metrics.snapshot().counters
    expect(c[METRIC.tokensInput]).toBe(123)
    expect(c[METRIC.tokensOutput]).toBe(45)
    expect(c[METRIC.cacheRead] ?? 0).toBe(0)

    // The usage AgentEvent is still emitted on the stream (pre-existing W-C
    // bridge contract) so consumers like the CLI status line have a live signal.
    const usages = stream.events.filter((e) => e.type === "usage")
    expect(usages.length).toBe(1)
  })

  test("cacheRead token field is forwarded into its own counter", async () => {
    const metrics = new Metrics()
    const llm = new ScriptedLLM([ev(turnWithUsage(200, 50, 80))])

    await withTimeout(
      runAgent(cfg({ llm, stream: new RecordingStream(), metrics })),
      5000,
      "cache-read-usage",
    )

    const c = metrics.snapshot().counters
    expect(c[METRIC.tokensInput]).toBe(200)
    expect(c[METRIC.tokensOutput]).toBe(50)
    expect(c[METRIC.cacheRead]).toBe(80)
  })

  test("metrics absent ⇒ no crash, loop completes normally (byte-identical branch)", async () => {
    // No `metrics` field on the config — recorder is undefined; usage events
    // still flow to the stream but no counter side-effects can happen.
    const llm = new ScriptedLLM([ev(turnWithUsage(100, 50))])
    const stream = new RecordingStream()

    const outcome = await withTimeout(runAgent(cfg({ llm, stream })), 5000, "no-metrics-branch")

    expect(outcome.reason).toBe("completed")
    expect(stream.events.some((e) => e.type === "usage")).toBe(true)
  })
})
