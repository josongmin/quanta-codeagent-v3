import { describe, expect, test } from "bun:test"
import {
  buildRatelimitNoticePort,
  isRatelimitNoticeEnabled,
} from "../../../src/apps/cli/ratelimit-notice"
import type { StatusBar } from "../../../src/apps/cli/status-bar"
import type { AgentEvent } from "../../../src/stream"

/**
 * P27 hellgate — transient rate-limit notice renderer (CLI surface).
 *
 * Contract pins:
 *   (a) malformed/partial snapshot (NaN / negative / missing) ⇒ graceful skip,
 *       no throw, no paint.
 *   (b) knob OFF ⇒ `isRatelimitNoticeEnabled` false (default-OFF: unset is OFF).
 *   (c) the notice fires ONLY on the slice's own REACHED signal — the
 *       empty-window predicate (`remaining <= 0`) that `policy.ts::proactiveDelayMs`
 *       derives backoff from. A window with headroom NEVER surfaces (no invented
 *       percent).
 *   (d) a THROWING statusBar is swallowed (tee isolation) — the port's emit must
 *       not propagate.
 */

/** Recording StatusBar stub — captures `transient` calls. */
const recordingBar = (): { bar: StatusBar; calls: Array<{ text: string; ms?: number }> } => {
  const calls: Array<{ text: string; ms?: number }> = []
  const bar: StatusBar = {
    setDefault: () => undefined,
    transient: (text: string, ms?: number) => {
      calls.push(ms === undefined ? { text } : { text, ms })
    },
    clearTransient: () => undefined,
    teardown: () => undefined,
  }
  return { bar, calls }
}

/** A StatusBar whose `transient` THROWS — proves tee isolation. */
const throwingBar: StatusBar = {
  setDefault: () => undefined,
  transient: () => {
    throw new Error("statusBar exploded")
  },
  clearTransient: () => undefined,
  teardown: () => undefined,
}

const snap = (
  fields: Partial<{
    requestsRemaining: number
    requestsResetMs: number
    tokensRemaining: number
    tokensResetMs: number
    observedAt: number
  }>,
): Extract<AgentEvent, { type: "ratelimit_snapshot" }> => ({
  type: "ratelimit_snapshot",
  observedAt: 1_000,
  ...fields,
})

// =============================================================================
// (b) knob gate — default-OFF
// =============================================================================

describe("P27 isRatelimitNoticeEnabled — default-OFF gate", () => {
  test("unset ⇒ OFF (operator must opt in)", () => {
    expect(isRatelimitNoticeEnabled({})).toBe(false)
  })

  test("falsy tokens ⇒ OFF", () => {
    for (const v of ["0", "false", "off", "no", "", "  "]) {
      expect(isRatelimitNoticeEnabled({ QUANTA_RATELIMIT_NOTICE: v })).toBe(false)
    }
  })

  test("truthy tokens ⇒ ON", () => {
    for (const v of ["1", "on", "true", "yes", "anything"]) {
      expect(isRatelimitNoticeEnabled({ QUANTA_RATELIMIT_NOTICE: v })).toBe(true)
    }
  })

  test("case-insensitive + whitespace-trimmed", () => {
    expect(isRatelimitNoticeEnabled({ QUANTA_RATELIMIT_NOTICE: "  OFF  " })).toBe(false)
    expect(isRatelimitNoticeEnabled({ QUANTA_RATELIMIT_NOTICE: " On " })).toBe(true)
  })
})

// =============================================================================
// (c) fires ONLY on the genuine reached signal
// =============================================================================

