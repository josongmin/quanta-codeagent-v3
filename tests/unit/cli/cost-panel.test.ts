/**
 * cost-panel hellgate — the panel as a PROJECTION of the usage authority.
 *
 * A3 removed the panel's own accumulation: every token and dollar it renders
 * comes from `UsageAccountingPort` records, and its only mutation is
 * `noteTurn()` (a turn is a UI fact). These tests therefore seed the
 * AUTHORITY and assert the RENDERED surfaces — the same direction production
 * data flows.
 *
 * Contracts retired with the legacy feed, deliberately and not re-tested:
 *   - `incrementTurn` delta folding (explicit/null `costUsd`, negative-cost
 *     clamps): the seam no longer exists; the equivalent guards live at the
 *     authority boundary (non-finite REJECTED — authority tests) and at
 *     normalization (negative clamps — normalize-price tests).
 */
import { describe, expect, test } from "bun:test"
import {
  type CostPanel,
  type CostPanelOptions,
  createCostPanel,
  isCostPanelEnabled,
} from "../../../src/apps/cli/cost-panel"
import { MODEL_RATE_CARD, PRICING_VERSION } from "../../../src/observability/pricing"
import {
  createUsageAccounting,
  normalizeUsage,
  priceUsage,
  type UsageAccountingPort,
  type UsageCost,
} from "../../../src/observability/usage-accounting"
import { setColorPolicy, stripAnsi } from "../../../src/ui/ui-helpers"

// Force ANSI off so render assertions don't see colour escapes.
setColorPolicy("off")

const makeClock = (start = 1_000_000): { now: () => number; advance: (ms: number) => void } => {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
  }
}

interface Harness {
  readonly panel: CostPanel
  readonly accounting: UsageAccountingPort
  /** Record one model call into the authority and count one turn — the
   *  production pairing (emitUsage sink + dashboard noteTurn). */
  turn(tokens: {
    model?: string
    input?: number
    output?: number
    cacheRead?: number
    /** Hand-built total ⇒ the cost arrives pre-priced (the record-level
     *  equivalent of the old caller-supplied costUsd). */
    costUsd?: number
  }): void
}

let callSeq = 0

const make = (overrides: Partial<CostPanelOptions> = {}): Harness => {
  const accounting = createUsageAccounting()
  const panel = createCostPanel({ model: "claude-sonnet-4-6", accounting, ...overrides })
  const turn: Harness["turn"] = (t) => {
    const usage = normalizeUsage({
      model: t.model ?? "claude-sonnet-4-6",
      inputTokens: t.input ?? 0,
      outputTokens: t.output ?? 0,
      ...(t.cacheRead !== undefined ? { cacheReadTokens: t.cacheRead } : {}),
    })
    const cost: UsageCost =
      t.costUsd !== undefined
        ? {
            totalUsd: t.costUsd,
            freshInputUsd: t.costUsd,
            cacheReadUsd: 0,
            cacheWriteUsd: 0,
            outputUsd: 0,
            pricingKnown: true,
            pricingModel: usage.model,
            pricingVersion: PRICING_VERSION,
          }
        : priceUsage(usage, MODEL_RATE_CARD, { pricingVersion: PRICING_VERSION })
    accounting.record({
      callId: `t${++callSeq}`,
      at: 1,
      usage,
      cost,
      provenance: { sessionId: "s", agentId: "root", agentKind: "root", depth: 0 },
    })
    panel.noteTurn()
  }
  return { panel, accounting, turn }
}

// ── ENV gate ────────────────────────────────────────────────────────────

