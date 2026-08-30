/**
 * cost-panel hellgate — cumulative session cost sticky panel contract.
 *
 * Pins {@link createCostPanel}: accumulation across multiple turns,
 * single-line render shape, boxed `/cost` detailed render, ENV/TTY gate,
 * cost = N/A fallback for unknown models, disabled-instance no-op, and the
 * model-swap mid-session path.
 */

import { describe, expect, test } from "bun:test"
import {
  type CostPanel,
  type CostPanelOptions,
  createCostPanel,
  isCostPanelEnabled,
} from "../../../src/apps/cli/cost-panel"
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

const make = (overrides: Partial<CostPanelOptions> = {}): CostPanel =>
  createCostPanel({ model: "claude-sonnet-4-6", ...overrides })

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

// ── accumulation ────────────────────────────────────────────────────────

describe("createCostPanel: accumulation across turns", () => {
  test("incrementTurn folds tokens; noteTurn bumps the turn count (A3-S1 split)", () => {
    const panel = make()
    panel.incrementTurn({ inputTokens: 1000, outputTokens: 200 })
    panel.noteTurn()
    panel.incrementTurn({ inputTokens: 500, outputTokens: 100, cacheReadTokens: 50 })
    panel.noteTurn()
    const s = panel.snapshot()
    expect(s.turns).toBe(2)
    expect(s.inputTokens).toBe(1500)
    expect(s.outputTokens).toBe(300)
    expect(s.cacheReadTokens).toBe(50)
  })

  test("cost accumulates across known-model turns", () => {
    const panel = make({ model: "claude-sonnet-4-6" })
    // claude-sonnet-4-6: $3 in / $15 out / $0.30 cache-read per 1M.
    // Turn 1: 1000 in, 200 out ⇒ 0.003 + 0.003 = 0.006
    panel.incrementTurn({ inputTokens: 1000, outputTokens: 200 })
    // Turn 2: 500 in, 100 out, 50 cache_read ⇒ 0.0015 + 0.0015 + 0.000015
    panel.incrementTurn({ inputTokens: 500, outputTokens: 100, cacheReadTokens: 50 })
    const s = panel.snapshot()
    expect(s.totalCostUsd).not.toBeNull()
    if (s.totalCostUsd === null) throw new Error("unreachable")
    expect(s.totalCostUsd).toBeCloseTo(0.009015, 6)
  })

  test("caller-provided costUsd is used verbatim (not re-derived)", () => {
    const panel = make({ model: "claude-sonnet-4-6" })
    panel.incrementTurn({ inputTokens: 1000, outputTokens: 200, costUsd: 0.5 })
    panel.incrementTurn({ inputTokens: 100, outputTokens: 50, costUsd: 0.25 })
    expect(panel.snapshot().totalCostUsd).toBeCloseTo(0.75, 6)
  })

  test("null costUsd contribution is skipped (no NaN)", () => {
    const panel = make({ model: "claude-sonnet-4-6" })
    panel.incrementTurn({ inputTokens: 1000, outputTokens: 200, costUsd: 0.5 })
    panel.noteTurn()
    panel.incrementTurn({ inputTokens: 100, outputTokens: 50, costUsd: null })
    panel.noteTurn()
    const s = panel.snapshot()
    expect(s.totalCostUsd).toBeCloseTo(0.5, 6)
    expect(s.turns).toBe(2)
  })

  test("a turn is priced by the model IT ran on, not the session label", () => {
    // The model rides on the usage delta — that is the shipped seam, and the
    // reason a turn that switches models is priced correctly. `update()` used
    // to be the way to express this in tests, but production never called it,
    // so the test was exercising a path no session took.
    const panel = make({ model: "claude-sonnet-4-6" })
    panel.incrementTurn({ inputTokens: 1000, outputTokens: 200 })
    // Subsequent turn uses the OTHER model's pricing.
    panel.incrementTurn({ inputTokens: 1000, outputTokens: 100, model: "gpt-4o-mini" })
    // gpt-4o-mini: $0.15 in / $0.60 out per 1M ⇒ 0.00015 + 0.00006 = 0.00021
    // Combined with the sonnet turn (0.006): ≈ 0.00621
    const s = panel.snapshot()
    expect(s.totalCostUsd).not.toBeNull()
    if (s.totalCostUsd === null) throw new Error("unreachable")
    expect(s.totalCostUsd).toBeCloseTo(0.00621, 6)
  })
})

