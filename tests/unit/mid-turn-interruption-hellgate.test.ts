import { describe, expect, test } from "bun:test"
import {
  alwaysCancelPolicy,
  alwaysQueuePolicy,
  defaultInterruptionPolicy,
  defaultMidTurnCapture,
  type InterruptionPolicy,
  type MidTurnInput,
} from "@/agent/mid-turn-interruption"
import type { FollowUp, PlanQueueStore } from "@/agent/plan-queue"
import { defaultPlanQueueStore } from "@/agent/plan-queue"

/**
 * Mid-turn interruption — hellgate (ADR-0177).
 *
 * 22 cases seal:
 *   A. defaultInterruptionPolicy (4)
 *   B. alwaysQueue / alwaysCancel (2)
 *   C. capture → planQueue (8)
 *   D. drainForTurn (4)
 *   E. peek (2)
 *   F. cancel cause integration (2)
 */

let tickValue = 1_000
const tick = (): number => {
  tickValue += 1
  return tickValue
}
const resetTick = (start = 1_000): void => {
  tickValue = start
}

const freshPlanQueue = (): PlanQueueStore => {
  resetTick()
  return defaultPlanQueueStore({ now: tick })
}

/** Build a MidTurnInput WITHOUT cancelCause unless requested (exactOptional). */
const mkInput = (
  text: string,
  overrides: Partial<{
    mode: MidTurnInput["mode"]
    receivedAtMs: number
    observedTurnIndex: number
    cancelCause: MidTurnInput["cancelCause"]
  }> = {},
): MidTurnInput => {
  const base: Omit<MidTurnInput, "cancelCause"> = {
    text,
    receivedAtMs: overrides.receivedAtMs ?? 1_000,
    mode: overrides.mode ?? "queue",
    observedTurnIndex: overrides.observedTurnIndex ?? 0,
  }
  if (overrides.cancelCause !== undefined) {
    return { ...base, cancelCause: overrides.cancelCause }
  }
  return base
}

// ─────────────────────────────────────────────────────────────
// A. defaultInterruptionPolicy (4)
// ─────────────────────────────────────────────────────────────

describe("mid-turn — A. defaultInterruptionPolicy", () => {
  const policy = defaultInterruptionPolicy()
  const ctx = { turnIndex: 0, stillStreaming: true } as const

  test("HELL-1: mode=queue → action=queue", () => {
    const d = policy.decide(mkInput("hi", { mode: "queue" }), ctx)
    expect(d.action).toBe("queue")
  })

  test("HELL-2: mode=cancel-and-replace → action=cancel", () => {
    const d = policy.decide(mkInput("stop now", { mode: "cancel-and-replace" }), ctx)
    expect(d.action).toBe("cancel")
  })

  test("HELL-3: mode=cancel-and-amend → action=cancel", () => {
    const d = policy.decide(mkInput("also include X", { mode: "cancel-and-amend" }), ctx)
    expect(d.action).toBe("cancel")
  })

  test("HELL-4: unknown mode → action=queue (defensive)", () => {
    // Force-widen for the defensive branch (defensive contract — string
    // injection is the realistic failure mode).
    const bad = { ...mkInput("hi"), mode: "bogus" as unknown as MidTurnInput["mode"] }
    const d = policy.decide(bad, ctx)
    expect(d.action).toBe("queue")
  })
})

// ─────────────────────────────────────────────────────────────
// B. alwaysQueue / alwaysCancel (2)
// ─────────────────────────────────────────────────────────────

describe("mid-turn — B. always-* stocks", () => {
  const ctx = { turnIndex: 0, stillStreaming: true } as const

  test("HELL-5: alwaysQueue → action=queue regardless of mode", () => {
    expect(alwaysQueuePolicy.decide(mkInput("a", { mode: "queue" }), ctx).action).toBe("queue")
    expect(alwaysQueuePolicy.decide(mkInput("a", { mode: "cancel-and-replace" }), ctx).action).toBe(
      "queue",
    )
    expect(alwaysQueuePolicy.decide(mkInput("a", { mode: "cancel-and-amend" }), ctx).action).toBe(
      "queue",
    )
  })

  test("HELL-6: alwaysCancel → action=cancel regardless of mode", () => {
    expect(alwaysCancelPolicy.decide(mkInput("a", { mode: "queue" }), ctx).action).toBe("cancel")
    expect(
      alwaysCancelPolicy.decide(mkInput("a", { mode: "cancel-and-replace" }), ctx).action,
    ).toBe("cancel")
    expect(alwaysCancelPolicy.decide(mkInput("a", { mode: "cancel-and-amend" }), ctx).action).toBe(
      "cancel",
    )
  })
})

