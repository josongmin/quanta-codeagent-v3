/**
 * clampDials tests — propositional clamping + surface log line on every clamp.
 *
 * The logger writes a `[budget-cap]` line to stderr; we capture stderr via
 * process.stderr.write monkey-patching for the duration of the test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type BudgetClampEvent, clampDials } from "@/agent"

const captureStderr = (
  fn: () => void,
): { lines: string[] } => {
  const original = process.stderr.write.bind(process.stderr)
  const lines: string[] = []
  ;(process.stderr as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ): boolean => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }
  try {
    fn()
  } finally {
    process.stderr.write = original
  }
  return { lines }
}

describe("clampDials — propositional clamping", () => {
  // Ensure logger output is enabled at warn threshold (default) by clearing
  // any test-suite-wide override; we don't import runtime-config here.
  const PRIOR_LOG_LEVEL = process.env.QUANTA_LOG_LEVEL
  beforeEach(() => {
    process.env.QUANTA_LOG_LEVEL = "debug"
  })
  afterEach(() => {
    if (PRIOR_LOG_LEVEL === undefined) delete process.env.QUANTA_LOG_LEVEL
    else process.env.QUANTA_LOG_LEVEL = PRIOR_LOG_LEVEL
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
})
