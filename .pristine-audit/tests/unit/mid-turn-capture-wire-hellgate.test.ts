/**
 * #8 last-mile — mid-turn keystroke capture SEAM hellgate (jun-6).
 *
 * Seals `maybeCreateMidTurnCaptureWire` (`@/apps/cli/repl/mid-turn-capture-wire`):
 *   A. DEFAULT-OFF: knob false ⇒ no handle (byte-identical).
 *   B. No thread id ⇒ no handle (no plan-queue partition to address).
 *   C. ON + thread ⇒ `captureLine` enqueues onto the plan-queue AND mirrors
 *      onto the external sink, drained at the next turn boundary.
 *   D. The external push sink throwing does NOT break capture (the plan-queue
 *      copy survives for `/queue`).
 *   E. FIFO + per-thread isolation under multiple mid-turn lines.
 */

import { describe, expect, test } from "bun:test"
import { defaultPlanQueueStore, type PlanQueueStore } from "@/agent/plan-queue"
import { maybeCreateMidTurnCaptureWire } from "@/apps/cli/repl/mid-turn-capture-wire"

let tick = 1_000
const now = (): number => {
  tick += 1
  return tick
}
const freshQueue = (): PlanQueueStore => {
  tick = 1_000
  return defaultPlanQueueStore({ now })
}

describe("maybeCreateMidTurnCaptureWire — #8 seam", () => {
  test("A. knob OFF ⇒ no handle (default-OFF byte-identical)", () => {
    const handle = maybeCreateMidTurnCaptureWire({
      enabled: false,
      threadId: "t-1",
      planQueue: freshQueue(),
      pushExternal: () => {},
      now,
    })
    expect(handle).toBeUndefined()
  })

  test("B. missing / empty thread id ⇒ no handle even when enabled", () => {
    const q = freshQueue()
    expect(
      maybeCreateMidTurnCaptureWire({
        enabled: true,
        threadId: undefined,
        planQueue: q,
        pushExternal: () => {},
        now,
      }),
    ).toBeUndefined()
    expect(
      maybeCreateMidTurnCaptureWire({
        enabled: true,
        threadId: "",
        planQueue: q,
        pushExternal: () => {},
        now,
      }),
    ).toBeUndefined()
  })

  test("C. enabled ⇒ captureLine enqueues onto plan-queue AND mirrors onto external sink", async () => {
    const q = freshQueue()
    const pushed: string[] = []
    const handle = maybeCreateMidTurnCaptureWire({
      enabled: true,
      threadId: "t-1",
      planQueue: q,
      pushExternal: (text) => void pushed.push(text),
      now,
    })
    expect(handle).toBeDefined()
    if (!handle) return

    await handle.captureLine("please also clean up tmp files", 3)

    // Plan-queue partition for t-1 carries the captured line.
    const snap = q.peek("t-1")
    expect(snap).toHaveLength(1)
    expect(snap[0]?.text).toBe("please also clean up tmp files")
    // It arrived during turn 3 and is a user_keystroke held for the next turn.
    expect(snap[0]?.arrivedDuringTurn).toBe(3)
    expect(snap[0]?.source).toBe("user_keystroke")
    // Mirrored onto the external ingress (the turn-boundary drain target).
    expect(pushed).toEqual(["please also clean up tmp files"])
  })

  test("D. external sink throwing does NOT break capture; plan-queue copy survives", async () => {
    const q = freshQueue()
    const handle = maybeCreateMidTurnCaptureWire({
      enabled: true,
      threadId: "t-1",
      planQueue: q,
      pushExternal: () => {
        throw new Error("queue closed")
      },
      now,
    })
    if (!handle) throw new Error("handle expected")

    // Must NOT throw — the in-flight turn that produced the keystroke is safe.
    await handle.captureLine("survives", 1)
    const snap = q.peek("t-1")
    expect(snap).toHaveLength(1)
    expect(snap[0]?.text).toBe("survives")
  })

  test("E. multiple mid-turn lines ⇒ FIFO preserved; foreign thread untouched", async () => {
    const q = freshQueue()
    const pushed: string[] = []
    const handle = maybeCreateMidTurnCaptureWire({
      enabled: true,
      threadId: "t-1",
      planQueue: q,
      pushExternal: (text) => void pushed.push(text),
      now,
    })
    if (!handle) throw new Error("handle expected")

    await handle.captureLine("first", 1)
    await handle.captureLine("second", 1)

    const snap = q.peek("t-1")
    expect(snap.map((e) => e.text)).toEqual(["first", "second"])
    expect(pushed).toEqual(["first", "second"])
    // A different thread's partition is empty (per-thread isolation).
    expect(q.peek("t-other")).toEqual([])
  })
})
