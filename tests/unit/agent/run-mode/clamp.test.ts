/**
 * clampDials tests — propositional clamping + surface log line on every clamp.
 *
 * The clamp logger writes its `[budget-cap]` line through the host-owned
 * terminal port (`@/shared` → terminal-io), NOT directly to `process.stderr`.
 * The default terminal sink is a no-op (libraries/tests don't own the
 * terminal), so spying `process.stderr.write` captures nothing. We instead
 * register a capturing `TerminalIo` sink for the duration of the call and
 * disable the log rate-limiter so capture is deterministic regardless of test
 * ordering / cross-test bucket state — the structural seam, no global spying.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type BudgetClampEvent, clampDials } from "@/agent"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { setTerminalIo } from "@/shared/terminal-io"

const captureStderr = (fn: () => void): { lines: string[] } => {
  const lines: string[] = []
  const priorRateLimit = process.env.QUANTA_LOG_RATE_LIMIT
  // Disable rate-limiting so a clamp line is never coalesced/suppressed by a
  // sibling test that warmed the same bucket — makes capture deterministic.
  // `runtimeConfig()` is cached + frozen, so the env change only takes effect
  // after an explicit cache reset.
  process.env.QUANTA_LOG_RATE_LIMIT = "off"
  __resetRuntimeConfig()
  setTerminalIo({
    stdout: () => {},
    stderr: (chunk: string) => {
      lines.push(chunk)
    },
    stdoutIsTTY: false,
    stderrIsTTY: false,
  })
  try {
    fn()
  } finally {
    setTerminalIo(null)
    if (priorRateLimit === undefined) delete process.env.QUANTA_LOG_RATE_LIMIT
    else process.env.QUANTA_LOG_RATE_LIMIT = priorRateLimit
    __resetRuntimeConfig()
  }
  return { lines }
}

describe("clampDials — propositional clamping", () => {
  // Ensure logger output clears the threshold gate (warn must be emitted).
  // The runtime config is cached + frozen, so we reset the cache after
  // mutating the env so the change actually takes effect for this suite.
  const PRIOR_LOG_LEVEL = process.env.QUANTA_LOG_LEVEL
  beforeEach(() => {
    process.env.QUANTA_LOG_LEVEL = "debug"
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (PRIOR_LOG_LEVEL === undefined) delete process.env.QUANTA_LOG_LEVEL
    else process.env.QUANTA_LOG_LEVEL = PRIOR_LOG_LEVEL
    __resetRuntimeConfig()
  })

  test("requested below cap passes through unchanged", () => {
    const out = clampDials({ maxTurns: 5 }, { maxTurns: 100 })
    expect(out.maxTurns).toBe(5)
  })

  test("requested equal to cap passes through (strict greater-than)", () => {
    const out = clampDials({ maxTurns: 100 }, { maxTurns: 100 })
    expect(out.maxTurns).toBe(100)
  })

  test("requested above cap clamps to cap", () => {
    const out = clampDials({ maxWallClockMs: 999_999_999 }, { maxWallClockMs: 1_800_000 })
    expect(out.maxWallClockMs).toBe(1_800_000)
  })

  test("absent request preserves cap (cap-as-default)", () => {
    const out = clampDials({}, { maxTurns: 50 })
    expect(out.maxTurns).toBe(50)
  })

  test("absent cap passes request through", () => {
    const out = clampDials({ maxTurns: 9999 }, {})
    expect(out.maxTurns).toBe(9999)
  })

  test("clamp emits a [budget-cap] log line on stderr", () => {
    const { lines } = captureStderr(() => {
      clampDials({ maxWallClockMs: 999_999_999 }, { maxWallClockMs: 1_800_000 })
    })
    const joined = lines.join("")
    expect(joined).toContain("[budget-cap]")
    expect(joined).toContain("maxWallClockMs")
  })

  test("no clamp = no log line", () => {
    const { lines } = captureStderr(() => {
      clampDials({ maxTurns: 5 }, { maxTurns: 100 })
    })
    const joined = lines.join("")
    expect(joined).not.toContain("[budget-cap]")
  })

  test("onClamp callback fires structured event for each clamp", () => {
    const events: BudgetClampEvent[] = []
    clampDials(
      { maxWallClockMs: 999_999, maxTurns: 100, maxToolCalls: 5000 },
      { maxWallClockMs: 1000, maxTurns: 50 },
      (e) => events.push(e),
    )
    // maxTurns 100>50 ⇒ clamp; maxWallClockMs 999_999>1000 ⇒ clamp; maxToolCalls has no cap.
    expect(events.length).toBe(2)
    const dials = events.map((e) => e.dial).sort()
    expect(dials).toEqual(["maxTurns", "maxWallClockMs"])
  })

  test("returns a fresh object — inputs are not mutated", () => {
    const dials = { maxTurns: 10 }
    const out = clampDials(dials, { maxTurns: 5 })
    expect(out).not.toBe(dials)
    expect(dials.maxTurns).toBe(10) // unchanged
    expect(out.maxTurns).toBe(5)
  })

  test("clamps multiple fields independently", () => {
    const out = clampDials(
      { maxTurns: 1000, maxToolCalls: 50_000, maxCostUsd: 100 },
      { maxTurns: 50, maxToolCalls: 100, maxCostUsd: 5 },
    )
    expect(out.maxTurns).toBe(50)
    expect(out.maxToolCalls).toBe(100)
    expect(out.maxCostUsd).toBe(5)
  })

  test("NaN / non-finite / negative requested or cap is dropped (treated as absent)", () => {
    // A NaN/Inf/negative dial would otherwise poison the meter's comparisons
    // (NaN > dial === false silently disables a cap) or set a nonsensical
    // negative budget. The guard drops the invalid value rather than clamping.
    expect(clampDials({ maxTurns: Number.NaN }, { maxTurns: 100 }).maxTurns).toBe(100)
    expect(clampDials({ maxTurns: Number.POSITIVE_INFINITY }, { maxTurns: 100 }).maxTurns).toBe(100)
    expect(clampDials({ maxTurns: -5 }, { maxTurns: 100 }).maxTurns).toBe(100)
    // An invalid CAP is treated as absent ⇒ a valid request passes through.
    expect(clampDials({ maxTurns: 7 }, { maxTurns: Number.NaN }).maxTurns).toBe(7)
    expect(clampDials({ maxTurns: 7 }, { maxTurns: -1 }).maxTurns).toBe(7)
    // Both invalid ⇒ field is dropped entirely (undefined).
    expect(clampDials({ maxTurns: Number.NaN }, { maxTurns: Number.NaN }).maxTurns).toBeUndefined()
  })

  test("invalid request does NOT emit a [budget-cap] clamp log line", () => {
    const { lines } = captureStderr(() => {
      clampDials({ maxTurns: Number.NaN }, { maxTurns: 100 })
    })
    expect(lines.join("")).not.toContain("[budget-cap]")
  })

  test("valid positive inputs are unaffected by the finiteness guard", () => {
    const out = clampDials({ maxTurns: 30, maxCostUsd: 0 }, { maxTurns: 50, maxCostUsd: 5 })
    expect(out.maxTurns).toBe(30)
    // 0 is a valid non-negative budget and must pass through.
    expect(out.maxCostUsd).toBe(0)
  })
})