describe("P27 buildRatelimitNoticePort — fires only on reached (empty window)", () => {
  test("tokens empty (remaining 0) ⇒ paints once", () => {
    const { bar, calls } = recordingBar()
    buildRatelimitNoticePort(bar).emit(snap({ tokensRemaining: 0, tokensResetMs: 3 * 3600_000 }))
    expect(calls.length).toBe(1)
    expect(calls[0]?.text).toContain("토큰 한도")
    expect(calls[0]?.text).toContain("resets 3h")
  })

  test("requests empty ⇒ paints, labels 요청 한도", () => {
    const { bar, calls } = recordingBar()
    buildRatelimitNoticePort(bar).emit(snap({ requestsRemaining: 0, requestsResetMs: 90_000 }))
    expect(calls.length).toBe(1)
    expect(calls[0]?.text).toContain("요청 한도")
    expect(calls[0]?.text).toContain("resets 2m") // round(90s)=2m
  })

  test("both empty ⇒ 한도 reached, TIGHTEST reset wins", () => {
    const { bar, calls } = recordingBar()
    buildRatelimitNoticePort(bar).emit(
      snap({
        tokensRemaining: 0,
        tokensResetMs: 10 * 3600_000,
        requestsRemaining: 0,
        requestsResetMs: 30_000,
      }),
    )
    expect(calls[0]?.text).toContain("한도 reached")
    expect(calls[0]?.text).toContain("resets 30s") // min(10h, 30s)
  })

  test("HEADROOM (remaining > 0) ⇒ NEVER paints (no invented percent)", () => {
    const { bar, calls } = recordingBar()
    // 1 token left of a million is still NOT empty — the provider has not
    // reported the window out, so the renderer stays silent.
    buildRatelimitNoticePort(bar).emit(
      snap({ tokensRemaining: 1, tokensResetMs: 1000, requestsRemaining: 500 }),
    )
    expect(calls.length).toBe(0)
  })

  test("empty window but NO reset ⇒ still paints (reached), no reset suffix", () => {
    const { bar, calls } = recordingBar()
    buildRatelimitNoticePort(bar).emit(snap({ tokensRemaining: 0 }))
    expect(calls.length).toBe(1)
    expect(calls[0]?.text).toContain("토큰 한도")
    expect(calls[0]?.text).not.toContain("resets")
  })

  test("custom ttl is forwarded to transient", () => {
    const { bar, calls } = recordingBar()
    buildRatelimitNoticePort(bar, 9999).emit(snap({ tokensRemaining: 0 }))
    expect(calls[0]?.ms).toBe(9999)
  })
})

// =============================================================================
// (a) malformed / partial ⇒ graceful skip, no throw, no paint
// =============================================================================

describe("P27 buildRatelimitNoticePort — malformed/partial graceful skip", () => {
  test("all-absent snapshot ⇒ no paint", () => {
    const { bar, calls } = recordingBar()
    buildRatelimitNoticePort(bar).emit(snap({}))
    expect(calls.length).toBe(0)
  })

  test("NaN remaining is NOT <= 0 ⇒ no paint, no throw", () => {
    const { bar, calls } = recordingBar()
    // NaN <= 0 is false, so the empty-window predicate skips it.
    expect(() =>
      buildRatelimitNoticePort(bar).emit(snap({ tokensRemaining: Number.NaN })),
    ).not.toThrow()
    expect(calls.length).toBe(0)
  })

  test("negative remaining counts as empty (<= 0) ⇒ paints (graceful, no throw)", () => {
    const { bar, calls } = recordingBar()
    // A negative remaining is the provider over-reporting "out"; treated as
    // reached (the same monotone <= 0 predicate policy.ts uses). No throw.
    expect(() => buildRatelimitNoticePort(bar).emit(snap({ tokensRemaining: -5 }))).not.toThrow()
    expect(calls.length).toBe(1)
  })

  test("non-finite / negative reset is dropped from the suffix (no NaN text)", () => {
    const { bar, calls } = recordingBar()
    buildRatelimitNoticePort(bar).emit(
      snap({ tokensRemaining: 0, tokensResetMs: Number.NaN, requestsRemaining: 0 }),
    )
    expect(calls[0]?.text).not.toContain("NaN")
    expect(calls[0]?.text).not.toContain("resets")
  })

  test("non-ratelimit events are ignored (port is a no-op for them)", () => {
    const { bar, calls } = recordingBar()
    const port = buildRatelimitNoticePort(bar)
    port.emit({ type: "assistant_text", delta: "hi" } as AgentEvent)
    port.emit({ type: "done", reason: "ok", turns: 1 } as AgentEvent)
    expect(calls.length).toBe(0)
  })
})

// =============================================================================
// (d) tee isolation — a throwing statusBar is swallowed
// =============================================================================

describe("P27 buildRatelimitNoticePort — tee isolation", () => {
  test("a throwing statusBar.transient does NOT propagate out of emit", () => {
    const port = buildRatelimitNoticePort(throwingBar)
    expect(() => port.emit(snap({ tokensRemaining: 0, tokensResetMs: 1000 }))).not.toThrow()
  })
})
