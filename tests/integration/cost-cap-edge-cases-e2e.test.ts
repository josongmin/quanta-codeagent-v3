/**
 * E2E — extreme edge cases for the cost-governance stack, driven through the
 * REAL `runAgent` loop + the production `assembleAgentConfig` path.
 *
 * Covers: exact/just-over boundary, cumulative-across-turns, per-turn vs
 * cumulative, unpriced model, malformed-usage poison resilience, negative/zero
 * tokens, meter+ledger both active, pre-flight before the call, tool-turn
 * epilogue timing, cross-run persistence, operator override vs preset, cache
 * tokens. Cost figures are exact (gpt-5.4 = $2.5/1M in, $15/1M out).
 */
import { describe, expect, test } from "bun:test"
import type { BudgetDials } from "@/agent"
import { runAgent } from "@/agent"
import { defaultBudgetLedger } from "@/agent/budget-ledger"
import { assembleAgentConfig } from "@/host/runtime/agent-config-assembler"
import { persistBudgetLedger } from "@/host/runtime/budget-ledger-persist"
import type { StreamEvent } from "@/llm"
import { costUsd } from "@/observability"
import { baseConfig, FakeLLM, RecordingStream, text, toolUse } from "./_harness"

class PricedFakeLLM extends FakeLLM {
  readonly model = "gpt-5.4"
}
type UsageOpts = { model?: string; cacheRead?: number; cacheCreation?: number }
const usage = (inTok: number, outTok: number, o: UsageOpts = {}): StreamEvent => ({
  type: "usage",
  model: o.model ?? "gpt-5.4",
  inputTokens: inTok,
  outputTokens: outTok,
  ...(o.cacheRead !== undefined ? { cacheReadTokens: o.cacheRead } : {}),
  ...(o.cacheCreation !== undefined ? { cacheCreationTokens: o.cacheCreation } : {}),
})
const OUT_RATE = 15 / 1_000_000 // gpt-5.4 output $/token
/** Output tokens whose cost is exactly `usd`. */
const outForUsd = (usd: number): number => Math.round(usd / OUT_RATE)

/** Assemble via the production host path (batch mode = autonomous) + run. */
const assembleRun = async (args: {
  scripts: StreamEvent[][]
  dials?: Partial<BudgetDials>
  env?: Record<string, string | undefined>
  ledger?: ReturnType<typeof defaultBudgetLedger>
  model?: string
}): Promise<{
  reason: string
  llm: PricedFakeLLM
  cfg: ReturnType<typeof assembleAgentConfig>
}> => {
  const llm = new PricedFakeLLM(args.scripts)
  if (args.model !== undefined) Object.defineProperty(llm, "model", { value: args.model })
  const base = baseConfig({
    llm,
    stream: new RecordingStream(),
    ...(args.ledger !== undefined ? { budgetLedger: args.ledger } : {}),
  })
  const cfg = assembleAgentConfig(
    { mode: "batch", base, ...(args.dials !== undefined ? { dials: args.dials } : {}) },
    args.env ?? {},
  )
  const outcome = await runAgent(cfg)
  return { reason: outcome.reason, llm, cfg }
}

const done = (u: StreamEvent): StreamEvent[] => [u, ...text("done")]
const cont = (u: StreamEvent, i: number): StreamEvent[] => [
  u,
  ...toolUse(`c${i}`, "read", { path: `/tmp/__cc_edge_nope_${i}__.txt` }),
]

describe("E2E cost-cap edge cases — boundary", () => {
  test("cost EXACTLY at cap ⇒ completes (strict greater-than)", async () => {
    // Spend exactly the cap (cap computed via the SAME costUsd, so observed ===
    // dial bit-for-bit) ⇒ `observed > dial` is false ⇒ no trip.
    const exact = costUsd("gpt-5.4", 0, 1000) as number
    const { reason } = await assembleRun({
      scripts: [done(usage(0, 1000))],
      dials: { maxCostUsd: exact },
    })
    expect(reason).toBe("completed")
  })

  test("cost just OVER cap ⇒ budget_exhausted", async () => {
    const { reason } = await assembleRun({
      scripts: [done(usage(0, outForUsd(1) + 100))], // $1 + a hair
      dials: { maxCostUsd: 1 },
    })
    expect(reason).toBe("budget_exhausted")
  })
})