// ── single-line render ──────────────────────────────────────────────────

describe("createCostPanel.render(): single-line status form", () => {
  test("shape includes cost · turns · in/out · model", () => {
    const panel = make({ model: "claude-sonnet-4-6" })
    panel.incrementTurn({ inputTokens: 45_000, outputTokens: 12_000 })
    panel.noteTurn()
    panel.incrementTurn({ inputTokens: 234, outputTokens: 891 })
    panel.noteTurn()
    const line = stripAnsi(panel.render())
    // $X.XXXX format for sub-cent ranges expected for tiny totals; check
    // the structural separators + tokens label + model.
    expect(line).toMatch(/^\$\d/)
    expect(line).toMatch(/2 turns/)
    expect(line).toMatch(/in/)
    expect(line).toMatch(/out/)
    expect(line).toContain("claude-sonnet-4-6")
  })

  test("singular 'turn' on the first turn", () => {
    const panel = make()
    panel.incrementTurn({ inputTokens: 100, outputTokens: 20 })
    panel.noteTurn()
    expect(panel.render()).toMatch(/1 turn(?!s)/)
  })

  test("unknown model ⇒ cost reads 'n/a'", () => {
    const panel = make({ model: "fictional-model-9000" })
    panel.incrementTurn({ inputTokens: 1000, outputTokens: 200 })
    const line = stripAnsi(panel.render())
    expect(line).toMatch(/^n\/a /)
    expect(line).toContain("fictional-model-9000")
  })
})

// ── boxed detailed render ───────────────────────────────────────────────

describe("createCostPanel.renderDetailed(): boxed /cost form", () => {
  test("contains every documented row", () => {
    const clock = makeClock()
    const panel = make({ model: "claude-sonnet-4-6", now: clock.now })
    panel.incrementTurn({ inputTokens: 45_234, outputTokens: 12_891, cacheReadTokens: 8123 })
    panel.noteTurn()
    clock.advance(12 * 60 * 1000 + 34 * 1000) // 12m 34s
    const body = stripAnsi(panel.renderDetailed())
    expect(body).toContain("session cost")
    expect(body).toMatch(/Duration:\s+12m 34s/)
    expect(body).toMatch(/Turns:\s+1/)
    expect(body).toMatch(/Input:\s+45,234 tok/)
    expect(body).toMatch(/Output:\s+12,891 tok/)
    expect(body).toMatch(/Cache read:\s+8,123 tok/)
    expect(body).toMatch(/Total cost:\s+\$/)
    expect(body).toMatch(/Per turn avg:\s+\$/)
    expect(body).toContain("claude-sonnet-4-6")
  })

  test("per-turn avg is n/a until first known-cost turn", () => {
    const panel = make({ model: "fictional-model-9000" })
    panel.incrementTurn({ inputTokens: 100, outputTokens: 50 })
    const body = stripAnsi(panel.renderDetailed())
    expect(body).toMatch(/Total cost:\s+n\/a/)
    expect(body).toMatch(/Per turn avg:\s+n\/a/)
  })

  test("duration formats as 5s / 2m 30s / 1h 5m", () => {
    const clock = makeClock()
    const panel = make({ now: clock.now })
    clock.advance(5_000)
    expect(stripAnsi(panel.renderDetailed())).toMatch(/Duration:\s+5s/)
    clock.advance(2 * 60 * 1000 + 25 * 1000) // total 2m 30s
    expect(stripAnsi(panel.renderDetailed())).toMatch(/Duration:\s+2m 30s/)
    clock.advance(2 * 60 * 60 * 1000) // jump >1h ahead
    expect(stripAnsi(panel.renderDetailed())).toMatch(/Duration:\s+\d+h \d+m/)
  })
})

