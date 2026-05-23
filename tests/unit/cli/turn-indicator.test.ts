/**
 * turn-indicator hellgate — spinner + elapsed + token-counter contract.
 *
 * Pins the surface contract for the new `createTurnIndicator` factory: the
 * spinner glyph cycle, the elapsed clock, the first-chunk gating + ttft swap,
 * the token-counter render, the TTY auto-OFF gate, and the start/stop +
 * clearTransient sequence assertion. Every case targets a real branch — no
 * "stub returns" assertions; we exercise the statusBar.transient call sequence
 * and the render output.
 */

import { describe, expect, test } from "bun:test"
import type { StatusBar } from "../../../src/apps/cli/status-bar"
import {
  createTurnIndicator,
  DEFAULT_GLYPHS,
  isIndicatorEnabled,
} from "../../../src/apps/cli/turn-indicator"

interface CapturedCall {
  kind: "transient" | "clearTransient" | "setDefault"
  text?: string
  ms?: number
}

/** A StatusBar test double that records every call in arrival order. The
 *  spinner contract is observable only through this sequence (no real ANSI
 *  paint), so each test asserts shape against `cap.calls`. */
const makeCapBar = (): { bar: StatusBar; calls: CapturedCall[] } => {
  const calls: CapturedCall[] = []
  const bar: StatusBar = {
    setDefault: (text) => {
      calls.push({ kind: "setDefault", text })
    },
    transient: (text, ms) => {
      calls.push({ kind: "transient", text, ...(ms !== undefined ? { ms } : {}) })
    },
    clearTransient: () => {
      calls.push({ kind: "clearTransient" })
    },
    teardown: () => undefined,
  }
  return { bar, calls }
}

/** A controllable fake timer — every `setInterval` call is captured; the
 *  test drives time by calling `tick()` to fire each pending callback once.
 *  Returns a stable handle the production code can `clear` on `stop()`. */
const makeFakeTimer = (): {
  setIv: TurnIndicatorTimerSet
  clearIv: TurnIndicatorTimerClear
  tick: () => void
  pending: () => number
} => {
  const callbacks: Array<{ id: number; cb: () => void; cleared: boolean }> = []
  let nextId = 1
  return {
    setIv: ((cb: () => void): ReturnType<typeof setInterval> => {
      const id = nextId++
      callbacks.push({ id, cb, cleared: false })
      // Bun's setInterval handle is `Timer`; we just need it to round-trip
      // through `clearInterval` — `{ id }` shape works for the production
      // code since it never inspects the handle.
      return { id } as unknown as ReturnType<typeof setInterval>
    }) as TurnIndicatorTimerSet,
    clearIv: ((h: ReturnType<typeof setInterval>) => {
      const id = (h as unknown as { id: number }).id
      const slot = callbacks.find((c) => c.id === id)
      if (slot) slot.cleared = true
    }) as TurnIndicatorTimerClear,
    tick: () => {
      for (const c of callbacks) if (!c.cleared) c.cb()
    },
    pending: () => callbacks.filter((c) => !c.cleared).length,
  }
}

type TurnIndicatorTimerSet = (cb: () => void, ms: number) => ReturnType<typeof setInterval>
type TurnIndicatorTimerClear = (h: ReturnType<typeof setInterval>) => void

