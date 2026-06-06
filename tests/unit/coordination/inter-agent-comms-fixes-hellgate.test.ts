/**
 * Regression battery for the inter-agent-communication audit fixes (jun-07).
 *
 * Each `describe` pins ONE confirmed defect so a future refactor that
 * reintroduces it goes red:
 *   - BUG#1 + Finding 2 — mailbox broadcast delivery must be PER-RECIPIENT, not
 *     a single watermark cursor: a `limit`- or `since`-truncated read must NOT
 *     mark undelivered broadcasts as seen.
 *   - Finding 3 — DAG `markFailed` must not retroactively flip a `completed`
 *     node to `failed` (mirror `onComplete`'s terminal-state guard).
 *
 * (BUG#2 team-membership removal lives in the subagent-runner test; BUG#4
 * followup_task addressing lives in the turn-wake/introspect tests; BUG#3 broker
 * dead-code removal is proven by the rewritten team-broker batteries.)
 */

import { describe, expect, test } from "bun:test"
import { createSubagentMailbox } from "@/agent/subagent-mailbox"
import { createDagGate } from "@/subagent/coordination"

describe("mailbox — broadcast delivery is per-recipient (BUG#1)", () => {
  test("limit < pending broadcasts loses NOTHING across successive drains", () => {
    let t = 0
    const mb = createSubagentMailbox({ now: () => ++t }) // monotonic distinct sentAt
    for (let i = 0; i < 5; i++) {
      mb.send({ from: "S", to: "*", kind: "broadcast", body: `b${i}` })
    }
    const got: string[] = []
    for (let r = 0; r < 6; r++) {
      const batch = mb.read("A", { limit: 2 })
      if (batch.length === 0) break
      got.push(...batch.map((m) => m.body))
    }
    expect(got.sort()).toEqual(["b0", "b1", "b2", "b3", "b4"])
  })

  test("ALL broadcasts at the SAME sentAt survive limit=1 drains (tie hazard)", () => {
    const mb = createSubagentMailbox({ now: () => 1000 }) // every send shares one ms
    for (let i = 0; i < 4; i++) {
      mb.send({ from: "S", to: "*", kind: "broadcast", body: `t${i}` })
    }
    const got: string[] = []
    for (let r = 0; r < 8; r++) {
      const batch = mb.read("A", { limit: 1 })
      if (batch.length === 0) break
      got.push(...batch.map((m) => m.body))
    }
    expect(got.sort()).toEqual(["t0", "t1", "t2", "t3"])
  })

  test("read({since}) does not silently consume an older unseen broadcast (Finding 2)", () => {
    let t = 0
    const mb = createSubagentMailbox({ now: () => ++t })
    mb.send({ from: "S", to: "*", kind: "broadcast", body: "old" }) // sentAt 1
    mb.send({ from: "S", to: "A", kind: "request", body: "direct" }) // sentAt 2
    // A reads only messages newer than sentAt 1 → just the direct message.
    expect(mb.read("A", { since: 1 }).map((m) => m.body)).toEqual(["direct"])
    // The older broadcast must STILL be deliverable — the since-read must not
    // have advanced a watermark past it.
    expect(mb.read("A").map((m) => m.body)).toEqual(["old"])
  })

  test("broadcast still: once-per-agent, never-to-sender, idempotent", () => {
    let t = 0
    const mb = createSubagentMailbox({ now: () => ++t })
    mb.send({ from: "S", to: "*", kind: "broadcast", body: "hi" })
    expect(mb.read("S").map((m) => m.body)).toEqual([]) // never to sender
    expect(mb.read("A").map((m) => m.body)).toEqual(["hi"])
    expect(mb.read("A").map((m) => m.body)).toEqual([]) // idempotent re-read
    expect(mb.read("B").map((m) => m.body)).toEqual(["hi"]) // once per OTHER agent
  })

  test("direct mail stays per-recipient (one sibling cannot consume another's)", () => {
    let t = 0
    const mb = createSubagentMailbox({ now: () => ++t })
    mb.send({ from: "S", to: "A", kind: "request", body: "for-A" })
    expect(mb.read("B").map((m) => m.body)).toEqual([]) // B never sees A's direct mail
    expect(mb.read("A").map((m) => m.body)).toEqual(["for-A"])
  })
})

describe("mailbox — eviction keeps broadcasts still PENDING for a known reader", () => {
  test("under maxRetained pressure a fully-delivered broadcast is reclaimed BEFORE one still pending for a known sibling", () => {
    let t = 0
    const mb = createSubagentMailbox({ now: () => ++t, maxRetained: 1 })
    // A and B both become KNOWN readers by draining once.
    mb.send({ from: "S", to: "*", kind: "broadcast", body: "warmup" })
    mb.read("A")
    mb.read("B")

    // Y (older) is read by A only ⇒ still PENDING for known reader B.
    mb.send({ from: "S", to: "*", kind: "broadcast", body: "Y" })
    mb.read("A") // A drains: gets warmup-already-seen? no — gets Y
    // X (newer) is read by BOTH ⇒ fully delivered.
    mb.send({ from: "S", to: "*", kind: "broadcast", body: "X" })
    mb.read("A")
    mb.read("B")

    // The buffer is over capacity; eviction must drop the FULLY-delivered X, not
    // the pending-for-B Y. So B can still receive Y.
    expect(mb.read("B").map((m) => m.body)).toContain("Y")
  })

  test("a broadcast read by ALL known readers is evictable (does not pin the buffer)", () => {
    let t = 0
    const mb = createSubagentMailbox({ now: () => ++t, maxRetained: 1 })
    mb.send({ from: "S", to: "*", kind: "broadcast", body: "first" })
    mb.read("A") // only A is ever a known reader
    mb.send({ from: "S", to: "*", kind: "broadcast", body: "second" })
    mb.read("A")
    // 'first' is fully delivered to the only known reader (A) ⇒ reclaimable; the
    // buffer did not overflow past maxRetained.
    expect(mb.read("A").map((m) => m.body)).toEqual([]) // A is fully drained
  })
})

describe("dag-gate — markFailed cannot resurrect a terminal node (Finding 3)", () => {
  test("markFailed after markComplete does NOT retroactively block a dependent", async () => {
    const r = createDagGate([
      { id: "a", dependsOn: [], state: "pending" },
      { id: "b", dependsOn: ["a"], state: "pending" },
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    r.gate.markComplete("a") // a done → b ready
    expect(await r.gate.awaitReady("b")).toBe("ready")
    r.gate.markFailed("a") // must be a NO-OP (a is already completed)
    // A fresh awaiter on b must still resolve "ready" — a stayed completed.
    expect(await r.gate.awaitReady("b")).toBe("ready")
    expect(r.gate.blocked().map((n) => n.id)).not.toContain("b")
  })

  test("markFailed still works on a non-terminal (pending) node", async () => {
    const r = createDagGate([
      { id: "a", dependsOn: [], state: "pending" },
      { id: "b", dependsOn: ["a"], state: "pending" },
    ])
    if (!r.ok) return
    r.gate.markFailed("a") // a pending → failed
    expect(await r.gate.awaitReady("b")).toBe("blocked")
  })
})