describe("E2E cost-cap edge cases — accumulation", () => {
  test("CUMULATIVE across many small turns breaches at the crossing turn", async () => {
    // 5 continuing turns @ $0.30 each = $1.50 cumulative; cap $1 ⇒ trips at turn 4
    // ($1.20 > $1). Each turn issues a tool call so the run WOULD continue.
    const per = usage(0, outForUsd(0.3))
    const { reason, llm } = await assembleRun({
      scripts: [cont(per, 1), cont(per, 2), cont(per, 3), cont(per, 4), cont(per, 5), text("done")],
      dials: { maxCostUsd: 1 },
    })
    expect(reason).toBe("budget_exhausted")
    expect(llm.calls).toBeLessThanOrEqual(4) // stopped by/at turn 4, never reached turn 5/6
  })

  test("PER-TURN cap trips on a single spike while CUMULATIVE stays low", async () => {
    // one turn = $0.50 (> $0.40 per-turn cap); cumulative cap is generous ($100).
    const { reason } = await assembleRun({
      scripts: [done(usage(0, outForUsd(0.5)))],
      dials: { maxCostPerTurnUsd: 0.4, maxCostUsd: 100 },
    })
    expect(reason).toBe("budget_exhausted")
  })

  test("PER-TURN resets each turn — high cumulative NEVER trips the per-turn cap", async () => {
    // 5 turns @ $0.30 each (< $0.40 per-turn). Cumulative $1.50 but NO cumulative
    // cap ⇒ the per-turn dial governs and resets each turn ⇒ it NEVER fires. The
    // run ends by its own terminal turn / turn budget — the invariant is simply
    // that a cost breach was NOT the cause.
    const per = usage(0, outForUsd(0.3))
    const { reason } = await assembleRun({
      scripts: [cont(per, 1), cont(per, 2), cont(per, 3), cont(per, 4), cont(per, 5), text("done")],
      dials: { maxCostPerTurnUsd: 0.4 },
    })
    expect(reason).not.toBe("budget_exhausted")
  })
})

describe("E2E cost-cap edge cases — pricing robustness", () => {
  test("UNPRICED model ⇒ cost stays 0 ⇒ cap NEVER fires (best-effort)", async () => {
    // The cost tick prices `ev.model` from the usage event, so the UNPRICED id
    // must be on the event itself (not just the llm port).
    const { reason, cfg } = await assembleRun({
      scripts: [done(usage(5_000_000, 5_000_000, { model: "gpt-5-2" }))],
      dials: { maxCostUsd: 0.0001 },
      model: "gpt-5-2", // lane alias, absent from the price table
    })
    expect(reason).toBe("completed")
    expect(cfg.budgetMeter?.snapshot().costUsd).toBe(0)
  })

  test("POISON: a NaN-token usage event does not disable the cap; a later valid event trips it", async () => {
    const { reason } = await assembleRun({
      scripts: [
        cont(usage(Number.NaN, Number.NaN), 1), // malformed — must be a no-op for cost
        done(usage(0, outForUsd(5))), // valid $5 > cap
      ],
      dials: { maxCostUsd: 1 },
    })
    expect(reason).toBe("budget_exhausted")
  })

  test("NEGATIVE tokens ⇒ clamped to 0 cost ⇒ no spurious trip", async () => {
    const { reason, cfg } = await assembleRun({
      scripts: [done(usage(-1_000_000, -1_000_000))],
      dials: { maxCostUsd: 0.0001 },
    })
    expect(reason).toBe("completed")
    expect(cfg.budgetMeter?.snapshot().costUsd).toBe(0)
  })

  test("ZERO usage ⇒ no trip", async () => {
    const { reason } = await assembleRun({
      scripts: [done(usage(0, 0))],
      dials: { maxCostUsd: 0.0001 },
    })
    expect(reason).toBe("completed")
  })

  test("cache-read tokens are priced (openai carve-out) and counted toward the cap", async () => {
    // gpt-5.4 cacheRead = $0.25/1M. 1M input all-cached ⇒ ~$0.25 > $0.1 cap.
    const { reason } = await assembleRun({
      scripts: [done(usage(1_000_000, 0, { cacheRead: 1_000_000 }))],
      dials: { maxCostUsd: 0.1 },
    })
    expect(reason).toBe("budget_exhausted")
  })
})

describe("E2E cost-cap edge cases — numeric extremes", () => {
  test("1e12-token usage ⇒ huge finite cost trips (no overflow / NaN)", async () => {
    const { reason, cfg } = await assembleRun({
      scripts: [done(usage(1_000_000_000_000, 1_000_000_000_000))],
      dials: { maxCostUsd: 1 },
    })
    expect(reason).toBe("budget_exhausted")
    const cost = cfg.budgetMeter?.snapshot().costUsd ?? 0
    expect(Number.isFinite(cost)).toBe(true)
    expect(cost).toBeGreaterThan(1)
  })

  test("Infinity-token usage ⇒ non-finite cost is dropped by the tick guard (no poison)", async () => {
    // costUsd(Infinity) is non-finite ⇒ the meter tick guard no-ops it. A later
    // valid event must still trip (the cap was not disabled).
    const { reason, cfg } = await assembleRun({
      scripts: [cont(usage(Number.POSITIVE_INFINITY, 0), 1), done(usage(0, outForUsd(5)))],
      dials: { maxCostUsd: 1 },
    })
    expect(reason).toBe("budget_exhausted")
    expect(Number.isFinite(cfg.budgetMeter?.snapshot().costUsd ?? Number.NaN)).toBe(true)
  })
})