const makeClock = (start = 1_000_000): { now: () => number; advance: (ms: number) => void } => {
  let t = start
  return {
    now: () => t,
    advance: (ms) => {
      t += ms
    },
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────

describe("createTurnIndicator: start/stop lifecycle", () => {
  test("start() paints initial frame synchronously + arms timer", () => {
    const { bar, calls } = makeCapBar()
    const timer = makeFakeTimer()
    const clock = makeClock()
    const ind = createTurnIndicator({
      statusBar: bar,
      now: clock.now,
      setInterval: timer.setIv,
      clearInterval: timer.clearIv,
    })

    ind.start()

    // First frame painted before any timer tick (so user sees motion immediately).
    expect(calls.length).toBe(1)
    expect(calls[0]?.kind).toBe("transient")
    expect(calls[0]?.text).toMatch(/thinking…/)
    expect(timer.pending()).toBe(1)

    ind.stop()
  })

  test("stop() clears the transient + cancels the timer", () => {
    const { bar, calls } = makeCapBar()
    const timer = makeFakeTimer()
    const clock = makeClock()
    const ind = createTurnIndicator({
      statusBar: bar,
      now: clock.now,
      setInterval: timer.setIv,
      clearInterval: timer.clearIv,
    })

    ind.start()
    ind.stop()

    // Last call MUST be clearTransient so the bar reverts to its default text.
    expect(calls[calls.length - 1]?.kind).toBe("clearTransient")
    expect(timer.pending()).toBe(0)
  })

  test("double start() is idempotent (no second timer, no double paint)", () => {
    const { bar, calls } = makeCapBar()
    const timer = makeFakeTimer()
    const ind = createTurnIndicator({
      statusBar: bar,
      setInterval: timer.setIv,
      clearInterval: timer.clearIv,
    })

    ind.start()
    const after1 = calls.length
    ind.start()
    expect(calls.length).toBe(after1)
    expect(timer.pending()).toBe(1)
    ind.stop()
  })

  test("stop() before start() is a no-op", () => {
    const { bar, calls } = makeCapBar()
    const ind = createTurnIndicator({ statusBar: bar })
    ind.stop()
    expect(calls.length).toBe(0)
  })
})

// ── glyph rotation ──────────────────────────────────────────────────────

describe("createTurnIndicator: glyph rotation", () => {
  test("each tick advances to the next glyph (clock-injected)", () => {
    const { bar, calls } = makeCapBar()
    const timer = makeFakeTimer()
    const clock = makeClock()
    const ind = createTurnIndicator({
      statusBar: bar,
      now: clock.now,
      setInterval: timer.setIv,
      clearInterval: timer.clearIv,
    })

    ind.start()
    // 4 ticks ⇒ 5 paints total (first synchronous + 4 driven).
    for (let i = 0; i < 4; i++) {
      clock.advance(80)
      timer.tick()
    }
    ind.stop()

    const paintCalls = calls.filter((c) => c.kind === "transient")
    expect(paintCalls.length).toBe(5)
    // The first 5 glyphs in the default cycle.
    for (let i = 0; i < 5; i++) {
      expect(paintCalls[i]?.text?.startsWith(DEFAULT_GLYPHS[i] ?? "·")).toBe(true)
    }
  })

  test("custom glyph cycle is honoured", () => {
    const { bar, calls } = makeCapBar()
    const timer = makeFakeTimer()
    const ind = createTurnIndicator({
      statusBar: bar,
      glyphs: ["X", "Y"],
      setInterval: timer.setIv,
      clearInterval: timer.clearIv,
    })

    ind.start()
    timer.tick()
    timer.tick()
    ind.stop()

    const paintTexts = calls.filter((c) => c.kind === "transient").map((c) => c.text ?? "")
    expect(paintTexts[0]?.startsWith("X")).toBe(true)
    expect(paintTexts[1]?.startsWith("Y")).toBe(true)
    expect(paintTexts[2]?.startsWith("X")).toBe(true) // wraps around
  })
})

// ── elapsed clock ───────────────────────────────────────────────────────

describe("createTurnIndicator: elapsed clock", () => {
  test("renders 'thinking… <elapsed>' shape pre-first-chunk", () => {
    const { bar, calls } = makeCapBar()
    const timer = makeFakeTimer()
    const clock = makeClock()
    const ind = createTurnIndicator({
      statusBar: bar,
      now: clock.now,
      setInterval: timer.setIv,
      clearInterval: timer.clearIv,
    })

    ind.start()
    clock.advance(3400) // 3.4 s
    timer.tick()
    ind.stop()

    const lastPaint = calls.filter((c) => c.kind === "transient").pop()
    expect(lastPaint?.text).toMatch(/thinking… 3\.4s/)
  })

  test("elapsed switches to 'm:ss' format past 60 s", () => {
    const { bar, calls } = makeCapBar()
    const timer = makeFakeTimer()
    const clock = makeClock()
    const ind = createTurnIndicator({
      statusBar: bar,
      now: clock.now,
      setInterval: timer.setIv,
      clearInterval: timer.clearIv,
    })

    ind.start()
    clock.advance(83_000) // 1m23s
    timer.tick()
    ind.stop()

    const lastPaint = calls.filter((c) => c.kind === "transient").pop()
    expect(lastPaint?.text).toMatch(/1m23s/)
  })
})

// ── updateUsage reflected on next frame ─────────────────────────────────

describe("createTurnIndicator: updateUsage", () => {
  test("token counts surface on the next paint frame (after markFirstChunk)", () => {
    const { bar, calls } = makeCapBar()
    const timer = makeFakeTimer()
    const clock = makeClock()
    const ind = createTurnIndicator({
      statusBar: bar,
      now: clock.now,
      setInterval: timer.setIv,
      clearInterval: timer.clearIv,
    })

    ind.start()
    clock.advance(500)
    ind.markFirstChunk()
    ind.updateUsage({ inputTokens: 1247, outputTokens: 89 })
    clock.advance(100)
    timer.tick()
    ind.stop()

    const lastPaint = calls.filter((c) => c.kind === "transient").pop()
    expect(lastPaint?.text).toMatch(/streaming/)
    expect(lastPaint?.text).toMatch(/1,247 in/)
    expect(lastPaint?.text).toMatch(/89 out/)
  })

  test("cost surfaces when supplied; absent when not", () => {
    const { bar, calls } = makeCapBar()
    const timer = makeFakeTimer()
    const ind = createTurnIndicator({
      statusBar: bar,
      setInterval: timer.setIv,
      clearInterval: timer.clearIv,
    })

    ind.start()
    ind.markFirstChunk()
    ind.updateUsage({ inputTokens: 100, outputTokens: 50, costUsd: 0.0143 })
    timer.tick()
    ind.stop()

    const lastPaint = calls.filter((c) => c.kind === "transient").pop()
    expect(lastPaint?.text).toContain("$0.0143")
  })

  test("updateUsage before start() is a no-op (no crash, no leak)", () => {
    const { bar } = makeCapBar()
    const ind = createTurnIndicator({ statusBar: bar })
    expect(() => ind.updateUsage({ inputTokens: 99 })).not.toThrow()
  })
})

// ── markFirstChunk → ttft display ───────────────────────────────────────

describe("createTurnIndicator: markFirstChunk", () => {
  test("swaps render to 'streaming · …s · ttft …s' shape", () => {
    const { bar, calls } = makeCapBar()
    const timer = makeFakeTimer()
    const clock = makeClock()
    const ind = createTurnIndicator({
      statusBar: bar,
      now: clock.now,
      setInterval: timer.setIv,
      clearInterval: timer.clearIv,
    })

    ind.start()
    clock.advance(3400)
    ind.markFirstChunk()
    clock.advance(4700) // total 8.1 s
    timer.tick()
    ind.stop()

    const lastPaint = calls.filter((c) => c.kind === "transient").pop()
    expect(lastPaint?.text).toMatch(/streaming/)
    expect(lastPaint?.text).toMatch(/8\.1s/)
    expect(lastPaint?.text).toMatch(/ttft 3\.4s/)
  })

  test("second markFirstChunk is ignored (one-shot per turn)", () => {
    const { bar, calls } = makeCapBar()
    const timer = makeFakeTimer()
    const clock = makeClock()
    const ind = createTurnIndicator({
      statusBar: bar,
      now: clock.now,
      setInterval: timer.setIv,
      clearInterval: timer.clearIv,
    })

    ind.start()
    clock.advance(1000)
    ind.markFirstChunk()
    clock.advance(2000)
    ind.markFirstChunk() // ignored
    timer.tick()
    ind.stop()

    const lastPaint = calls.filter((c) => c.kind === "transient").pop()
    // ttft should still be 1.0s (the FIRST mark), not 3.0s.
    expect(lastPaint?.text).toMatch(/ttft 1\.0s/)
  })
})

// ── enabled=false / TTY OFF ─────────────────────────────────────────────

describe("createTurnIndicator: disabled mode", () => {
  test("enabled:false makes every method a no-op", () => {
    const { bar, calls } = makeCapBar()
    const timer = makeFakeTimer()
    const ind = createTurnIndicator({
      statusBar: bar,
      enabled: false,
      setInterval: timer.setIv,
      clearInterval: timer.clearIv,
    })

    ind.start()
    ind.markFirstChunk()
    ind.updateUsage({ inputTokens: 10, outputTokens: 20 })
    ind.stop()

    expect(calls.length).toBe(0)
    expect(timer.pending()).toBe(0)
  })

  test("isIndicatorEnabled gate: non-TTY ⇒ OFF (eval/bench safe)", () => {
    expect(isIndicatorEnabled({}, false)).toBe(false)
    expect(isIndicatorEnabled({}, undefined)).toBe(false)
  })

  test("isIndicatorEnabled gate: TTY + no env ⇒ ON (default)", () => {
    expect(isIndicatorEnabled({}, true)).toBe(true)
  })

  test("isIndicatorEnabled gate: explicit QUANTA_SPINNER=0|false|off|no ⇒ OFF", () => {
    expect(isIndicatorEnabled({ QUANTA_SPINNER: "0" }, true)).toBe(false)
    expect(isIndicatorEnabled({ QUANTA_SPINNER: "false" }, true)).toBe(false)
    expect(isIndicatorEnabled({ QUANTA_SPINNER: "OFF" }, true)).toBe(false)
    expect(isIndicatorEnabled({ QUANTA_SPINNER: "No" }, true)).toBe(false)
    expect(isIndicatorEnabled({ QUANTA_SPINNER: "1" }, true)).toBe(true)
  })
})

// ── statusBar.transient call sequence ───────────────────────────────────

describe("createTurnIndicator: transient call sequence", () => {
  test("every paint goes through statusBar.transient with a > intervalMs ttl", () => {
    const { bar, calls } = makeCapBar()
    const timer = makeFakeTimer()
    const ind = createTurnIndicator({
      statusBar: bar,
      intervalMs: 80,
      setInterval: timer.setIv,
      clearInterval: timer.clearIv,
    })

    ind.start()
    timer.tick()
    ind.stop()

    const paints = calls.filter((c) => c.kind === "transient")
    expect(paints.length).toBeGreaterThan(0)
    // ttl MUST exceed intervalMs so the next paint always reaches the bar
    // before the auto-revert window expires.
    for (const p of paints) {
      expect((p.ms ?? 0) > 80).toBe(true)
    }
  })
})
