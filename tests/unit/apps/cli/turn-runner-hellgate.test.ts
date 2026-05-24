import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { runOneTurn } from "../../../../src/apps/cli/repl/turn-runner"
import type { StatusBar } from "../../../../src/apps/cli/status-bar"
import type { TurnIndicator } from "../../../../src/apps/cli/turn-indicator"
import type { TurnSummaryCollector } from "../../../../src/apps/cli/turn-summary"

// === stubs ====================================================================

const stubStatusBar = (): StatusBar => ({
  setDefault: () => undefined,
  transient: () => undefined,
  clearTransient: () => undefined,
  teardown: () => undefined,
})

interface StubIndicator extends TurnIndicator {
  readonly events: string[]
}
const stubIndicator = (): StubIndicator => {
  const events: string[] = []
  return {
    events,
    start: () => events.push("start"),
    stop: () => events.push("stop"),
    updateUsage: () => undefined,
    markFirstChunk: () => undefined,
  }
}

interface StubSummary extends TurnSummaryCollector {
  readonly events: string[]
}
const stubSummary = (): StubSummary => {
  const events: string[] = []
  return {
    events,
    onEvent: () => undefined,
    render: () => "",
    reset: () => events.push("reset"),
    asStreamPort: () => ({ emit: () => undefined }),
  }
}

// In-memory stdin shim — non-TTY so `installTurnCancel` becomes a no-op
// (we test the cancel FSM separately).
let originalStdin: NodeJS.ReadStream
beforeEach(() => {
  originalStdin = process.stdin
  Object.defineProperty(process, "stdin", {
    value: { isTTY: false } as Partial<NodeJS.ReadStream>,
    configurable: true,
  })
})
afterEach(() => {
  Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true })
})

const baseDeps = <R>(body: (signal: AbortSignal) => Promise<R>) => ({
  outerAbort: new AbortController(),
  statusBar: stubStatusBar(),
  turnIndicator: stubIndicator(),
  turnSummary: stubSummary(),
  escWindowMs: 2000,
  body,
})

// === tests ====================================================================

