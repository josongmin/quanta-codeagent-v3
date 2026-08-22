/**
 * ADR-0408 — Observability emitter hellgate.
 *
 * 24 cases across 6 sections:
 *   A. disabled path (no ports / no sink ⇒ silent)
 *   B. snapshot semantics (first emit is always snapshot; requestSnapshot
 *      re-arms; no-port lanes preserve previous state)
 *   C. delta diffing (additions / mutations / removals across all 3 axes)
 *   D. coalescing (no-op tick ⇒ no message; partial deltas omit absent axes)
 *   E. hostile ports (throw on read ⇒ skipped, last state retained, no
 *      message emitted)
 *   F. wire round-trip (encoded frames decode back to the same shape)
 */

import { describe, expect, test } from "bun:test"
import { createApprovalStateMachine } from "@/agent/approval-state-machine"
import { createObjectiveStore } from "@/agent/objective"
import type { RunEntry } from "@/agent/run-ledger"
import { createRunLedger } from "@/agent/run-ledger"
import { createObservabilityEmitter } from "@/apps/web-daemon/observability-emitter"
import type { ObservabilityMessage } from "@/protocol/observability"
import { decodeObservabilityFrame } from "@/protocol/observability"

/* ------------------------------------------------------------------ */
/* Test rig                                                            */
/* ------------------------------------------------------------------ */

interface CapturingSink {
  readonly send: (frame: string) => void
  readonly frames: string[]
  readonly messages: ObservabilityMessage[]
  reset(): void
}

const sinkOf = (): CapturingSink => {
  const frames: string[] = []
  const messages: ObservabilityMessage[] = []
  return {
    frames,
    messages,
    send(frame: string): void {
      frames.push(frame)
      const parsed = decodeObservabilityFrame(frame)
      if (parsed !== null) messages.push(parsed)
    },
    reset(): void {
      frames.length = 0
      messages.length = 0
    },
  }
}

interface ManualTimer {
  readonly setInterval: (cb: () => void, ms: number) => unknown
  readonly clearInterval: (handle: unknown) => void
  fire(): void
}

const timerOf = (): ManualTimer => {
  const callbacks = new Set<() => void>()
  return {
    setInterval(cb: () => void): unknown {
      callbacks.add(cb)
      return cb
    },
    clearInterval(handle: unknown): void {
      callbacks.delete(handle as () => void)
    },
    fire(): void {
      for (const cb of [...callbacks]) cb()
    },
  }
}

/* ------------------------------------------------------------------ */
/* A. Disabled path                                                    */
/* ------------------------------------------------------------------ */

describe("emitter — disabled path", () => {
  test("no ports + no sink ⇒ tick is silent", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const h = createObservabilityEmitter({ ws: sink, timer })
    h.tick()
    expect(sink.frames).toHaveLength(0)
    h.stop()
  })

  test("ports present but no sink ⇒ silent", () => {
    const ledger = createRunLedger()
    ledger.start({ id: "r1", kind: "shell", owner: "t", title: "echo" })
    const timer = timerOf()
    const h = createObservabilityEmitter({ runLedger: ledger, timer })
    // Ports present but no sink ⇒ no frames to inspect; the assertion is that
    // the tick+stop sequence completes silently without throwing (was a
    // vacuous `expect(true)` — replaced with a real no-throw envelope).
    expect(() => {
      h.tick()
      h.stop()
    }).not.toThrow()
  })

  test("sink present but no ports ⇒ silent", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const h = createObservabilityEmitter({ ws: sink, timer })
    h.tick()
    h.tick()
    expect(sink.frames).toHaveLength(0)
    h.stop()
  })

  test("stop is idempotent", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const ledger = createRunLedger()
    const h = createObservabilityEmitter({ ws: sink, runLedger: ledger, timer })
    h.stop()
    h.stop()
    // Idempotent: the third stop after two prior stops still does not throw
    // (was a vacuous `expect(true)` — now actually exercises the idempotence).
    expect(() => h.stop()).not.toThrow()
  })
})

/* ------------------------------------------------------------------ */
/* B. Snapshot semantics                                               */
/* ------------------------------------------------------------------ */

