/**
 * ★ HELLGATE — WS-A (jul-10 uiux structural, UUX-1-22 / UUX-3-11): a released
 *   mid-turn prompt must be TYPED, never a silent deny disguised as input.
 *
 * Pinned bug: `MidTurnApprovalChannel.clear()` resolved a pending waiter with
 * the bare string `""` — indistinguishable from the operator pressing Enter on
 * an empty line. Turn cancel (Esc-Esc), Ctrl+B backgrounding, and normal turn
 * teardown all silently became "operator denied" with zero attribution.
 *
 * Contract under test:
 *   - `awaitLine()` resolves a DISCRIMINATED result: `{kind:"line", line}` for
 *     real operator input vs `{kind:"released", cause}` for a channel release.
 *   - `clear(cause)` REQUIRES a cause ("turn_teardown" — the compile-time
 *     signature change is itself the regression fence).
 *
 * ★ HELLGATE — C2 (jul-10 audit): concurrent asks are SERIALIZED, never lost.
 *   The old one-ask-at-a-time supersede (second `awaitLine` released the first
 *   as a fail-closed deny) was a SINGLE-consumer invariant; the WS-B registry
 *   made the channel multi-consumer (approval prompts + MCP elicitation share
 *   it), so a legitimate concurrent ask DESTROYED a pending one. The channel is
 *   now a FIFO queue: `tryResolve` feeds the HEAD only, each waiter's
 *   `onActive` render hook fires when it BECOMES head (first-in-queue:
 *   synchronously — byte-identical single-ask render timing), `clear` flushes
 *   ALL waiters typed, and a consumer abort splices ONLY its own waiter.
 */
import { describe, expect, test } from "bun:test"
import { createMidTurnApprovalChannel } from "../mid-turn-approval-channel"

describe("HELLGATE WS-A — mid-turn channel typed release", () => {
  test("a real operator line resolves {kind:'line'} (paired control)", async () => {
    const ch = createMidTurnApprovalChannel()
    const p = ch.awaitLine()
    expect(ch.tryResolve("y")).toBe(true)
    expect(await p).toEqual({ kind: "line", line: "y" })
  })

  test("an operator EMPTY line is a line, NOT a release (the shapes must differ)", async () => {
    const ch = createMidTurnApprovalChannel()
    const p = ch.awaitLine()
    ch.tryResolve("")
    expect(await p).toEqual({ kind: "line", line: "" })
  })

  test("clear('turn_teardown') resolves the waiter as a TYPED release", async () => {
    const ch = createMidTurnApprovalChannel()
    const p = ch.awaitLine()
    ch.clear("turn_teardown")
    expect(await p).toEqual({ kind: "released", cause: "turn_teardown" })
  })

  test("clear with nothing pending is a no-op; a later waiter is unaffected", async () => {
    const ch = createMidTurnApprovalChannel()
    ch.clear("turn_teardown")
    const p = ch.awaitLine()
    ch.tryResolve("later")
    expect(await p).toEqual({ kind: "line", line: "later" })
  })

  test("tryResolve after a release is NOT consumed (the waiter is gone)", async () => {
    const ch = createMidTurnApprovalChannel()
    const p = ch.awaitLine()
    ch.clear("turn_teardown")
    await p
    expect(ch.tryResolve("stray")).toBe(false)
  })
})

// ── C2 (jul-10 audit) — FIFO ask queue: concurrent asks serialized, never lost ─

