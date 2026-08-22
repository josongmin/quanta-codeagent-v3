/**
 * Hellgate — ADR-0071 mid-turn control surface (`createConversationActionSurface`).
 *
 * Pins the FIFO + at-most-once drain semantics the loop's per-turn poll relies
 * on, plus the typed enqueue shapes `/cancel` + `/summarize-now` push:
 *
 *   CAS-01  fresh surface: empty queue, port.next() === undefined
 *   CAS-02  activeTurnRef starts at the "no active turn" snapshot
 *   CAS-03  pushCancel enqueues a typed { kind:"cancel", reason }
 *   CAS-04  pushSummarize enqueues a typed { kind:"summarize" }
 *   CAS-05  FIFO order preserved across mixed pushes
 *   CAS-06  at-most-once: next() drains exactly one; a drained action never repeats
 *   CAS-07  pending() reflects the live queue depth
 */

import { describe, expect, test } from "bun:test"
import { createConversationActionSurface } from "../../../../src/apps/cli/repl/conversation-action-surface"

describe("ADR-0071 createConversationActionSurface", () => {
  test("CAS-01 — fresh surface drains undefined", () => {
    const s = createConversationActionSurface()
    expect(s.pending()).toBe(0)
    expect(s.port.next()).toBeUndefined()
  })

  test("CAS-02 — activeTurnRef starts at the no-active-turn snapshot", () => {
    const s = createConversationActionSurface()
    expect(s.activeTurnRef.current.currentTurn).toBeNull()
    expect(s.activeTurnRef.current.isInterrupted).toBe(false)
  })

  test("CAS-03 — pushCancel enqueues a typed cancel", () => {
    const s = createConversationActionSurface()
    s.pushCancel("stop now")
    const a = s.port.next()
    expect(a).toEqual({ kind: "cancel", reason: "stop now" })
  })

  test("CAS-04 — pushSummarize enqueues a typed summarize", () => {
    const s = createConversationActionSurface()
    s.pushSummarize()
    expect(s.port.next()).toEqual({ kind: "summarize" })
  })

  test("CAS-05 — FIFO order across mixed pushes", () => {
    const s = createConversationActionSurface()
    s.pushCancel("a")
    s.pushSummarize()
    s.pushCancel("b")
    expect(s.port.next()).toEqual({ kind: "cancel", reason: "a" })
    expect(s.port.next()).toEqual({ kind: "summarize" })
    expect(s.port.next()).toEqual({ kind: "cancel", reason: "b" })
    expect(s.port.next()).toBeUndefined()
  })

  test("CAS-06 — at-most-once: a drained action never repeats", () => {
    const s = createConversationActionSurface()
    s.pushSummarize()
    expect(s.port.next()).toEqual({ kind: "summarize" })
    // Second poll must NOT re-return the same action.
    expect(s.port.next()).toBeUndefined()
  })

  test("CAS-07 — pending() reflects live depth", () => {
    const s = createConversationActionSurface()
    expect(s.pending()).toBe(0)
    s.pushCancel("x")
    s.pushSummarize()
    expect(s.pending()).toBe(2)
    s.port.next()
    expect(s.pending()).toBe(1)
  })
})