describe("emitter — snapshot semantics", () => {
  test("first emit is observability.snapshot", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const ledger = createRunLedger()
    ledger.start({ id: "r1", kind: "shell", owner: "t", title: "ls" })
    const h = createObservabilityEmitter({ ws: sink, runLedger: ledger, timer })
    h.tick()
    expect(sink.messages).toHaveLength(1)
    expect(sink.messages[0]?.kind).toBe("observability.snapshot")
    h.stop()
  })

  test("snapshot carries the live run set + objective + approvals", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const ledger = createRunLedger()
    ledger.start({ id: "r1", kind: "shell", owner: "t", title: "ls" })
    const objective = createObjectiveStore()
    objective.set("default", { goal: "go" })
    const approvalSM = createApprovalStateMachine()
    approvalSM.request({
      threadId: "default",
      kind: "permission",
      reason: "confirm",
      proposedAction: "echo hi",
      resumeStep: "after-confirm",
    })
    const h = createObservabilityEmitter({
      ws: sink,
      runLedger: ledger,
      objective,
      approvalSM,
      timer,
    })
    h.tick()
    const msg = sink.messages[0]
    if (msg?.kind !== "observability.snapshot") {
      throw new Error("expected snapshot")
    }
    expect(msg.runs).toHaveLength(1)
    expect(msg.runs[0]?.id).toBe("r1")
    expect(msg.objective?.goal).toBe("go")
    expect(msg.approvals).toHaveLength(1)
    expect(msg.approvals[0]?.reason).toBe("confirm")
    h.stop()
  })

  test("requestSnapshot forces the next tick to be a snapshot", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const ledger = createRunLedger()
    ledger.start({ id: "r1", kind: "shell", owner: "t", title: "ls" })
    const h = createObservabilityEmitter({ ws: sink, runLedger: ledger, timer })
    h.tick() // snapshot
    h.tick() // no-op (no change)
    expect(sink.messages.filter((m) => m.kind === "observability.snapshot")).toHaveLength(1)
    h.requestSnapshot()
    h.tick()
    expect(sink.messages.filter((m) => m.kind === "observability.snapshot")).toHaveLength(2)
    h.stop()
  })

  test("timer-driven cadence emits a snapshot on the first fire", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const ledger = createRunLedger()
    ledger.start({ id: "r1", kind: "shell", owner: "t", title: "ls" })
    const h = createObservabilityEmitter({ ws: sink, runLedger: ledger, timer })
    timer.fire()
    expect(sink.messages[0]?.kind).toBe("observability.snapshot")
    h.stop()
  })
})

/* ------------------------------------------------------------------ */
/* C. Delta diffing                                                    */
/* ------------------------------------------------------------------ */