describe("turn-runner / runOneTurn", () => {
  test("happy path — body resolves; onAfterResult fires; result returned", async () => {
    const onAfterResult = mock(() => undefined)
    const out = await runOneTurn(
      baseDeps(async () => ({ messages: [], outcome: { id: "x" } })),
      {
        onAfterResult,
      },
    )
    expect(onAfterResult).toHaveBeenCalledTimes(1)
    expect(out.result).toEqual({ messages: [], outcome: { id: "x" } })
    expect(out.turnAborted).toBe(false)
    expect(out.durationMs).toBeGreaterThanOrEqual(0)
  })

  test("indicator start/stop bracket the body — stop fires in finally even on success", async () => {
    const deps = baseDeps(async () => "ok")
    const ind = deps.turnIndicator as StubIndicator
    await runOneTurn(deps, {})
    expect(ind.events[0]).toBe("start")
    expect(ind.events).toContain("stop")
  })

  test("outer-abort path — onError fires; result=undefined; turnAborted=false", async () => {
    // The runner distinguishes "outer aborted" (REPL shutting down) from
    // "turn-only aborted" (Esc-Esc). When the OUTER controller fires + the
    // body throws, the error path runs (REPL exit; the host's onError is
    // expected to handle the display). turnAborted ONLY flips when the
    // turn-abort fires WITHOUT the outer firing.
    const onAfterResult = mock(() => undefined)
    const onError = mock(() => undefined)
    const deps = baseDeps(async (signal) => {
      return new Promise<string>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
      })
    })
    queueMicrotask(() => deps.outerAbort.abort())
    const out = await runOneTurn(deps, { onAfterResult, onError })
    expect(out.turnAborted).toBe(false) // outer aborted ⇒ not "turn-only"
    expect(onAfterResult).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(out.result).toBeUndefined()
  })

  test("non-abort error — onError fires; result=undefined; REPL survives", async () => {
    const onError = mock(() => undefined)
    const out = await runOneTurn(
      baseDeps(async () => {
        throw new Error("boom")
      }),
      { onError },
    )
    expect(onError).toHaveBeenCalledTimes(1)
    expect(out.result).toBeUndefined()
    expect(out.turnAborted).toBe(false)
  })

  test("non-abort error — indicator.stop fired BEFORE the error display (so transient survives)", async () => {
    const deps = baseDeps(async () => {
      throw new Error("boom")
    })
    const ind = deps.turnIndicator as StubIndicator
    let stopIdxAtError = -1
    await runOneTurn(deps, {
      onError: () => {
        stopIdxAtError = ind.events.lastIndexOf("stop")
      },
    })
    // At the moment onError fires, stop() must already have been called.
    expect(stopIdxAtError).toBeGreaterThanOrEqual(0)
  })

  test("summary collector is reset in the finally even on error", async () => {
    const deps = baseDeps(async () => {
      throw new Error("x")
    })
    const sum = deps.turnSummary as StubSummary
    await runOneTurn(deps, { onError: () => undefined })
    expect(sum.events).toContain("reset")
  })

  test("summary collector is reset in the finally on success", async () => {
    const deps = baseDeps(async () => "ok")
    const sum = deps.turnSummary as StubSummary
    await runOneTurn(deps, {})
    expect(sum.events).toContain("reset")
  })

  test("durationMs is non-negative and reflects body work", async () => {
    const out = await runOneTurn(
      baseDeps(async () => {
        await new Promise((r) => setTimeout(r, 5))
        return "ok"
      }),
      {},
    )
    expect(out.durationMs).toBeGreaterThanOrEqual(5)
  })

  test("missing sinks (both undefined) — no throw, body still runs", async () => {
    const out = await runOneTurn(
      baseDeps(async () => 42),
      {},
    )
    expect(out.result).toBe(42)
  })

  test("onAfterResult NOT called on error", async () => {
    const onAfterResult = mock(() => undefined)
    await runOneTurn(
      baseDeps(async () => {
        throw new Error("x")
      }),
      { onAfterResult, onError: () => undefined },
    )
    expect(onAfterResult).not.toHaveBeenCalled()
  })

  test("body receives a composite signal — aborting the OUTER controller propagates", async () => {
    const observed: AbortSignal[] = []
    const deps = baseDeps(async (signal) => {
      observed.push(signal)
      // Wait until signal aborts.
      await new Promise<void>((r) => {
        if (signal.aborted) return r()
        signal.addEventListener("abort", () => r(), { once: true })
      })
      throw new Error("aborted")
    })
    queueMicrotask(() => deps.outerAbort.abort())
    await runOneTurn(deps, { onError: () => undefined })
    expect(observed.length).toBe(1)
    expect(observed[0]?.aborted).toBe(true)
  })

  test("idempotent — 3 calls with identical input give identical results AND exact per-call side-effect counts", async () => {
    // T3 strengthening — REGRESSION CLASS CAUGHT: the prior assertion
    // `expect(stops).toBeGreaterThanOrEqual(1)` passes for 1, 2, 3, N
    // stops — so a regression that called `turnIndicator.stop()` TWICE
    // per turn (double-fire side effect — fold-cost duplicated, dashboard
    // re-rendered) would slip through. A test named "idempotent" must
    // assert (a) the output is deterministic across N identical runs and
    // (b) per-call side-effect counters are EXACTLY equal to call count,
    // not >= it.
    //
    // We build THREE fresh deps bundles (each runOneTurn requires its
    // own AbortController + spy bundle) and call the SAME body 3 times.
    // Assertions:
    //   1. .result is deeply equal across all 3 calls.
    //   2. .turnAborted is false in all 3.
    //   3. turnIndicator.start fired EXACTLY ONCE per call → 1 per bundle.
    //   4. turnIndicator.stop fired EXACTLY ONCE per call → 1 per bundle
    //      (happy path: catch doesn't run; finally runs once).
    //   5. summary.reset fired EXACTLY ONCE per call (finally safety net).
    //   6. The shared mutable input (a frozen `inputObj`) is NOT mutated
    //      by runOneTurn — the same reference is byte-identical before
    //      and after.
    const inputObj = Object.freeze({ kind: "shared-input" as const, n: 7 })
    const inputBefore = JSON.stringify(inputObj)
    const makeBody = () => async () => inputObj
    const results: Array<{ result: unknown; turnAborted: boolean }> = []
    const indEvents: string[][] = []
    const sumEvents: string[][] = []
    for (let i = 0; i < 3; i++) {
      const deps = baseDeps(makeBody())
      const ind = deps.turnIndicator as StubIndicator
      const sum = deps.turnSummary as StubSummary
      const out = await runOneTurn(deps, {})
      results.push({ result: out.result, turnAborted: out.turnAborted })
      indEvents.push([...ind.events])
      sumEvents.push([...sum.events])
    }
    // 1+2 — results identical across all 3 runs
    expect(results[0]?.result).toEqual(results[1]?.result)
    expect(results[1]?.result).toEqual(results[2]?.result)
    expect(results[0]?.result).toBe(inputObj) // same reference returned
    expect(results.every((r) => r.turnAborted === false)).toBe(true)
    // 3 — start exactly once per bundle
    for (const ev of indEvents) {
      expect(ev.filter((e) => e === "start").length).toBe(1)
    }
    // 4 — stop exactly once per bundle on happy path (NOT >= 1, EXACTLY 1)
    for (const ev of indEvents) {
      expect(ev.filter((e) => e === "stop").length).toBe(1)
    }
    // 5 — summary.reset exactly once per bundle
    for (const ev of sumEvents) {
      expect(ev.filter((e) => e === "reset").length).toBe(1)
    }
    // 6 — immutable input is not mutated
    expect(JSON.stringify(inputObj)).toBe(inputBefore)
  })

  test("DRY win — runOneTurn handles the SAME orchestration both call sites used", async () => {
    // Simulate two distinct bodies (one-shot vs interactive) sharing the
    // SAME wrapper — both should produce a uniform RunOneTurnResult shape.
    const oneShot = await runOneTurn(
      baseDeps(async () => ({ kind: "one-shot" as const })),
      {},
    )
    const interactive = await runOneTurn(
      baseDeps(async () => ({ kind: "interactive" as const })),
      {},
    )
    expect(oneShot.result).toEqual({ kind: "one-shot" })
    expect(interactive.result).toEqual({ kind: "interactive" })
    expect(typeof oneShot.durationMs).toBe("number")
    expect(typeof interactive.durationMs).toBe("number")
    expect(typeof oneShot.turnAborted).toBe("boolean")
    expect(typeof interactive.turnAborted).toBe("boolean")
  })
})