describe("E2E cost-cap edge cases — exhaustion policy carried", () => {
  test("assembleAgentConfig threads the exhaustion policy onto the meter", () => {
    const cfg = assembleAgentConfig(
      {
        mode: "batch",
        base: baseConfig({ llm: new PricedFakeLLM([text("x")]) }),
        exhaustion: "stop-with-summary",
      },
      {},
    )
    expect(cfg.budgetMeter?.exhaustion).toBe("stop-with-summary")
  })
})

describe("E2E cost-cap edge cases — pre-flight (L2)", () => {
  test("input-floor breach stops BEFORE the model call (llm.calls === 0)", async () => {
    // cap is below the cost of even the initial prompt's input tokens.
    const { reason, llm } = await assembleRun({
      scripts: [done(usage(0, 0))],
      dials: { maxCostUsd: 1e-9 },
    })
    expect(reason).toBe("budget_exhausted")
    expect(llm.calls).toBe(0)
  })
})

describe("E2E cost-cap edge cases — tool-turn epilogue timing", () => {
  test("a CONTINUING tool turn that breaches stops at the epilogue (not mid-tool)", async () => {
    const { reason, llm } = await assembleRun({
      scripts: [cont(usage(0, outForUsd(5)), 1), text("should-not-run")],
      dials: { maxCostUsd: 1 },
    })
    expect(reason).toBe("budget_exhausted")
    expect(llm.calls).toBe(1) // stopped after turn 1's tool resolved, before turn 2
  })
})

describe("E2E cost-cap edge cases — ledger + meter together", () => {
  test("meter AND ledger both active ⇒ the run stops (tighter ceiling wins)", async () => {
    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 100 } }) // loose
    const { reason } = await assembleRun({
      scripts: [cont(usage(0, outForUsd(5)), 1), text("done")],
      dials: { maxCostUsd: 1 }, // tighter ⇒ meter fires first at epilogue
      ledger,
    })
    expect(reason).toBe("budget_exhausted")
  })

  test("ledger HARD breach stops a continuing run even when the meter is uncapped", async () => {
    const ledger = defaultBudgetLedger({ policy: { sessionHardLimit: 1 } })
    const { reason } = await assembleRun({
      scripts: [cont(usage(0, outForUsd(5)), 1), text("done")],
      // no maxCostUsd dial ⇒ meter never trips on cost; the ledger does.
      ledger,
    })
    expect(reason).toBe("budget_exhausted")
  })
})

describe("E2E cost-cap edge cases — cross-run persistence", () => {
  test("CAMPAIGN: run B hydrates run A's spend and trips the shared daily cap", async () => {
    const store = new Map<string, string>()
    const fs = {
      exists: (p: string) => store.has(p),
      read: (p: string) => store.get(p) ?? "",
      write: (p: string, d: string) => void store.set(p, d),
    }
    const PATH = "/campaign-edge.json"
    const mkLedger = () =>
      persistBudgetLedger(defaultBudgetLedger({ policy: { dailyHardLimit: 1 } }), PATH, fs)

    // Run A: spends $0.60 (< $1 daily) ⇒ completes.
    const a = await assembleRun({ scripts: [done(usage(0, outForUsd(0.6)))], ledger: mkLedger() })
    expect(a.reason).toBe("completed")

    // Run B (fresh process): hydrates $0.60, spends $0.60 more ⇒ $1.20 > $1.
    const b = await assembleRun({
      scripts: [cont(usage(0, outForUsd(0.6)), 1), text("done")],
      ledger: mkLedger(),
    })
    expect(b.reason).toBe("budget_exhausted")
  })
})

describe("E2E cost-cap edge cases — operator override vs preset", () => {
  test("QUANTA_MAX_COST_USD override beats the batch preset's $5 cap", async () => {
    // batch preset maxCostUsd = $5; the override pins $0.0001 ⇒ a $1 spend trips.
    const { reason, cfg } = await assembleRun({
      scripts: [done(usage(0, outForUsd(1)))],
      env: { QUANTA_MAX_COST_USD: "0.0001" },
    })
    expect(cfg.budgetMeter?.dials.maxCostUsd).toBe(0.0001)
    expect(reason).toBe("budget_exhausted")
  })

  test("no override ⇒ the batch preset $5 cap stands (a $1 spend completes)", async () => {
    const { reason, cfg } = await assembleRun({ scripts: [done(usage(0, outForUsd(1)))] })
    expect(cfg.budgetMeter?.dials.maxCostUsd).toBe(5)
    expect(reason).toBe("completed")
  })
})