// ─────────────────────────────────────────────────────────────
// C. capture → planQueue (8)
// ─────────────────────────────────────────────────────────────

describe("mid-turn — C. capture → planQueue", () => {
  test("HELL-7: mode=queue enqueues with correct 12-field shape", async () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    const decision = await cap.capture(mkInput("hello", { mode: "queue", observedTurnIndex: 3 }))
    expect(decision.action).toBe("queue")
    const peek = pq.peek("t1")
    expect(peek.length).toBe(1)
    const fu = peek[0] as FollowUp
    expect(fu.threadId).toBe("t1")
    expect(fu.text).toBe("hello")
    expect(fu.source).toBe("user_keystroke")
    expect(fu.pausedReason).toBe("tool_in_flight")
    expect(fu.arrivedDuringTurn).toBe(3)
    expect(fu.urgent).toBe(false)
    expect(fu.metadata.midTurnMode).toBe("queue")
    // queue mode → no cancelCause in metadata
    expect(fu.metadata.cancelCause).toBeUndefined()
  })

  test("HELL-8: mode=cancel-and-replace → enqueue with metadata.midTurnMode=cancel-and-replace, decision.action=cancel", async () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    const d = await cap.capture(mkInput("stop", { mode: "cancel-and-replace" }))
    expect(d.action).toBe("cancel")
    const fu = pq.peek("t1")[0] as FollowUp
    expect(fu.metadata.midTurnMode).toBe("cancel-and-replace")
    expect(fu.metadata.cancelCause).toBe("user-abort")
  })

  test("HELL-9: mode=cancel-and-amend → urgent=true (attention signal)", async () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    await cap.capture(mkInput("also Y", { mode: "cancel-and-amend" }))
    const fu = pq.peek("t1")[0] as FollowUp
    expect(fu.urgent).toBe(true)
    expect(fu.metadata.midTurnMode).toBe("cancel-and-amend")
  })

  test("HELL-10: same text within same turn → planQueue dedup applied (peek count = 1)", async () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    await cap.capture(mkInput("dup", { mode: "queue", observedTurnIndex: 2 }))
    await cap.capture(mkInput("dup", { mode: "queue", observedTurnIndex: 2 }))
    expect(pq.peek("t1").length).toBe(1)
  })

  test("HELL-11: capture with no planQueue → returns decision, no throw, peek=[]", async () => {
    const cap = defaultMidTurnCapture({ threadId: "t1" })
    const d = await cap.capture(mkInput("x", { mode: "cancel-and-replace" }))
    expect(d.action).toBe("cancel")
    expect(cap.peek()).toEqual([])
  })

  test("HELL-12: policy throws → synthetic {action:'queue', reason:'policy-error'} (NO-THROW)", async () => {
    const boom: InterruptionPolicy = {
      decide: () => {
        throw new Error("policy exploded")
      },
    }
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1", policy: boom })
    const d = await cap.capture(mkInput("x", { mode: "cancel-and-replace" }))
    expect(d.action).toBe("queue")
    expect(d.reason).toBe("policy-error")
    // Nothing should be enqueued when the policy itself failed (we bail
    // before touching the plan-queue).
    expect(pq.peek("t1")).toEqual([])
  })

  test("HELL-13: observedTurnIndex preserved → FollowUp.arrivedDuringTurn", async () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    await cap.capture(mkInput("x", { mode: "queue", observedTurnIndex: 17 }))
    const fu = pq.peek("t1")[0] as FollowUp
    expect(fu.arrivedDuringTurn).toBe(17)
  })

  test("HELL-14: cancelCause defaults to 'user-abort' when mode=cancel-*", async () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    await cap.capture(mkInput("a", { mode: "cancel-and-replace" }))
    await cap.capture(mkInput("b", { mode: "cancel-and-amend" }))
    const peek = pq.peek("t1")
    const replace = peek.find((f) => f.text === "a") as FollowUp
    const amend = peek.find((f) => f.text === "b") as FollowUp
    expect(replace.metadata.cancelCause).toBe("user-abort")
    expect(amend.metadata.cancelCause).toBe("user-abort")
  })
})