describe("isCostPanelEnabled: env + TTY gate", () => {
  test("non-TTY surface always disabled", () => {
    expect(isCostPanelEnabled({}, false)).toBe(false)
    expect(isCostPanelEnabled({}, undefined)).toBe(false)
  })

  test("TTY + no env knob ⇒ enabled (default-ON)", () => {
    expect(isCostPanelEnabled({}, true)).toBe(true)
  })

  test("explicit QUANTA_COST_PANEL=0|false|off|no ⇒ disabled", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", " OFF "]) {
      expect(isCostPanelEnabled({ QUANTA_COST_PANEL: v }, true)).toBe(false)
    }
  })

  test("any other QUANTA_COST_PANEL value ⇒ enabled", () => {
    for (const v of ["1", "true", "on", "yes", "verbose"]) {
      expect(isCostPanelEnabled({ QUANTA_COST_PANEL: v }, true)).toBe(true)
    }
  })
})

// ── projection ──────────────────────────────────────────────────────────

describe("projection: the snapshot IS the authority's numbers", () => {
  test("tokens and priced cost accumulate across recorded calls", () => {
    const { panel, turn } = make()
    turn({ input: 1000, output: 200 })
    turn({ input: 500, output: 100, cacheRead: 50 })
    const s = panel.snapshot()
    expect(s.turns).toBe(2)
    // sonnet: (1500 in × $3 + 300 out × $15 + 50 cacheRead × $0.30) / 1M
    expect(s.inputTokens).toBe(1550) // prompt = fresh + cacheRead (anthropic additive)
    expect(s.outputTokens).toBe(300)
    expect(s.cacheReadTokens).toBe(50)
    expect(s.totalCostUsd).toBeCloseTo(0.009_015, 9)
  })

  test("hand-priced records fold verbatim (the record-level costUsd contract)", () => {
    const { panel, turn } = make()
    turn({ input: 1000, output: 200, costUsd: 0.5 })
    turn({ input: 100, output: 50, costUsd: 0.25 })
    expect(panel.snapshot().totalCostUsd).toBeCloseTo(0.75, 9)
  })

  test("an authority-less panel is 'accounting off', never fake zeros", () => {
    const panel = createCostPanel({ model: "claude-sonnet-4-6" })
    panel.noteTurn()
    expect(panel.snapshot().totalCostUsd).toBeNull()
    expect(stripAnsi(panel.render())).toContain("accounting off")
    expect(stripAnsi(panel.renderDetailed())).toMatch(/Accounting:\s+off/)
  })
})

describe("A6 — a corrupt resume never renders as a confident zero", () => {
  test("continuityLost shows in /cost; a healthy panel shows nothing", () => {
    const { panel, accounting } = make()
    expect(panel.renderDetailed()).not.toContain("prior totals lost")
    accounting.hydrate("{ corrupt")
    expect(stripAnsi(panel.renderDetailed())).toContain("prior totals lost")
  })
})

// ── single-line render ──────────────────────────────────────────────────

describe("render(): single-line status form", () => {
  test("shape includes cost · turns · in/out · model", () => {
    const { panel, turn } = make()
    turn({ input: 45_000, output: 12_000 })
    turn({ input: 234, output: 891 })
    const line = stripAnsi(panel.render())
    expect(line).toMatch(/^\$\d/)
    expect(line).toMatch(/2 turns/)
    expect(line).toMatch(/in/)
    expect(line).toMatch(/out/)
    expect(line).toContain("claude-sonnet-4-6")
  })

  test("singular 'turn' on the first turn", () => {
    const { panel, turn } = make()
    turn({ input: 100, output: 20 })
    expect(panel.render()).toMatch(/1 turn(?!s)/)
  })

  test("an unknown-only session reads 'cost incomplete', never an exact figure", () => {
    // A2 — the unknown model admits at $0 / pricingKnown:false. That zero is
    // an ABSENCE; rendering it as "$0.0000" (or the old "n/a") hid real spend.
    const { panel, turn } = make({ model: "fictional-model-9000" })
    turn({ model: "fictional-model-9000", input: 1000, output: 200 })
    const line = stripAnsi(panel.render())
    expect(line).toContain("cost incomplete")
    expect(line).not.toMatch(/^\$/)
    expect(line).toContain("fictional-model-9000")
  })
})