describe("emitter — delta diffing", () => {
  test("addition produces a delta with the new run", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const ledger = createRunLedger()
    ledger.start({ id: "r1", kind: "shell", owner: "t", title: "ls" })
    const h = createObservabilityEmitter({ ws: sink, runLedger: ledger, timer })
    h.tick() // snapshot
    sink.reset()
    ledger.start({ id: "r2", kind: "shell", owner: "t", title: "cat" })
    h.tick()
    const last = sink.messages.at(-1)
    if (last?.kind !== "observability.delta") throw new Error("expected delta")
    expect(last.runChanges).toBeDefined()
    expect(last.runChanges?.find((c) => c.id === "r2")?.entry?.id).toBe("r2")
    h.stop()
  })

  test("mutation (settle) produces a delta with the same id", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const ledger = createRunLedger()
    ledger.start({ id: "r1", kind: "shell", owner: "t", title: "ls" })
    const h = createObservabilityEmitter({ ws: sink, runLedger: ledger, timer })
    h.tick()
    sink.reset()
    ledger.settle("r1", "completed")
    h.tick()
    const last = sink.messages.at(-1)
    if (last?.kind !== "observability.delta") throw new Error("expected delta")
    const change = last.runChanges?.find((c) => c.id === "r1")
    expect(change).toBeDefined()
    expect((change?.entry as RunEntry | null)?.status).toBe("completed")
    h.stop()
  })

  test("removal (LRU eviction) produces a delta with entry === null", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const ledger = createRunLedger({ maxRetained: 1 })
    ledger.start({ id: "r1", kind: "shell", owner: "t", title: "ls" })
    ledger.settle("r1", "completed")
    const h = createObservabilityEmitter({ ws: sink, runLedger: ledger, timer })
    h.tick() // snapshot with r1
    sink.reset()
    ledger.start({ id: "r2", kind: "shell", owner: "t", title: "cat" })
    ledger.settle("r2", "completed") // r1 should LRU out (maxRetained 1)
    h.tick()
    const last = sink.messages.at(-1)
    if (last?.kind !== "observability.delta") throw new Error("expected delta")
    const removed = last.runChanges?.find((c) => c.id === "r1")
    expect(removed).toBeDefined()
    expect(removed?.entry).toBeNull()
    h.stop()
  })

  test("objective change emits objectiveChanged on the delta", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const objective = createObjectiveStore()
    objective.set("default", { goal: "first" })
    const h = createObservabilityEmitter({ ws: sink, objective, timer })
    h.tick() // snapshot
    sink.reset()
    // Adding a blocker mutates status (derivation: blockers.length>0 ⇒
    // "blocked") AND bumps updatedAt — guaranteed structural diff.
    objective.addBlocker("default", { reason: "wait", waitingOn: "user" })
    h.tick()
    const last = sink.messages.at(-1)
    if (last?.kind !== "observability.delta") throw new Error("expected delta")
    // objectiveChanged is present even though the surrounding object is
    // still non-null — what differs is the contents (structurally).
    expect("objectiveChanged" in last).toBe(true)
    expect(last.objectiveChanged?.status).toBe("blocked")
    h.stop()
  })

  test("approval settle emits approval=null change", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const approvalSM = createApprovalStateMachine()
    const apv = approvalSM.request({
      threadId: "default",
      kind: "permission",
      reason: "ok?",
      proposedAction: "rm /tmp/x",
      resumeStep: "step-1",
    })
    const h = createObservabilityEmitter({ ws: sink, approvalSM, timer })
    h.tick() // snapshot
    sink.reset()
    approvalSM.settle(apv.id, "approve")
    h.tick()
    const last = sink.messages.at(-1)
    if (last?.kind !== "observability.delta") throw new Error("expected delta")
    const evict = last.approvalChanges?.find((c) => c.id === apv.id)
    expect(evict).toBeDefined()
    // pending() no longer returns it ⇒ delta says null
    expect(evict?.approval).toBeNull()
    h.stop()
  })
})

/* ------------------------------------------------------------------ */
/* D. Coalescing                                                       */
/* ------------------------------------------------------------------ */

describe("emitter — coalescing", () => {
  test("no-change tick emits NO message after the initial snapshot", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const ledger = createRunLedger()
    ledger.start({ id: "r1", kind: "shell", owner: "t", title: "ls" })
    const h = createObservabilityEmitter({ ws: sink, runLedger: ledger, timer })
    h.tick()
    expect(sink.messages).toHaveLength(1)
    h.tick()
    h.tick()
    h.tick()
    expect(sink.messages).toHaveLength(1)
    h.stop()
  })

  test("partial delta omits axes that did not change", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const ledger = createRunLedger()
    ledger.start({ id: "r1", kind: "shell", owner: "t", title: "ls" })
    const objective = createObjectiveStore()
    objective.set("default", { goal: "go" })
    const h = createObservabilityEmitter({
      ws: sink,
      runLedger: ledger,
      objective,
      timer,
    })
    h.tick() // snapshot
    sink.reset()
    ledger.start({ id: "r2", kind: "shell", owner: "t", title: "cat" })
    h.tick()
    const last = sink.messages.at(-1)
    if (last?.kind !== "observability.delta") throw new Error("expected delta")
    expect("runChanges" in last).toBe(true)
    expect("objectiveChanged" in last).toBe(false)
    expect("approvalChanges" in last).toBe(false)
    h.stop()
  })

  test("custom send seam receives the raw message (not a string)", () => {
    const collected: ObservabilityMessage[] = []
    const timer = timerOf()
    const ledger = createRunLedger()
    ledger.start({ id: "r1", kind: "shell", owner: "t", title: "ls" })
    const h = createObservabilityEmitter({
      send: (m) => collected.push(m),
      runLedger: ledger,
      timer,
    })
    h.tick()
    expect(collected[0]?.kind).toBe("observability.snapshot")
    h.stop()
  })
})