// ─────────────────────────────────────────────────────────────
// D. drainForTurn (4)
// ─────────────────────────────────────────────────────────────

describe("mid-turn — D. drainForTurn", () => {
  test("HELL-15: 3 queued → drain returns 3 in order", async () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    await cap.capture(mkInput("a", { mode: "queue", observedTurnIndex: 0 }))
    await cap.capture(mkInput("b", { mode: "queue", observedTurnIndex: 0 }))
    await cap.capture(mkInput("c", { mode: "queue", observedTurnIndex: 0 }))
    const drained = await cap.drainForTurn(1)
    expect(drained.map((d) => d.text)).toEqual(["a", "b", "c"])
  })

  test("HELL-16: drain marks entries drained → peek empty after", async () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    await cap.capture(mkInput("a", { mode: "queue" }))
    await cap.capture(mkInput("b", { mode: "queue" }))
    await cap.drainForTurn(1)
    expect(cap.peek()).toEqual([])
  })

  test("HELL-17: drain on empty queue → empty array", async () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    const drained = await cap.drainForTurn(1)
    expect(drained).toEqual([])
  })

  test("HELL-18: urgent ordering preserved across drain", async () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    // mode=queue (non-urgent) followed by mode=cancel-and-amend (urgent)
    await cap.capture(mkInput("plain1", { mode: "queue" }))
    await cap.capture(mkInput("urgent1", { mode: "cancel-and-amend" }))
    await cap.capture(mkInput("plain2", { mode: "queue" }))
    const drained = await cap.drainForTurn(1)
    // urgent first, then enqueued order
    expect(drained[0]?.text).toBe("urgent1")
    expect(drained[1]?.text).toBe("plain1")
    expect(drained[2]?.text).toBe("plain2")
  })
})

// ─────────────────────────────────────────────────────────────
// E. peek (2)
// ─────────────────────────────────────────────────────────────

describe("mid-turn — E. peek", () => {
  test("HELL-19: peek returns array copy — mutation doesn't affect store", async () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    await cap.capture(mkInput("a", { mode: "queue" }))
    const snap1 = cap.peek()
    // Try to mutate the returned array; cast to a mutable view.
    ;(snap1 as MidTurnInput[]).length = 0
    const snap2 = cap.peek()
    expect(snap2.length).toBe(1)
  })

  test("HELL-20: peek empty → []", () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    expect(cap.peek()).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────
// F. cancel cause integration (2)
// ─────────────────────────────────────────────────────────────

describe("mid-turn — F. cancelCause integration", () => {
  test("HELL-21: explicit cancelCause preserved (caller controls)", async () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    // Caller passes an explicit cancelCause. Today only "user-abort" is in
    // the closed enum — the test pins that explicit values are preserved
    // (not overwritten by the default-fill path).
    await cap.capture(mkInput("x", { mode: "cancel-and-replace", cancelCause: "user-abort" }))
    const fu = pq.peek("t1")[0] as FollowUp
    expect(fu.metadata.cancelCause).toBe("user-abort")
  })

  test("HELL-22: cancelCause OMITTED in metadata when mode=queue (exactOptional)", async () => {
    const pq = freshPlanQueue()
    const cap = defaultMidTurnCapture({ planQueue: pq, threadId: "t1" })
    await cap.capture(mkInput("x", { mode: "queue" }))
    const fu = pq.peek("t1")[0] as FollowUp
    // Use hasOwn to assert the property is truly absent, not just undefined.
    expect(Object.hasOwn(fu.metadata, "cancelCause")).toBe(false)
    // Roundtrip via drain → MidTurnInput: cancelCause should be omitted.
    const drained = await cap.drainForTurn(1)
    expect(drained[0]).toBeDefined()
    expect(Object.hasOwn(drained[0] as object, "cancelCause")).toBe(false)
  })
})
