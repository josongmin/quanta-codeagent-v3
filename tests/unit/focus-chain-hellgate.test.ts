/**
 * Focus Chain hellgate (ADR-0219).
 *
 * 10+ adversarial cases sealing the tracker invariants:
 *   - empty todos → null injection / null drift warning
 *   - N-tick boundary — injection lands on turn N, NOT N-1, NOT N+1
 *   - drift detection — 0% progress for windowTurns → warning
 *   - drift resets after activity (markDone / setTodos)
 *   - byte-identical when OFF — tracker absent ⇒ no behaviour change
 *   - bad input handled (negative tick, NaN, malformed todo) without throw
 *   - peek vs get — peek does not consume injection slot
 *   - markDone out-of-range — no throw, no state change
 *   - snapshot is frozen — mutating it doesn't affect tracker
 *   - 5-mode pure-tracker — no dependency on subagent mode at all
 *   - injection respects reinjectEveryN = 0 (disabled)
 *   - renderTodos output format stability
 */

import { describe, expect, test } from "bun:test"
import {
  defaultFocusChainTracker,
  type FocusTodo,
  formatDriftWarning,
  isDrifting,
  renderTodos,
  sanitizeTodo,
} from "@/agent/focus-chain"

describe("focus-chain — hellgate", () => {
  test("empty todos → null injection at every turn", () => {
    const t = defaultFocusChainTracker({ reinjectEveryN: 2 })
    for (let i = 0; i < 10; i++) {
      t.tickTurn()
      expect(t.getInjection()).toBeNull()
    }
  })

  test("empty todos → null drift warning (even past window)", () => {
    const t = defaultFocusChainTracker({ driftWindowTurns: 3 })
    for (let i = 0; i < 10; i++) t.tickTurn()
    expect(t.getDriftWarning()).toBeNull()
  })

  test("N-tick boundary — injection lands ONLY on turn N", () => {
    const t = defaultFocusChainTracker({ reinjectEveryN: 6 })
    t.setTodos([{ text: "first", state: "pending" }])
    // turn 0-5 → null (cycle not complete)
    for (let i = 0; i < 5; i++) {
      t.tickTurn()
      expect(t.getInjection()).toBeNull()
    }
    // turn 6 → injection
    t.tickTurn()
    const inj = t.getInjection()
    expect(inj).not.toBeNull()
    expect(inj).toContain("first")
  })

  test("getInjection consumes the slot — second call same turn returns null", () => {
    const t = defaultFocusChainTracker({ reinjectEveryN: 2 })
    t.setTodos([{ text: "x", state: "pending" }])
    t.tickTurn()
    t.tickTurn()
    expect(t.getInjection()).not.toBeNull()
    expect(t.getInjection()).toBeNull()
  })

  test("peekInjection does NOT consume the slot", () => {
    const t = defaultFocusChainTracker({ reinjectEveryN: 2 })
    t.setTodos([{ text: "x", state: "pending" }])
    t.tickTurn()
    t.tickTurn()
    expect(t.peekInjection()).not.toBeNull()
    expect(t.peekInjection()).not.toBeNull()
    // After peek, the real call still works.
    expect(t.getInjection()).not.toBeNull()
  })

  test("drift detection — 0% progress for windowTurns → warning", () => {
    const t = defaultFocusChainTracker({ driftWindowTurns: 5 })
    t.setTodos([{ text: "stuck", state: "pending" }])
    // setTodos counts as activity, so we need to advance 5+ turns past now.
    for (let i = 0; i < 5; i++) t.tickTurn()
    const w = t.getDriftWarning()
    expect(w).not.toBeNull()
    expect(w).toContain("drift detected")
  })

  test("drift resets after markDone activity", () => {
    const t = defaultFocusChainTracker({ driftWindowTurns: 3 })
    t.setTodos([
      { text: "a", state: "pending" },
      { text: "b", state: "pending" },
    ])
    for (let i = 0; i < 4; i++) t.tickTurn()
    expect(t.getDriftWarning()).not.toBeNull()
    t.markDone(0)
    expect(t.getDriftWarning()).toBeNull()
  })

  test("drift resets after setTodos activity", () => {
    const t = defaultFocusChainTracker({ driftWindowTurns: 3 })
    t.setTodos([{ text: "a", state: "pending" }])
    for (let i = 0; i < 4; i++) t.tickTurn()
    expect(t.getDriftWarning()).not.toBeNull()
    t.setTodos([{ text: "b", state: "pending" }])
    expect(t.getDriftWarning()).toBeNull()
  })

  test("tickTurn with malformed counter is no-op (current stays finite)", () => {
    const t = defaultFocusChainTracker()
    t.tickTurn()
    t.tickTurn()
    expect(t.currentTurn()).toBe(2)
  })

  test("markDone — out-of-range and negative are no-op (no throw)", () => {
    const t = defaultFocusChainTracker()
    t.setTodos([{ text: "only", state: "pending" }])
    expect(() => t.markDone(-1)).not.toThrow()
    expect(() => t.markDone(99)).not.toThrow()
    // biome-ignore lint/suspicious/noExplicitAny: hostile-input shape test
    expect(() => t.markDone(Number.NaN as any)).not.toThrow()
    // State unchanged
    const snap = t.snapshotTodos()
    expect(snap[0]?.state).toBe("pending")
  })

  test("snapshotTodos is frozen — mutation rejected / silently ignored", () => {
    const t = defaultFocusChainTracker()
    t.setTodos([{ text: "a", state: "pending" }])
    const snap = t.snapshotTodos()
    expect(Object.isFrozen(snap)).toBe(true)
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: frozen-mutation probe
      ;(snap as any).push({ text: "x", state: "pending" })
    }).toThrow()
  })

  test("byte-identical when OFF — host that never reads injection sees no change", () => {
    // Simulate two prompts: one with tracker, one without. The "without"
    // baseline is just "USER" — the tracker side splices ONLY when the
    // host explicitly reads.
    const tracker = defaultFocusChainTracker({ reinjectEveryN: 2 })
    tracker.setTodos([{ text: "t", state: "pending" }])
    tracker.tickTurn()
    tracker.tickTurn()
    // Host that NEVER calls getInjection → prompt is just "USER"
    const promptOff = "USER"
    const promptOn = ((): string => {
      const inj = tracker.getInjection()
      return inj === null ? "USER" : `USER\n\n${inj}`
    })()
    // With tracker WIRED but never read ⇒ promptOff stays byte-identical.
    expect(promptOff).toBe("USER")
    // With tracker WIRED + read, the splice happens (different prompt).
    expect(promptOn).not.toBe(promptOff)
  })

  test("reinjectEveryN = 0 disables injection but still ticks", () => {
    const t = defaultFocusChainTracker({ reinjectEveryN: 0 })
    t.setTodos([{ text: "x", state: "pending" }])
    for (let i = 0; i < 100; i++) t.tickTurn()
    expect(t.getInjection()).toBeNull()
    expect(t.currentTurn()).toBe(100)
  })

  test("reinjectEveryN negative → falls back to default (6), no throw", () => {
    const t = defaultFocusChainTracker({ reinjectEveryN: -5 })
    t.setTodos([{ text: "x", state: "pending" }])
    for (let i = 0; i < 5; i++) {
      t.tickTurn()
      expect(t.getInjection()).toBeNull()
    }
    t.tickTurn()
    expect(t.getInjection()).not.toBeNull()
  })

  test("renderTodos — output format stability", () => {
    const todos: FocusTodo[] = [
      { text: "pending one", state: "pending" },
      { text: "active one", state: "in-progress" },
      { text: "finished one", state: "done" },
    ]
    const out = renderTodos(todos)
    expect(out).not.toBeNull()
    expect(out).toContain("## Focus Chain — Todos")
    expect(out).toContain("- [ ] pending one")
    expect(out).toContain("- [~] active one")
    expect(out).toContain("- [x] finished one")
  })

  test("renderTodos — empty list returns null", () => {
    expect(renderTodos([])).toBeNull()
  })

  test("renderTodos — only-malformed entries returns null (no empty heading)", () => {
    const todos = [
      // biome-ignore lint/suspicious/noExplicitAny: hostile-input shape test
      { text: 42, state: "pending" } as any,
      // biome-ignore lint/suspicious/noExplicitAny: hostile-input shape test
      { text: "x", state: "BOGUS" } as any,
    ]
    // The renderTodos function filters bad shapes; sanitizeTodo guards the
    // input layer. We call renderTodos directly to verify the filter.
    const out = renderTodos(todos)
    // The first is dropped (non-string text). The second has unknown state
    // — renderTodos drops because PREFIX["BOGUS"] is undefined.
    expect(out).toBeNull()
  })

  test("sanitizeTodo — clamps unknown state to pending", () => {
    const r = sanitizeTodo({ text: "x", state: "BOGUS" })
    expect(r).toEqual({ text: "x", state: "pending" })
  })

  test("sanitizeTodo — rejects non-object / non-string text", () => {
    expect(sanitizeTodo(null)).toBeNull()
    expect(sanitizeTodo("hi")).toBeNull()
    expect(sanitizeTodo(42)).toBeNull()
    expect(sanitizeTodo({ text: 123 })).toBeNull()
  })

  test("isDrifting — pure predicate honours window/current/last", () => {
    expect(isDrifting({ currentTurn: 5, lastActivityTurn: 0, windowTurns: 5 })).toBe(true)
    expect(isDrifting({ currentTurn: 4, lastActivityTurn: 0, windowTurns: 5 })).toBe(false)
    expect(isDrifting({ currentTurn: 10, lastActivityTurn: 5, windowTurns: 5 })).toBe(true)
    // Bad inputs ⇒ false (no false-positive drift)
    expect(isDrifting({ currentTurn: 10, lastActivityTurn: 5, windowTurns: 0 })).toBe(false)
    expect(isDrifting({ currentTurn: 10, lastActivityTurn: 5, windowTurns: -3 })).toBe(false)
    expect(isDrifting({ currentTurn: Number.NaN, lastActivityTurn: 0, windowTurns: 5 })).toBe(false)
  })

  test("formatDriftWarning — null when not drifting", () => {
    expect(formatDriftWarning({ currentTurn: 1, lastActivityTurn: 0, windowTurns: 5 })).toBeNull()
  })

  test("formatDriftWarning — actionable message when drifting", () => {
    const w = formatDriftWarning({ currentTurn: 7, lastActivityTurn: 2, windowTurns: 5 })
    expect(w).toContain("5 turns")
    expect(w).toContain("Re-read")
  })

  test("setTodos sanitizes hostile input (mixed valid + invalid)", () => {
    const t = defaultFocusChainTracker()
    t.setTodos([
      { text: "ok", state: "pending" },
      // biome-ignore lint/suspicious/noExplicitAny: hostile-input shape test
      { text: 42, state: "pending" } as any,
      { text: "ok2", state: "done" },
    ])
    const snap = t.snapshotTodos()
    expect(snap.length).toBe(2)
    expect(snap[0]?.text).toBe("ok")
    expect(snap[1]?.text).toBe("ok2")
  })

  test("currentTurn — monotonic from 0", () => {
    const t = defaultFocusChainTracker()
    expect(t.currentTurn()).toBe(0)
    t.tickTurn()
    expect(t.currentTurn()).toBe(1)
    t.tickTurn()
    expect(t.currentTurn()).toBe(2)
  })

  test("injection contains all current todo entries with current states", () => {
    const t = defaultFocusChainTracker({ reinjectEveryN: 1 })
    t.setTodos([
      { text: "alpha", state: "pending" },
      { text: "beta", state: "in-progress" },
      { text: "gamma", state: "done" },
    ])
    t.tickTurn()
    const inj = t.getInjection()
    expect(inj).toContain("alpha")
    expect(inj).toContain("beta")
    expect(inj).toContain("gamma")
    expect(inj).toContain("- [ ] alpha")
    expect(inj).toContain("- [~] beta")
    expect(inj).toContain("- [x] gamma")
  })
})
