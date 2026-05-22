import { describe, expect, test } from "bun:test"
import { TurnWorkMetricsCollector } from "@/agent/work-metrics-collector"

describe("TurnWorkMetricsCollector — empty", () => {
  test("empty collector reports all zeros, no cost, no cacheRead", () => {
    const c = new TurnWorkMetricsCollector()
    const m = c.finalize()
    expect(m).toEqual({
      diffMap: [],
      agentActions: 0,
      linesRead: 0,
      tokensInput: 0,
      tokensOutput: 0,
    })
    expect(m.estimatedCostUsd).toBeUndefined()
    expect(m.cacheReadTokens).toBeUndefined()
  })

  test("finalize with unknown model still leaves cost undefined", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordUsage({ tokensInput: 100, tokensOutput: 50 })
    const m = c.finalize("mystery-model")
    expect(m.tokensInput).toBe(100)
    expect(m.tokensOutput).toBe(50)
    expect(m.estimatedCostUsd).toBeUndefined()
  })
})

describe("TurnWorkMetricsCollector — recordToolCall", () => {
  test("increments agentActions per call regardless of name", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordToolCall("read", { ok: true })
    c.recordToolCall("write", { ok: false })
    c.recordToolCall("bash")
    expect(c.finalize().agentActions).toBe(3)
  })
})

describe("TurnWorkMetricsCollector — recordUsage", () => {
  test("sums input/output across multiple usage reports", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordUsage({ tokensInput: 100, tokensOutput: 40 })
    c.recordUsage({ tokensInput: 60, tokensOutput: 30 })
    const m = c.finalize()
    expect(m.tokensInput).toBe(160)
    expect(m.tokensOutput).toBe(70)
  })

  test("sums cacheReadTokens lazily — absent on every call ⇒ undefined", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordUsage({ tokensInput: 10, tokensOutput: 5 })
    c.recordUsage({ tokensInput: 10, tokensOutput: 5 })
    expect(c.finalize().cacheReadTokens).toBeUndefined()
  })

  test("sums cacheReadTokens once observed (mixed undefined + present)", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordUsage({ tokensInput: 10, tokensOutput: 5 })
    c.recordUsage({ tokensInput: 10, tokensOutput: 5, cacheReadTokens: 7 })
    c.recordUsage({ tokensInput: 10, tokensOutput: 5, cacheReadTokens: 3 })
    expect(c.finalize().cacheReadTokens).toBe(10)
  })
})

describe("TurnWorkMetricsCollector — recordRead", () => {
  test("non-read tool name ⇒ ignored", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordRead("write", "one\ntwo\nthree")
    expect(c.finalize().linesRead).toBe(0)
  })

  test("read with text payload counts lines (trailing newline = N lines)", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordRead("read", "1\tline-one\n2\tline-two\n3\tline-three\n")
    expect(c.finalize().linesRead).toBe(3)
  })

  test("read with text payload (no trailing newline) counts lines correctly", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordRead("read", "1\ta\n2\tb")
    expect(c.finalize().linesRead).toBe(2)
  })

  test("read accumulates across multiple calls", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordRead("read", "a\nb\nc")
    c.recordRead("read", "d\ne")
    expect(c.finalize().linesRead).toBe(5)
  })

  test("read accepts {output:string} envelope shape", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordRead("read", { output: "x\ny\nz\n" })
    expect(c.finalize().linesRead).toBe(3)
  })

  test("read with empty string ⇒ 0 lines (no spurious bump)", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordRead("read", "")
    expect(c.finalize().linesRead).toBe(0)
  })

  test("read with non-string/non-envelope ⇒ silently skipped", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordRead("read", 42)
    c.recordRead("read", null)
    c.recordRead("read", undefined)
    expect(c.finalize().linesRead).toBe(0)
  })
})