// ── disabled instance ───────────────────────────────────────────────────

describe("createCostPanel: disabled instance is fully no-op", () => {
  test("enabled=false ⇒ render + renderDetailed return ''", () => {
    const panel = make({ enabled: false })
    panel.incrementTurn({ inputTokens: 1000, outputTokens: 200, costUsd: 0.5, model: "gpt-4o" })
    // mutations are dropped when disabled — state stays pristine.
    expect(panel.snapshot().turns).toBe(0)
    expect(panel.snapshot().inputTokens).toBe(0)
    expect(panel.render()).toBe("")
    expect(panel.renderDetailed()).toBe("")
  })
})

// ── §23.5 per-model breakdown ─────────────────────────────────────────────

describe("createCostPanel.byModel(): per-model attribution (§23.5)", () => {
  test("single-model session ⇒ one bucket; renderDetailed byte-identical (no 'By model')", () => {
    const panel = make({ model: "claude-sonnet-4-6" })
    panel.incrementTurn({ inputTokens: 1000, outputTokens: 200 })
    panel.incrementTurn({ inputTokens: 500, outputTokens: 100 })
    const buckets = panel.byModel()
    expect(buckets.length).toBe(1)
    expect(buckets[0]?.model).toBe("claude-sonnet-4-6")
    expect(buckets[0]?.inputTokens).toBe(1500)
    expect(buckets[0]?.outputTokens).toBe(300)
    // Invariant: single model ⇒ NO breakdown section in the detailed box.
    expect(stripAnsi(panel.renderDetailed())).not.toContain("By model:")
  })

  test("heterogeneous session attributes tokens/cost to the active model per turn", () => {
    const panel = make({ model: "claude-sonnet-4-6" })
    panel.incrementTurn({ inputTokens: 1000, outputTokens: 200, costUsd: 0.5 })
    panel.incrementTurn({
      inputTokens: 2000,
      outputTokens: 400,
      costUsd: 0.25,
      model: "gpt-4o-mini",
    })
    panel.incrementTurn({ inputTokens: 100, outputTokens: 50, costUsd: 0.05, model: "gpt-4o-mini" })
    const buckets = panel.byModel()
    expect(buckets.length).toBe(2)
    // sorted by model id (byte) — 'claude…' < 'gpt…'
    expect(buckets.map((b) => b.model)).toEqual(["claude-sonnet-4-6", "gpt-4o-mini"])
    const sonnet = buckets.find((b) => b.model === "claude-sonnet-4-6")
    const gpt = buckets.find((b) => b.model === "gpt-4o-mini")
    expect(sonnet?.inputTokens).toBe(1000)
    expect(sonnet?.costUsd).toBeCloseTo(0.5, 6)
    expect(gpt?.inputTokens).toBe(2100)
    expect(gpt?.costUsd).toBeCloseTo(0.3, 6)
  })

  test("heterogeneous session ⇒ renderDetailed includes a 'By model' section", () => {
    const panel = make({ model: "claude-sonnet-4-6" })
    panel.incrementTurn({ inputTokens: 1000, outputTokens: 200, costUsd: 0.5 })
    panel.incrementTurn({
      inputTokens: 2000,
      outputTokens: 400,
      costUsd: 0.25,
      model: "gpt-4o-mini",
    })
    const body = stripAnsi(panel.renderDetailed())
    expect(body).toContain("By model:")
    expect(body).toContain("claude-sonnet-4-6:")
    expect(body).toContain("gpt-4o-mini:")
  })

  test("unknown-model turn contributes tokens but null cost to its bucket", () => {
    const panel = make({ model: "fictional-9000" })
    panel.incrementTurn({ inputTokens: 100, outputTokens: 50 })
    const b = panel.byModel()[0]
    expect(b?.inputTokens).toBe(100)
    expect(b?.costUsd).toBeNull()
  })

  test("disabled instance ⇒ byModel() empty", () => {
    const panel = make({ enabled: false })
    panel.incrementTurn({ inputTokens: 100, outputTokens: 50, costUsd: 0.5 })
    expect(panel.byModel()).toEqual([])
  })
})

