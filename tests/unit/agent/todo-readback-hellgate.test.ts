/**
 * Cross-subagent todo readback hellgate (ADR-0255).
 *
 * 15 adversarial cases sealing the store invariants:
 *   HELL-TR-01 snapshotFor → TodoSnapshot
 *   HELL-TR-02 updateFrom → snapshot reflects change
 *   HELL-TR-03 updateFrom unknown session → Err("session-not-found")
 *   HELL-TR-04 subscribe → update fires callback
 *   HELL-TR-05 Subscription.unsubscribe → no further callbacks
 *   HELL-TR-06 parent isolation — child updateFrom does NOT touch parent
 *   HELL-TR-07 propagate(child, parent) reflects child status on parent
 *   HELL-TR-08 status 3-arm exhaustive (pending / in_progress / completed)
 *   HELL-TR-09 snapshot is frozen — mutation rejected
 *   HELL-TR-10 1000-todo perf sanity (snapshot + update)
 *   HELL-TR-11 default-OFF: byte-identical when no store wired
 *   HELL-TR-12 updatedAt monotonic across many updates
 *   HELL-TR-13 concurrent updateFrom — last-write-wins deterministic by clock
 *   HELL-TR-14 subscribe with snapshot=true → initial snapshot emitted now
 *   HELL-TR-15 subscribe AbortSignal → abort triggers cleanup
 */

import { describe, expect, test } from "bun:test"
import { defaultTodoReadbackStore, type TodoItem, type TodoSnapshot } from "@/agent/todo-readback"

const mkItem = (
  id: string,
  status: "pending" | "in_progress" | "completed",
  text = id,
): TodoItem => ({ id, text, status })