// ── boxed detailed render ───────────────────────────────────────────────

describe("renderDetailed(): boxed /cost form", () => {
  test("contains every documented row", () => {
    const clock = makeClock()
    const { panel, turn } = make({ now: clock.now })
    turn({ input: 45_234, output: 12_891, cacheRead: 8123 })
    clock.advance(12 * 60 * 1000 + 34 * 1000) // 12m 34s
    const body = stripAnsi(panel.renderDetailed())
    expect(body).toContain("session cost")
    expect(body).toMatch(/Duration:\s+12m 34s/)
    expect(body).toMatch(/Turns:\s+1/)
    expect(body).toMatch(/Input:\s+53,357 tok/) // prompt = 45,234 fresh + 8,123 cached
    expect(body).toMatch(/Output:\s+12,891 tok/)
    expect(body).toMatch(/Cache read:\s+8,123 tok/)
    expect(body).toMatch(/Total cost:\s+\$/)
    expect(body).toMatch(/Per turn avg:\s+\$/)
    expect(body).toContain("claude-sonnet-4-6")
  })

  test("unknown-only session: the Total-cost cell says incomplete", () => {
    const { panel, turn } = make({ model: "fictional-model-9000" })
    turn({ model: "fictional-model-9000", input: 100, output: 50 })
    const body = stripAnsi(panel.renderDetailed())
    expect(body).toMatch(/Total cost:\s+incomplete/)
    expect(body).toContain("1 unpriced")
  })

  test("duration formats as 5s / 2m 30s / 1h 5m", () => {
    const clock = makeClock()
    const { panel } = make({ now: clock.now })
    clock.advance(5_000)
    expect(stripAnsi(panel.renderDetailed())).toMatch(/Duration:\s+5s/)
    clock.advance(2 * 60 * 1000 + 25 * 1000)
    expect(stripAnsi(panel.renderDetailed())).toMatch(/Duration:\s+2m 30s/)
    clock.advance(2 * 60 * 60 * 1000)
    expect(stripAnsi(panel.renderDetailed())).toMatch(/Duration:\s+\d+h \d+m/)
  })
})

// ── disabled instance ───────────────────────────────────────────────────

describe("disabled instance is fully no-op", () => {
  test("enabled=false ⇒ no turns, no projection read, empty renders", () => {
    const { panel, turn } = make({ enabled: false })
    turn({ input: 1000, output: 200, costUsd: 0.5 })
    // The authority recorded (it is session truth, not panel state) — but the
    // DISABLED panel neither counts nor projects it.
    expect(panel.snapshot().turns).toBe(0)
    expect(panel.snapshot().inputTokens).toBe(0)
    expect(panel.snapshot().totalCostUsd).toBeNull()
    expect(panel.render()).toBe("")
    expect(panel.renderDetailed()).toBe("")
  })
})

// ── per-model breakdown ─────────────────────────────────────────────────

