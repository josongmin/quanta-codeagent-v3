import { describe, expect, it } from "bun:test"
import {
  DEFAULT_LSP_RSS_BUDGET_MB,
  parsePsRows,
  resolveLspRssBudgetMb,
  startLspRssWatchdog,
  sumProcessTreeRssKb,
} from "../../src/lsp/server-rss-watchdog"

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe("resolveLspRssBudgetMb", () => {
  it("defaults ON when unset/empty/garbage (never silently uncapped)", () => {
    expect(resolveLspRssBudgetMb({})).toBe(DEFAULT_LSP_RSS_BUDGET_MB)
    expect(resolveLspRssBudgetMb({ QUANTA_LSP_RSS_BUDGET_MB: "" })).toBe(DEFAULT_LSP_RSS_BUDGET_MB)
    expect(resolveLspRssBudgetMb({ QUANTA_LSP_RSS_BUDGET_MB: "abc" })).toBe(
      DEFAULT_LSP_RSS_BUDGET_MB,
    )
    expect(resolveLspRssBudgetMb({ QUANTA_LSP_RSS_BUDGET_MB: "-5" })).toBe(
      DEFAULT_LSP_RSS_BUDGET_MB,
    )
  })
  it("0 is the explicit opt-out; positive wins", () => {
    expect(resolveLspRssBudgetMb({ QUANTA_LSP_RSS_BUDGET_MB: "0" })).toBe(0)
    expect(resolveLspRssBudgetMb({ QUANTA_LSP_RSS_BUDGET_MB: "12000" })).toBe(12000)
  })
})

describe("sumProcessTreeRssKb (pyright = launcher + ballooning node CHILD)", () => {
  // The exact box topology that defeated the root-pid-only watchdog:
  // pyright-langserver (python wrapper, flat ~21MB) -> node langserver (balloons).
  const snapshot = `
  3434  3000   194000
  4781  3434    21000
  4782  4781 28000000
  9999  3000     5000
`
  it("sums the launcher AND its ballooning node child (root-pid alone misses it)", () => {
    const rows = parsePsRows(snapshot)
    // root = the pyright-langserver wrapper (4781); its node child (4782) balloons
    expect(sumProcessTreeRssKb(rows, 4781)).toBe(21000 + 28000000)
    // proof of the bug: the wrapper ALONE is tiny — a root-only watch never fires
    expect(sumProcessTreeRssKb([rows.find((r) => r.pid === 4781) as never], 4781)).toBe(21000)
  })
  it("returns null when the root pid is gone from the snapshot", () => {
    expect(sumProcessTreeRssKb(parsePsRows(snapshot), 5555)).toBeNull()
  })
  it("terminates on a ppid cycle (PID reuse) instead of looping forever", () => {
    const cyclic = parsePsRows("10 20 100\n20 10 200")
    expect(sumProcessTreeRssKb(cyclic, 10)).toBe(300)
  })
})

describe("startLspRssWatchdog", () => {
  it("fires onExceed exactly once when RSS crosses the budget, then stops polling", async () => {
    // RSS climbs: 1000, 2000, 9000(>budget) — like pyright warm-up indexing ramp.
    const series = [1000, 2000, 9000, 9000, 9000]
    let i = 0
    const sampled: number[] = []
    const sampler = async (_pid: number): Promise<number | null> => {
      const v = series[Math.min(i, series.length - 1)] as number
      i += 1
      sampled.push(v)
      return v
    }
    const exceeded: number[] = []
    const h = startLspRssWatchdog({
      pid: 4242,
      budgetMb: 8192,
      intervalMs: 5,
      sampler,
      onExceed: (rss) => {
        exceeded.push(rss)
      },
    })
    await wait(1_000)
    h.stop()
    expect(exceeded).toEqual([9000]) // fired exactly once, at the first over-budget sample
    // after firing it stopped — no further samples beyond the trip
    const samplesAtTrip = sampled.indexOf(9000) + 1
    expect(sampled.length).toBe(samplesAtTrip)
  })

  it("never fires while RSS stays under budget", async () => {
    const sampler = async (): Promise<number | null> => 3000 // steady, healthy
    let calls = 0
    const h = startLspRssWatchdog({
      pid: 1,
      budgetMb: 8192,
      intervalMs: 5,
      sampler,
      onExceed: () => {
        calls += 1
      },
    })
    await wait(60)
    h.stop()
    expect(calls).toBe(0)
  })

  it("stops cleanly when the process is gone (sampler returns null)", async () => {
    let polls = 0
    const sampler = async (): Promise<number | null> => {
      polls += 1
      return null // process gone
    }
    let calls = 0
    const h = startLspRssWatchdog({
      pid: 1,
      budgetMb: 8192,
      intervalMs: 5,
      sampler,
      onExceed: () => {
        calls += 1
      },
    })
    await wait(60)
    h.stop()
    expect(calls).toBe(0)
    expect(polls).toBe(1) // one poll saw null → stopped, no busy loop
  })

  it("budget<=0 is a no-op handle (watchdog disabled)", async () => {
    let polled = false
    const h = startLspRssWatchdog({
      pid: 1,
      budgetMb: 0,
      intervalMs: 5,
      sampler: async () => {
        polled = true
        return 99999
      },
      onExceed: () => {
        throw new Error("must not fire when disabled")
      },
    })
    await wait(40)
    h.stop()
    expect(polled).toBe(false)
  })
})