describe("HELLGATE C2 — concurrent asks are SERIALIZED (FIFO queue), never lost", () => {
  test("MISSION RED: two concurrent asks (approval then elicitation) BOTH answer in order", async () => {
    const ch = createMidTurnApprovalChannel()
    const approval = ch.awaitLine(undefined, "approval")
    const elicitation = ch.awaitLine(undefined, "elicitation")
    // First routed line answers the FIRST ask (the old supersede DESTROYED it).
    expect(ch.tryResolve("y")).toBe(true)
    expect(await approval).toEqual({ kind: "line", line: "y" })
    // Second routed line answers the SECOND ask — nothing was lost.
    expect(ch.tryResolve("blue")).toBe(true)
    expect(await elicitation).toEqual({ kind: "line", line: "blue" })
  })

  test("RENDER ORDERING: onActive fires at ENQUEUE for the head, at PROMOTION for a queued ask", async () => {
    const ch = createMidTurnApprovalChannel()
    const renders: string[] = []
    const first = ch.awaitLine(undefined, "approval", () => renders.push("approval"))
    // First-in-queue activates SYNCHRONOUSLY (byte-identical single-ask timing:
    // the prompt is on screen before awaitLine's promise is even awaited).
    expect(renders).toEqual(["approval"])
    const second = ch.awaitLine(undefined, "elicitation", () => renders.push("elicitation"))
    // The queued ask must NOT print its prompt while the first is unanswered.
    expect(renders).toEqual(["approval"])
    expect(ch.tryResolve("y")).toBe(true)
    // Head settled ⇒ the next waiter becomes head and renders — synchronously
    // inside tryResolve, BEFORE the next captured line could race it.
    expect(renders).toEqual(["approval", "elicitation"])
    expect(await first).toEqual({ kind: "line", line: "y" })
    expect(ch.tryResolve("blue")).toBe(true)
    expect(await second).toEqual({ kind: "line", line: "blue" })
  })

  test("MID-QUEUE ABORT: a consumer abort splices ONLY its waiter (head and tail unaffected)", async () => {
    const ch = createMidTurnApprovalChannel()
    const renders: string[] = []
    const head = ch.awaitLine(undefined, "a", () => renders.push("a"))
    const ctrl = new AbortController()
    const mid = ch.awaitLine(ctrl.signal, "b", () => renders.push("b"))
    const tail = ch.awaitLine(undefined, "c", () => renders.push("c"))
    ctrl.abort()
    expect(await mid).toEqual({ kind: "released", cause: "consumer_aborted" })
    // The aborted MID waiter never rendered; head is still armed and answers.
    expect(renders).toEqual(["a"])
    expect(ch.tryResolve("for-a")).toBe(true)
    expect(await head).toEqual({ kind: "line", line: "for-a" })
    // Tail was promoted PAST the dead mid waiter.
    expect(renders).toEqual(["a", "c"])
    expect(ch.tryResolve("for-c")).toBe(true)
    expect(await tail).toEqual({ kind: "line", line: "for-c" })
  })

  test("HEAD ABORT: aborting the head promotes (and renders) the next waiter", async () => {
    const ch = createMidTurnApprovalChannel()
    const renders: string[] = []
    const ctrl = new AbortController()
    const head = ch.awaitLine(ctrl.signal, "a", () => renders.push("a"))
    const next = ch.awaitLine(undefined, "b", () => renders.push("b"))
    expect(renders).toEqual(["a"])
    ctrl.abort()
    expect(await head).toEqual({ kind: "released", cause: "consumer_aborted" })
    expect(renders).toEqual(["a", "b"]) // promoted head rendered its prompt
    expect(ch.tryResolve("for-b")).toBe(true)
    expect(await next).toEqual({ kind: "line", line: "for-b" })
  })

  test("CLEAR flushes ALL queued waiters — each TYPED, none hangs, none fakes a line", async () => {
    const ch = createMidTurnApprovalChannel()
    const a = ch.awaitLine(undefined, "a")
    const b = ch.awaitLine(undefined, "b")
    const c = ch.awaitLine(undefined, "c")
    ch.clear("turn_teardown")
    expect(await a).toEqual({ kind: "released", cause: "turn_teardown" })
    expect(await b).toEqual({ kind: "released", cause: "turn_teardown" })
    expect(await c).toEqual({ kind: "released", cause: "turn_teardown" })
    // Queue fully drained: a later line flows to normal routing.
    expect(ch.tryResolve("stray")).toBe(false)
  })

  test("STALE ABORT after settle is a no-op — it can never clobber another waiter", async () => {
    const ch = createMidTurnApprovalChannel()
    const ctrl = new AbortController()
    const first = ch.awaitLine(ctrl.signal, "a")
    const second = ch.awaitLine(undefined, "b")
    expect(ch.tryResolve("for-a")).toBe(true)
    expect(await first).toEqual({ kind: "line", line: "for-a" })
    ctrl.abort() // fires AFTER its waiter settled — must not touch the new head
    expect(ch.tryResolve("for-b")).toBe(true)
    expect(await second).toEqual({ kind: "line", line: "for-b" })
  })

  test("an already-aborted signal never enqueues (queue order preserved for others)", async () => {
    const ch = createMidTurnApprovalChannel()
    const a = ch.awaitLine(undefined, "a")
    const ctrl = new AbortController()
    ctrl.abort()
    const dead = ch.awaitLine(ctrl.signal, "b")
    const c = ch.awaitLine(undefined, "c")
    expect(await dead).toEqual({ kind: "released", cause: "consumer_aborted" })
    expect(ch.tryResolve("for-a")).toBe(true)
    expect(await a).toEqual({ kind: "line", line: "for-a" })
    expect(ch.tryResolve("for-c")).toBe(true)
    expect(await c).toEqual({ kind: "line", line: "for-c" })
  })
})