// ── §23.5 audit hardening (model sanitize / cost clamp / fmt / cache-read) ──

describe("createCostPanel: audit hardening", () => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control bytes are stripped
  const CONTROL = /[\x00-\x1f\x7f-\x9f]/

  test("model id with ESC/OSC bytes is sanitized at construction (no terminal injection)", () => {
    const panel = make({ model: "evil\x1b]0;PWNED\x07\nFAKE" })
    expect(CONTROL.test(panel.snapshot().model)).toBe(false)
    expect(CONTROL.test(panel.render())).toBe(false)
  })

  test("a hostile model id on a usage delta is sanitized in the per-model row", () => {
    // The model on a usage event is provider-supplied text, and the per-model
    // rows print it. Sanitization is at the RENDER boundary now (the bucket key
    // stays verbatim so the accounting stays exact).
    const panel = make({ model: "ok" })
    panel.incrementTurn({ inputTokens: 10, outputTokens: 0, model: "x\x1b[31mRED" })
    const row = panel.byModel().find((b) => b.model.startsWith("x"))
    // only the ESC byte is stripped; the literal "[31m" text remains
    expect(row?.model).toBe("x[31mRED")
    expect(panel.renderDetailed()).not.toContain("\x1b[31m")
  })

  test("negative caller cost is clamped to 0 (no negative bill)", () => {
    const panel = make({ model: "claude-sonnet-4-6" })
    panel.incrementTurn({ inputTokens: 1, outputTokens: 1, costUsd: 1 })
    panel.incrementTurn({ inputTokens: 1, outputTokens: 1, costUsd: -5 })
    expect(panel.snapshot().totalCostUsd).toBeCloseTo(1, 6)
    expect(panel.byModel()[0]?.costUsd).toBeCloseTo(1, 6)
  })

  test("formatTokens: <10k stays comma-grouped, >=10k goes k-form (via render)", () => {
    const a = make()
    a.incrementTurn({ inputTokens: 9999, outputTokens: 0 })
    expect(stripAnsi(a.render())).toContain("9,999 in")
    const b = make()
    b.incrementTurn({ inputTokens: 12_000, outputTokens: 0 })
    expect(stripAnsi(b.render())).toContain("12.0k in")
  })

  test("per-model breakdown row includes cache-read (reconciles with aggregate)", () => {
    const panel = make({ model: "claude-sonnet-4-6" })
    panel.incrementTurn({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      costUsd: 0.5,
    })
    panel.incrementTurn({
      inputTokens: 2000,
      outputTokens: 400,
      cacheReadTokens: 800,
      costUsd: 0.25,
      model: "gpt-4o-mini",
    })
    const body = stripAnsi(panel.renderDetailed())
    expect(body).toMatch(/claude-sonnet-4-6:.*500 cache/)
    expect(body).toMatch(/gpt-4o-mini:.*800 cache/)
  })
})

// ── color-OFF determinism ───────────────────────────────────────────────

describe("createCostPanel: deterministic render under color=none", () => {
  test("render() output contains no ANSI escapes when policy=none", () => {
    setColorPolicy("off")
    const panel = make()
    panel.incrementTurn({ inputTokens: 100, outputTokens: 50 })
    const line = panel.render()
    expect(line).toBe(stripAnsi(line))
  })

  test("renderDetailed() output contains no ANSI escapes when policy=none", () => {
    setColorPolicy("off")
    const panel = make()
    panel.incrementTurn({ inputTokens: 100, outputTokens: 50 })
    const body = panel.renderDetailed()
    expect(body).toBe(stripAnsi(body))
  })
})
