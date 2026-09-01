/**
 * MR-04 hellgate — snapshot → surface numbers.
 *
 * One place turns a snapshot into what a surface renders, so the status line,
 * `/cost`, the dashboards, and the web sidebar cannot drift apart again. The
 * properties worth pinning are the ones a surface would otherwise re-invent:
 * what "input" means when providers disagree, how per-model lines are ordered,
 * and whether subagent spend is visible as its own number.
 */
import { describe, expect, test } from "bun:test"
import { MODEL_RATE_CARD, PRICING_VERSION } from "@/observability/pricing"
import {
  costSurfaceView,
  costSurfaceViewWire,
  createUsageAccounting,
  normalizeUsage,
  priceUsage,
  type UsageRecord,
} from "@/observability/usage-accounting"

const record = (
  callId: string,
  over: {
    model?: string
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    agentKind?: "root" | "subagent"
    agentId?: string
  } = {},
): UsageRecord => {
  const usage = normalizeUsage({
    model: over.model ?? "claude-sonnet-4-6",
    inputTokens: over.inputTokens ?? 0,
    outputTokens: over.outputTokens ?? 0,
    ...(over.cacheReadTokens !== undefined ? { cacheReadTokens: over.cacheReadTokens } : {}),
  })
  return {
    callId,
    at: 1_700_000_000_000,
    usage,
    cost: priceUsage(usage, MODEL_RATE_CARD, { pricingVersion: PRICING_VERSION }),
    provenance: {
      sessionId: "s",
      agentId: over.agentId ?? "root",
      agentKind: over.agentKind ?? "root",
      depth: over.agentKind === "subagent" ? 1 : 0,
    },
  }
}

const viewOf = (...records: readonly UsageRecord[]) => {
  const acct = createUsageAccounting()
  for (const r of records) acct.record(r)
  return costSurfaceView(acct.snapshot())
}

describe("prompt tokens are provider-neutral and summable", () => {
  test("an OpenAI and an Anthropic call add up without double-counting", () => {
    // OpenAI reports 1M prompt of which 400k were cached; Anthropic reports
    // 1M fresh PLUS 400k cached. Raw, those two numbers mean different things
    // and cannot be summed. Canonically both are "prompt tokens sent".
    const view = viewOf(
      record("a", { model: "gpt-5.4", inputTokens: 1_000_000, cacheReadTokens: 400_000 }),
      record("b", { model: "claude-sonnet-4-6", inputTokens: 1_000_000, cacheReadTokens: 400_000 }),
    )
    expect(view.promptTokens).toBe(2_400_000) // 1.0M openai + 1.4M anthropic
    expect(view.cacheReadTokens).toBe(800_000)
    expect(view.freshInputTokens).toBe(1_600_000) // 600k + 1.0M
    expect(view.freshInputTokens + view.cacheReadTokens).toBe(view.promptTokens)
  })
})

describe("per-model lines are ordered and complete", () => {
  test("display labels strip controls and cap length without changing accounting identity", () => {
    const raw = `model\n\r\t\u001b\u007f\u0085\u2028\u2029${"x".repeat(100)}`
    const acct = createUsageAccounting()
    expect(acct.record(record("hostile", { model: raw })).admitted).toBe(true)
    const expected = `model${"x".repeat(59)}`
    expect(costSurfaceViewWire(acct)).toMatchObject({ modelSlug: expected })
    expect(costSurfaceView(acct.snapshot()).byModel[0]?.model).toBe(expected)
    expect(acct.recent(1)[0]?.usage.model).toBe(raw)
    expect(acct.snapshot().byModel.has(raw)).toBe(true)

    const straddled = `${"y".repeat(63)}🚀tail`
    expect(acct.record(record("astral", { model: straddled })).admitted).toBe(true)
    const astralWire = costSurfaceViewWire(acct)
    if (astralWire.status !== "on") throw new Error("accounting unexpectedly disabled")
    expect(astralWire.modelSlug).toBe("y".repeat(63))
    expect(astralWire.modelSlug?.isWellFormed()).toBe(true)
    expect(acct.recent(1)[0]?.usage.model).toBe(straddled)
  })

  test("lines sort by spend descending, ties broken by name", () => {
    // Stable ordering matters: a list that reshuffles between renders reads as
    // churn rather than as data.
    const view = viewOf(
      record("a", { model: "claude-haiku-4-5", inputTokens: 1_000_000 }), // $1
      record("b", { model: "claude-opus-4-7", inputTokens: 1_000_000 }), // $15
      record("c", { model: "claude-sonnet-4-6", inputTokens: 1_000_000 }), // $3
    )
    expect(view.byModel.map((l) => l.model)).toEqual([
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ])
    expect(view.byModel[0]?.totalUsd).toBeCloseTo(15, 9)
    expect(view.byModel.reduce((n, l) => n + l.totalUsd, 0)).toBeCloseTo(view.totalUsd, 9)
  })

  test("a model's line carries its own call count", () => {
    const view = viewOf(record("a"), record("b"), record("c", { model: "claude-haiku-4-5" }))
    expect(view.byModel.find((l) => l.model === "claude-sonnet-4-6")?.calls).toBe(2)
    expect(view.calls).toBe(3)
  })
})

describe("subagent spend is visible as its own number", () => {
  test("root and subagent totals are projected separately and sum to the total", () => {
    const view = viewOf(
      record("r", { inputTokens: 100_000 }), // $0.30 root
      record("s", { inputTokens: 500_000, agentKind: "subagent", agentId: "child-1" }), // $1.50
    )
    expect(view.totalUsd).toBeCloseTo(1.8, 9)
    expect(view.byKind.root).toBeCloseTo(0.3, 9)
    expect(view.byKind.subagent).toBeCloseTo(1.5, 9)
    expect(view.byKind.root + view.byKind.subagent).toBeCloseTo(view.totalUsd, 9)
  })

  test("an empty session projects zeros, not absences", () => {
    const view = costSurfaceView(createUsageAccounting().snapshot())
    expect(view.totalUsd).toBe(0)
    expect(view.calls).toBe(0)
    expect(view.byModel).toEqual([])
    expect(view.byKind.subagent).toBe(0)
  })
})
