/**
 * ADR-0087 (L2→L3) — the synthetic runner FILLS the additive token/cost fields
 * and the report rollup RENDERS them.
 *
 * Runner contract (verified against `runScenario` + the `eval-error-channels`
 * mock-LLM shape): a mock `LLMPort` whose `stream` yields a `{type:"usage"}`
 * StreamEvent (bridged by the agent loop's `teeUsage`→`emitUsage` to a `usage`
 * AgentEvent in the CapturingStream) drives a one-turn run with no tool calls:
 *   - known model    → tokens populated, costUsd > 0
 *   - unknown model  → tokens populated, costUsd absent (price-table miss)
 *   - no usage event → tokens AND costUsd both absent (byte-identical path)
 *
 * Report contract: `buildCoverageMatrix` sums `tokens`/`costUsd` across
 * synthetic+public payloads into `tokenCost`, the markdown gains a
 * "Token & Cost Summary" section, and the headline appends `Tokens=/Cost=$`.
 * A usage-free corpus leaves all of that absent (byte-identical).
 */
import { describe, expect, test } from "bun:test"
import { buildCoverageMatrix } from "@/../src/apps/eval/report/coverage-matrix"
import { renderHeadline, renderMatrixMarkdown } from "@/../src/apps/eval/report/markdown"
import type { EvalRecord } from "@/../src/apps/eval/storage"
import { runScenario } from "@/../src/apps/eval/synthetic/runner"
import type { Scenario } from "@/../src/apps/eval/synthetic/scenario"
import { allLeaves } from "@/../src/apps/eval/taxonomy"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"

const knownLeafId = allLeaves()[0]?.id ?? "software-quality.debugging.error-message-paste"

// Mock LLM emitting a usage event + a text reply, then stopping (one turn, no
// tool calls). `model` is configurable so we can exercise known/unknown pricing.
const usageLLM = (
  model: string | undefined,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number },
): LLMPort => ({
  ...(model !== undefined ? { model } : {}),
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield {
      type: "usage",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      model: model ?? "unknown",
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    }
    yield { type: "text_delta", delta: "done." }
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

// Mock LLM that never emits a usage event — exercises the no-usage path.
const noUsageLLM = (model: string): LLMPort => ({
  model,
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "done." }
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

const makeScenario = (): Scenario => ({
  schema: 1,
  id: "token-cost-s1",
  usecase: knownLeafId,
  title: "x",
  prompt: "say done",
  rubric: [{ id: "a", description: "a" }],
})

describe("ADR-0087 runScenario fills token + cost", () => {
  test("known model → tokens populated and costUsd > 0", async () => {
    const run = await runScenario(makeScenario(), {
      llm: usageLLM("claude-opus-4-7", {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
      }),
    })
    expect(run.tokens).toEqual({ prompt: 1000, completion: 500, cacheRead: 200 })
    expect(typeof run.costUsd).toBe("number")
    expect(run.costUsd as number).toBeGreaterThan(0)
  })

  test("unknown model → tokens populated but costUsd is null", async () => {
    const run = await runScenario(makeScenario(), {
      llm: usageLLM("no-such-model-9000", { inputTokens: 800, outputTokens: 100 }),
    })
    expect(run.tokens).toEqual({ prompt: 800, completion: 100 })
    expect(run.costUsd).toBeNull()
  })

  test("no usage event → tokens AND costUsd both undefined (byte-identical path)", async () => {
    const run = await runScenario(makeScenario(), {
      llm: noUsageLLM("claude-opus-4-7"),
    })
    expect(run.tokens).toBeUndefined()
    expect(run.costUsd).toBeUndefined()
  })

  test("zero cacheRead is omitted from tokens", async () => {
    const run = await runScenario(makeScenario(), {
      llm: usageLLM("claude-opus-4-7", { inputTokens: 10, outputTokens: 5 }),
    })
    expect(run.tokens).toEqual({ prompt: 10, completion: 5 })
    expect(run.tokens && "cacheRead" in run.tokens).toBe(false)
  })
})

// ── Report rollup ─────────────────────────────────────────────────────────────

const synRecord = (
  tokens?: { prompt: number; completion: number; cacheRead?: number },
  costUsd?: number,
): EvalRecord => ({
  ts: 1,
  schema: 1,
  runId: "r1",
  tier: "synthetic",
  usecase: knownLeafId,
  payload: {
    kind: "synthetic",
    scenarioId: "s",
    verdict: "pass",
    rubric: [],
    toolsUsed: [],
    durationMs: 1,
    ...(tokens ? { tokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  },
})

describe("ADR-0087 report rollup", () => {
  test("sums tokens + cost across payloads into tokenCost", () => {
    const m = buildCoverageMatrix([
      synRecord({ prompt: 100, completion: 50, cacheRead: 20 }, 0.5),
      synRecord({ prompt: 200, completion: 60 }, 1.25),
    ])
    expect(m.tokenCost).toEqual({
      prompt: 300,
      completion: 110,
      cacheRead: 20,
      costUsd: 1.75,
      records: 2,
    })
  })

  test("renders Token & Cost section + headline suffix when present", () => {
    const m = buildCoverageMatrix([synRecord({ prompt: 100, completion: 50 }, 0.5)])
    const md = renderMatrixMarkdown(m)
    expect(md).toContain("## Token & Cost Summary")
    expect(md).toContain("Prompt tokens: 100")
    expect(md).toContain("Estimated cost: $0.5000")
    const head = renderHeadline(m)
    expect(head).toContain("Tokens=150")
    expect(head).toContain("Cost=$0.5000")
  })

  test("usage-free corpus → tokenCost absent, no extra render (byte-identical)", () => {
    const m = buildCoverageMatrix([synRecord()])
    expect(m.tokenCost).toBeUndefined()
    expect(renderMatrixMarkdown(m)).not.toContain("Token & Cost Summary")
    const head = renderHeadline(m)
    expect(head).not.toContain("Tokens=")
    expect(head).not.toContain("Cost=")
  })
})