describe("byModel(): per-model attribution", () => {
  test("single-model session ⇒ one bucket; no 'By model' section", () => {
    const { panel, turn } = make()
    turn({ input: 1000, output: 200 })
    turn({ input: 500, output: 100 })
    const buckets = panel.byModel()
    expect(buckets.length).toBe(1)
    expect(buckets[0]?.model).toBe("claude-sonnet-4-6")
    expect(buckets[0]?.inputTokens).toBe(1500)
    expect(buckets[0]?.outputTokens).toBe(300)
    expect(stripAnsi(panel.renderDetailed())).not.toContain("By model:")
  })

  test("heterogeneous session attributes tokens/cost to the model of each call", () => {
    const { panel, turn } = make()
    turn({ input: 1000, output: 200, costUsd: 0.5 })
    turn({ model: "gpt-4o-mini", input: 2000, output: 400, costUsd: 0.25 })
    turn({ model: "gpt-4o-mini", input: 100, output: 50, costUsd: 0.05 })
    const buckets = panel.byModel()
    expect(buckets.length).toBe(2)
    const sonnet = buckets.find((b) => b.model === "claude-sonnet-4-6")
    const gpt = buckets.find((b) => b.model === "gpt-4o-mini")
    expect(sonnet?.inputTokens).toBe(1000)
    expect(sonnet?.costUsd).toBeCloseTo(0.5, 6)
    expect(gpt?.inputTokens).toBe(2100)
    expect(gpt?.costUsd).toBeCloseTo(0.3, 6)
    const body = stripAnsi(panel.renderDetailed())
    expect(body).toContain("By model:")
    expect(body).toContain("claude-sonnet-4-6:")
    expect(body).toContain("gpt-4o-mini:")
  })

  test("an unknown model's bucket carries tokens and a ZERO floor, counted unpriced", () => {
    // The old contract rendered null; the authority admits at $0 +
    // unpricedCalls so the surface can say incomplete instead.
    const { panel, accounting, turn } = make({ model: "fictional-9000" })
    turn({ model: "fictional-9000", input: 100, output: 50 })
    const b = panel.byModel()[0]
    expect(b?.inputTokens).toBe(100)
    expect(b?.costUsd).toBe(0)
    expect(accounting.snapshot().unpricedCalls).toBe(1)
  })

  test("disabled instance ⇒ byModel() empty", () => {
    const { panel, turn } = make({ enabled: false })
    turn({ input: 100, output: 50, costUsd: 0.5 })
    expect(panel.byModel()).toEqual([])
  })
})

// ── audit hardening (sanitize / fmt / cache-read) ───────────────────────

describe("audit hardening", () => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control bytes are stripped
  const CONTROL = /[\x00-\x1f\x7f-\x9f]/

  test("model id with ESC/OSC bytes is sanitized at construction", () => {
    const panel = createCostPanel({ model: "evil\x1b]0;PWNED\x07\nFAKE" })
    expect(CONTROL.test(panel.snapshot().model)).toBe(false)
    expect(CONTROL.test(panel.render())).toBe(false)
  })

  test("a hostile RECORDED model id is sanitized at every render boundary", () => {
    const { panel, turn } = make()
    turn({ model: "x\x1b[31mRED", input: 10 })
    const row = panel.byModel().find((b) => b.model.startsWith("x"))
    expect(row?.model).toBe("x[31mRED") // only the ESC byte is stripped
    expect(panel.renderDetailed()).not.toContain("\x1b[31m")
    expect(panel.render()).not.toContain("\x1b[31m") // the label follows the newest record
  })

  test("formatTokens: <10k comma-grouped, >=10k k-form (via render)", () => {
    const a = make()
    a.turn({ input: 9999 })
    expect(stripAnsi(a.panel.render())).toContain("9,999 in")
    const b = make()
    b.turn({ input: 12_000 })
    expect(stripAnsi(b.panel.render())).toContain("12.0k in")
  })

  test("per-model breakdown row includes cache-read (reconciles with aggregate)", () => {
    const { panel, turn } = make()
    turn({ input: 1000, output: 200, cacheRead: 500, costUsd: 0.5 })
    turn({ model: "gpt-4o-mini", input: 2000, output: 400, cacheRead: 800, costUsd: 0.25 })
    const body = stripAnsi(panel.renderDetailed())
    expect(body).toMatch(/claude-sonnet-4-6:.*500 cache/)
    expect(body).toMatch(/gpt-4o-mini:.*800 cache/)
  })
})

// ── color-OFF determinism ───────────────────────────────────────────────

describe("deterministic render under color=none", () => {
  test("render() and renderDetailed() carry no ANSI escapes", () => {
    setColorPolicy("off")
    const { panel, turn } = make()
    turn({ input: 100, output: 50 })
    expect(panel.render()).toBe(stripAnsi(panel.render()))
    expect(panel.renderDetailed()).toBe(stripAnsi(panel.renderDetailed()))
  })
})