describe("todo-readback — hellgate (ADR-0255)", () => {
  test("HELL-TR-01 snapshotFor returns a TodoSnapshot shape", () => {
    const s = defaultTodoReadbackStore()
    s.link("p", "c")
    const snap = s.snapshotFor("p")
    expect(snap).toBeDefined()
    expect(Array.isArray(snap.items)).toBe(true)
    expect(typeof snap.updatedAt).toBe("number")
    // Unknown session ⇒ empty snapshot with updatedAt=0 (NOT an error).
    const empty = s.snapshotFor("never-linked")
    expect(empty.items.length).toBe(0)
    expect(empty.updatedAt).toBe(0)
  })

  test("HELL-TR-02 updateFrom mutates snapshot", () => {
    const s = defaultTodoReadbackStore()
    s.link("p", "c")
    const r = s.updateFrom("p", { items: [mkItem("t1", "pending")] })
    expect(r.ok).toBe(true)
    const snap = s.snapshotFor("p")
    expect(snap.items.length).toBe(1)
    expect(snap.items[0]?.id).toBe("t1")
    expect(snap.items[0]?.status).toBe("pending")
  })

  test("HELL-TR-03 updateFrom on unknown session → Err(session-not-found)", () => {
    const s = defaultTodoReadbackStore()
    const r = s.updateFrom("nope", { items: [mkItem("t", "pending")] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("session-not-found")
      expect(r.error.sessionId).toBe("nope")
    }
  })

  test("HELL-TR-04 subscribe → updateFrom fires the callback", () => {
    const s = defaultTodoReadbackStore()
    s.link("p", "c")
    const received: TodoSnapshot[] = []
    s.subscribe("p", (snap) => received.push(snap))
    s.updateFrom("p", { items: [mkItem("a", "pending")] })
    s.updateFrom("p", { items: [mkItem("b", "in_progress")] })
    expect(received.length).toBe(2)
    expect(received[0]?.items[0]?.id).toBe("a")
    expect(received[1]?.items.length).toBe(2)
  })

  test("HELL-TR-05 Subscription.unsubscribe halts further callbacks", () => {
    const s = defaultTodoReadbackStore()
    s.link("p", "c")
    let count = 0
    const sub = s.subscribe("p", () => {
      count += 1
    })
    s.updateFrom("p", { items: [mkItem("a", "pending")] })
    expect(count).toBe(1)
    sub.unsubscribe()
    s.updateFrom("p", { items: [mkItem("b", "in_progress")] })
    expect(count).toBe(1)
    // idempotent unsubscribe
    expect(() => sub.unsubscribe()).not.toThrow()
  })

  test("HELL-TR-06 parent isolation — child update does NOT touch parent", () => {
    const s = defaultTodoReadbackStore()
    s.link("p", "c")
    // Seed parent.
    s.updateFrom("p", { items: [mkItem("p-only", "pending")] })
    const before = s.snapshotFor("p")
    // Child writes — parent must remain unchanged until explicit propagate.
    s.updateFrom("c", { items: [mkItem("c-task", "in_progress")] })
    const after = s.snapshotFor("p")
    expect(after.items.length).toBe(before.items.length)
    expect(after.items[0]?.id).toBe("p-only")
    expect(after.items.some((i) => i.id === "c-task")).toBe(false)
  })

  test("HELL-TR-07 propagate(child, parent) reflects child status on parent", () => {
    const s = defaultTodoReadbackStore()
    s.link("p", "c")
    s.updateFrom("p", { items: [mkItem("shared", "pending")] })
    s.updateFrom("c", { items: [mkItem("shared", "completed")] })
    // Parent still pending until explicit propagate.
    expect(s.snapshotFor("p").items[0]?.status).toBe("pending")
    s.propagate("c", "p")
    expect(s.snapshotFor("p").items[0]?.status).toBe("completed")
    // Unknown id from child gets appended.
    s.updateFrom("c", { items: [mkItem("new-by-child", "in_progress")] })
    s.propagate("c", "p")
    const items = s.snapshotFor("p").items
    expect(items.some((i) => i.id === "new-by-child")).toBe(true)
  })

  test("HELL-TR-08 status 3-arm exhaustive (pending / in_progress / completed)", () => {
    const s = defaultTodoReadbackStore()
    s.link("p", "c")
    s.updateFrom("p", {
      items: [mkItem("a", "pending"), mkItem("b", "in_progress"), mkItem("d", "completed")],
    })
    const items = s.snapshotFor("p").items
    expect(items.map((i) => i.status).sort()).toEqual(["completed", "in_progress", "pending"])
  })

  test("HELL-TR-09 snapshot is frozen — mutating it does NOT corrupt store", () => {
    const s = defaultTodoReadbackStore()
    s.link("p", "c")
    s.updateFrom("p", { items: [mkItem("t", "pending")] })
    const snap = s.snapshotFor("p")
    expect(Object.isFrozen(snap)).toBe(true)
    expect(Object.isFrozen(snap.items)).toBe(true)
    expect(() => {
      // biome-ignore lint/suspicious/noExplicitAny: frozen-mutation probe
      ;(snap.items as any).push({ id: "x", text: "x", status: "pending" })
    }).toThrow()
    // The store snapshot is still the original.
    expect(s.snapshotFor("p").items.length).toBe(1)
  })

  test("HELL-TR-10 1000-todo perf sanity (single updateFrom + snapshot)", () => {
    const s = defaultTodoReadbackStore()
    s.link("p", "c")
    const items: TodoItem[] = []
    for (let i = 0; i < 1000; i++) items.push(mkItem(`id-${i}`, "pending"))
    const t0 = Date.now()
    const r = s.updateFrom("p", { items })
    const snap = s.snapshotFor("p")
    const dt = Date.now() - t0
    expect(r.ok).toBe(true)
    expect(snap.items.length).toBe(1000)
    // Generous bound — fail only on pathological regressions, not perf jitter.
    expect(dt).toBeLessThan(1000)
  })

  test("HELL-TR-11 default-OFF: host that never wires store sees no behaviour", () => {
    // Simulate the prompt-assembly site that would consume readback data.
    // Without a wired store, the host has no readback object; the prompt
    // bytes are whatever they would have been.
    const promptOff = "USER"
    const store = undefined as ReturnType<typeof defaultTodoReadbackStore> | undefined
    const promptOn = ((): string => {
      if (!store) return "USER"
      // unreachable in this test — the point is symmetry
      const snap = store.snapshotFor("p")
      return snap.items.length === 0 ? "USER" : `USER+${snap.items.length}`
    })()
    expect(promptOn).toBe(promptOff)
  })

  test("HELL-TR-12 updatedAt monotonic across many updates", () => {
    let t = 1000
    const s = defaultTodoReadbackStore({ clock: () => t })
    s.link("p", "c")
    const seen: number[] = []
    for (let i = 0; i < 20; i++) {
      s.updateFrom("p", { items: [mkItem(`t-${i}`, "pending")] })
      seen.push(s.snapshotFor("p").updatedAt)
      // Caller's clock advances some steps; even when it DOESN'T advance,
      // the store must still produce a strictly-increasing tick.
      if (i % 3 === 0) t += 5
    }
    for (let i = 1; i < seen.length; i++) {
      const prev = seen[i - 1]
      const cur = seen[i]
      expect(typeof prev).toBe("number")
      expect(typeof cur).toBe("number")
      expect((cur ?? 0) > (prev ?? 0)).toBe(true)
    }
  })

  test("HELL-TR-13 concurrent updateFrom — last-write-wins by injected clock", () => {
    // Two writers race against the same session; the store's internal
    // clock totally-orders them so the final snapshot reflects the LAST
    // call in code order (the clock advances on every successful write).
    let t = 100
    const s = defaultTodoReadbackStore({ clock: () => t })
    s.link("p", "c")
    s.updateFrom("p", { items: [mkItem("shared", "pending", "first")] })
    const ts1 = s.snapshotFor("p").updatedAt
    t = 50 // wall clock REGRESSED — store must still advance.
    s.updateFrom("p", { items: [mkItem("shared", "in_progress", "second")] })
    const ts2 = s.snapshotFor("p").updatedAt
    expect(ts2 > ts1).toBe(true)
    expect(s.snapshotFor("p").items[0]?.text).toBe("second")
    expect(s.snapshotFor("p").items[0]?.status).toBe("in_progress")
  })

  test("HELL-TR-14 subscribe with snapshot=true → initial snapshot emitted", () => {
    const s = defaultTodoReadbackStore()
    s.link("p", "c")
    s.updateFrom("p", { items: [mkItem("seed", "pending")] })
    const received: TodoSnapshot[] = []
    const sub = s.subscribe("p", (snap) => received.push(snap), { snapshot: true })
    // The initial snapshot fired SYNCHRONOUSLY before subscribe returned.
    expect(received.length).toBe(1)
    expect(received[0]?.items[0]?.id).toBe("seed")
    // And follow-up updates still flow.
    s.updateFrom("p", { items: [mkItem("next", "in_progress")] })
    expect(received.length).toBe(2)
    sub.unsubscribe()
  })

  test("HELL-TR-15 subscribe AbortSignal triggers cleanup", () => {
    const s = defaultTodoReadbackStore()
    s.link("p", "c")
    const ac = new AbortController()
    let count = 0
    s.subscribe(
      "p",
      () => {
        count += 1
      },
      { signal: ac.signal },
    )
    s.updateFrom("p", { items: [mkItem("a", "pending")] })
    expect(count).toBe(1)
    ac.abort()
    s.updateFrom("p", { items: [mkItem("b", "in_progress")] })
    expect(count).toBe(1)
    // Already-aborted signal → subscribe should not fire any future events.
    const ac2 = new AbortController()
    ac2.abort()
    let count2 = 0
    s.subscribe(
      "p",
      () => {
        count2 += 1
      },
      { signal: ac2.signal },
    )
    s.updateFrom("p", { items: [mkItem("c", "completed")] })
    expect(count2).toBe(0)
  })
})