describe("TurnWorkMetricsCollector — recordDiff", () => {
  test("parses and accumulates per-file diff stats", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordDiff("12\t3\tsrc/a.ts\n0\t5\tsrc/b.ts\n")
    const m = c.finalize()
    expect(m.diffMap).toEqual([
      { file: "src/a.ts", addedLines: 12, removedLines: 3 },
      { file: "src/b.ts", addedLines: 0, removedLines: 5 },
    ])
  })

  test("collapses binary `-\\t-\\tpath` rows to 0/0", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordDiff("-\t-\tassets/logo.png\n")
    expect(c.finalize().diffMap).toEqual([
      { file: "assets/logo.png", addedLines: 0, removedLines: 0 },
    ])
  })

  test("accumulates same-file rows across multiple recordDiff calls", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordDiff("10\t1\tsrc/a.ts\n")
    c.recordDiff("3\t2\tsrc/a.ts\n7\t0\tsrc/b.ts\n")
    const m = c.finalize()
    const a = m.diffMap.find((d) => d.file === "src/a.ts")
    const b = m.diffMap.find((d) => d.file === "src/b.ts")
    expect(a).toEqual({ file: "src/a.ts", addedLines: 13, removedLines: 3 })
    expect(b).toEqual({ file: "src/b.ts", addedLines: 7, removedLines: 0 })
  })

  test("empty input is a no-op", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordDiff("")
    expect(c.finalize().diffMap).toEqual([])
  })
})

describe("TurnWorkMetricsCollector — finalize", () => {
  test("known model ⇒ estimatedCostUsd derived from pricing table", () => {
    const c = new TurnWorkMetricsCollector()
    // 1M input tokens on claude-opus-4-7 ⇒ $15 input cost, $0 output cost.
    c.recordUsage({ tokensInput: 1_000_000, tokensOutput: 0 })
    const m = c.finalize("claude-opus-4-7")
    expect(m.estimatedCostUsd).toBe(15)
  })

  test("unknown model ⇒ estimatedCostUsd undefined", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordUsage({ tokensInput: 100, tokensOutput: 100 })
    const m = c.finalize("nonexistent-model")
    expect(m.estimatedCostUsd).toBeUndefined()
  })

  test("absent model ⇒ estimatedCostUsd undefined", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordUsage({ tokensInput: 100, tokensOutput: 100 })
    const m = c.finalize()
    expect(m.estimatedCostUsd).toBeUndefined()
  })

  test("idempotent: repeated finalize yields equal snapshots", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordToolCall("read")
    c.recordUsage({ tokensInput: 50, tokensOutput: 25, cacheReadTokens: 5 })
    c.recordRead("read", "a\nb\nc\n")
    c.recordDiff("4\t1\tsrc/x.ts\n")
    const first = c.finalize("claude-opus-4-7")
    const second = c.finalize("claude-opus-4-7")
    expect(second).toEqual(first)
    // Defensive: the returned diffMap arrays must not alias internal state —
    // mutating one snapshot must NOT bleed into the other or into the collector.
    second.diffMap.push({ file: "evil.ts", addedLines: 999, removedLines: 0 })
    const third = c.finalize("claude-opus-4-7")
    expect(third).toEqual(first)
  })

  test("rollup combines all signals into a single WorkMetrics", () => {
    const c = new TurnWorkMetricsCollector()
    c.recordToolCall("read")
    c.recordToolCall("bash")
    c.recordRead("read", "1\ta\n2\tb\n3\tc\n")
    c.recordUsage({ tokensInput: 1200, tokensOutput: 800, cacheReadTokens: 100 })
    c.recordDiff("40\t5\ta.ts\n2\t2\tb.ts\n0\t0\tc.ts\n")
    const m = c.finalize("claude-sonnet-4-6")
    expect(m.agentActions).toBe(2)
    expect(m.linesRead).toBe(3)
    expect(m.tokensInput).toBe(1200)
    expect(m.tokensOutput).toBe(800)
    expect(m.cacheReadTokens).toBe(100)
    expect(m.diffMap).toHaveLength(3)
    // Sonnet (pricing v2 — Anthropic cacheRead billed at the discounted
    // cache-read rate $0.3/M = 0.1×in, NOT the full input rate):
    //   inCost     = 1200 * 3   / 1e6 = 0.0036
    //   cacheCost  = 100  * 0.3 / 1e6 = 0.00003
    //   outCost    = 800  * 15  / 1e6 = 0.012
    //   total                          = 0.01563
    expect(m.estimatedCostUsd).toBeCloseTo(0.01563, 6)
  })
})