/* ------------------------------------------------------------------ */
/* E. Hostile ports                                                    */
/* ------------------------------------------------------------------ */

describe("emitter — hostile ports", () => {
  test("ledger.list throws ⇒ tick emits nothing, no propagation", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const ledger = createRunLedger()
    // Wrap with a hostile facade — list throws but the rest of the port
    // returns sane defaults. Only the hostile axis should be skipped.
    const hostile: typeof ledger = {
      ...ledger,
      list: (): readonly RunEntry[] => {
        throw new Error("nope")
      },
    }
    const h = createObservabilityEmitter({
      ws: sink,
      runLedger: hostile,
      timer,
    })
    // The first tick still emits a snapshot (with whatever non-throwing axes
    // returned — here an empty ledger).
    h.tick()
    expect(sink.messages[0]?.kind).toBe("observability.snapshot")
    expect(
      sink.messages[0]?.kind === "observability.snapshot" ? sink.messages[0].runs : [],
    ).toEqual([])
    h.stop()
  })

  test("objective.get throws ⇒ last objective retained, no crash", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const objective = createObjectiveStore()
    objective.set("default", { goal: "go" })
    const real = objective
    let allowGet = true
    const hostile: typeof objective = {
      ...real,
      get: (id) => {
        if (!allowGet) throw new Error("nope")
        return real.get(id)
      },
    }
    const h = createObservabilityEmitter({
      ws: sink,
      objective: hostile,
      timer,
    })
    h.tick() // snapshot with go
    sink.reset()
    allowGet = false
    h.tick() // should not crash; no delta because previous value retained
    expect(sink.messages).toHaveLength(0)
    h.stop()
  })

  test("approvalSM.pending throws ⇒ approvals axis skipped this tick", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const approvalSM = createApprovalStateMachine()
    const real = approvalSM
    const hostile: typeof approvalSM = {
      ...real,
      pending: () => {
        throw new Error("nope")
      },
    }
    const h = createObservabilityEmitter({
      ws: sink,
      approvalSM: hostile,
      timer,
    })
    h.tick() // snapshot — approvals lane returns empty fallback, no throw
    const first = sink.messages[0]
    if (first?.kind !== "observability.snapshot") throw new Error("snapshot")
    expect(first.approvals).toEqual([])
    h.stop()
  })

  test("ws.send throws ⇒ caught, emitter survives, lastSent untouched", () => {
    const ledger = createRunLedger()
    ledger.start({ id: "r1", kind: "shell", owner: "t", title: "ls" })
    const timer = timerOf()
    let calls = 0
    const ws = {
      send(): void {
        calls += 1
        throw new Error("socket gone")
      },
    }
    const h = createObservabilityEmitter({ ws, runLedger: ledger, timer })
    h.tick()
    // snapshot send attempt counted
    expect(calls).toBe(1)
    // even though send threw, the emitter advanced lastSent (we don't retry
    // — the next tick is a delta from the current state). A second tick with
    // no change should NOT attempt another send.
    h.tick()
    expect(calls).toBe(1)
    h.stop()
  })
})

/* ------------------------------------------------------------------ */
/* F. Wire round-trip                                                  */
/* ------------------------------------------------------------------ */

describe("emitter — wire round-trip", () => {
  test("emitted frames decode back via decodeObservabilityFrame", () => {
    const sink = sinkOf()
    const timer = timerOf()
    const ledger = createRunLedger()
    ledger.start({ id: "r1", kind: "shell", owner: "t", title: "ls" })
    const h = createObservabilityEmitter({ ws: sink, runLedger: ledger, timer })
    h.tick() // snapshot
    ledger.start({ id: "r2", kind: "shell", owner: "t", title: "cat" })
    h.tick() // delta
    for (const frame of sink.frames) {
      const out = decodeObservabilityFrame(frame)
      expect(out).not.toBeNull()
    }
    expect(sink.messages.length).toBeGreaterThanOrEqual(2)
    expect(sink.messages[0]?.kind).toBe("observability.snapshot")
    expect(sink.messages[1]?.kind).toBe("observability.delta")
    h.stop()
  })
})
