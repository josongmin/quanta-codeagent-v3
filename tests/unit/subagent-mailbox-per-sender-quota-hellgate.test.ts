/**
 * ADR-0416 audit-H R2 closeout — per-sender undelivered quota hellgate.
 *
 * The default `MailboxPort` is bounded by a GLOBAL `maxRetained` (default
 * 1024) + `retentionMs`. Eviction reclaims DELIVERED-before-UNDELIVERED,
 * oldest-`sentAt` first. The "delivered-before-undelivered" tiebreaker
 * correctly preserves unread mail when there is mixed traffic — but it has
 * a subtle DoS hole when ALL traffic is undelivered:
 *
 *   Attack: a single hostile subagent floods `send({ to: "ghost-X" })` with
 *           1024 non-existent recipient ids. Every cell is `rank=1`
 *           (undelivered). The store is now FULL of `rank=1` cells. The very
 *           NEXT `send` — from a legit sibling, to a real recipient — pushes
 *           the count to 1025 and triggers the global LRU, which sorts by
 *           `rank` then `sentAt`. With every cell at `rank=1`, the eviction
 *           victim is the OLDEST undelivered cell — which is one of the
 *           attacker's, sure, but the attacker keeps flooding, eventually
 *           interleaving so that the OLDEST cell at the moment of `send` is
 *           one of the LEGIT sibling's earlier messages. Result: silent loss
 *           of sibling traffic with no error, no log, no telemetry —
 *           indistinguishable from "never sent".
 *
 * Structural fix (this hellgate pins it): `maxUndeliveredPerSender`. A
 * closed-port option. When set, a `send` that pushes the sender past its own
 * quota first evicts THAT sender's oldest undelivered cell (FIFO per-sender)
 * before falling through to the global LRU. Other senders' cells are
 * NEVER touched by the per-sender path. The blast radius of a hostile
 * flood is now CAPPED at the attacker's own quota — legitimate siblings
 * are unaffected.
 *
 * NO heuristics: a simple per-`from` counter (not a rate, not a window, not
 * a score). Default-OFF (undefined / non-positive ⇒ legacy behavior,
 * byte-identical to pre-R2).
 *
 * Coverage (~10 cases):
 *   - default-OFF: legacy LRU behavior is byte-identical (the regression
 *     guard against an accidental always-on rollout)
 *   - normal traffic under cap: zero impact (no false-positive eviction)
 *   - hostile excess: attacker's own cells evicted, NOT sibling's
 *   - eviction is FIFO within the offending sender (oldest first)
 *   - one sender's quota does NOT cap another's
 *   - quota is NOT a permanent lock: cells delivered + ack'd no longer count;
 *     fresh sends are accepted
 *   - cap=1 edge: only the most-recent undelivered cell remains
 *   - hostile-mixed-with-legit: legit recipient still reads its message
 *   - quota interacts with global LRU correctly: per-sender first, then global
 *   - hostile non-Error knob inputs (negative / NaN / 0 / Infinity) ⇒ OFF
 */

import { describe, expect, test } from "bun:test"
import { createSubagentMailbox } from "@/agent/subagent-mailbox"

/** Monotonic clock seam so every `send` gets a distinct, ordered `sentAt`. */
const tick = (): (() => number) => {
  let n = 1000
  return () => ++n
}

describe("subagent mailbox — per-sender undelivered quota (audit-H R2)", () => {
  test("(1) default-OFF: legacy global LRU behavior is byte-identical (no quota arg)", () => {
    const mb = createSubagentMailbox({ now: tick(), maxRetained: 4 })
    // 4 cells from one sender, none read → all sit undelivered.
    for (let i = 0; i < 4; i++) {
      mb.send({ from: "attacker", to: `ghost-${i}`, kind: "request", body: `m${i}` })
    }
    expect(mb.list().length).toBe(4)
    // 5th send forces global LRU to evict (delivered-before-undelivered),
    // and since EVERY cell is undelivered, the oldest-`sentAt` wins.
    mb.send({ from: "attacker", to: "ghost-4", kind: "request", body: "m4" })
    expect(mb.list().length).toBe(4)
    // Oldest (`ghost-0`) was the victim — legacy behavior, unchanged.
    expect(mb.list().some((m) => m.to === "ghost-0")).toBe(false)
    expect(mb.list().some((m) => m.to === "ghost-4")).toBe(true)
  })

  test("(2) normal traffic under cap: zero false-positive eviction", () => {
    const mb = createSubagentMailbox({
      now: tick(),
      maxRetained: 100,
      maxUndeliveredPerSender: 32,
    })
    // 10 undelivered cells from one sender — well under the 32 cap.
    for (let i = 0; i < 10; i++) {
      mb.send({ from: "legit", to: `target-${i}`, kind: "request", body: `m${i}` })
    }
    expect(mb.list().length).toBe(10)
    // All cells survive: the quota path is a NO-OP below the cap.
    for (let i = 0; i < 10; i++) {
      expect(mb.list().some((m) => m.body === `m${i}`)).toBe(true)
    }
  })

  test("(3) hostile excess evicts attacker's OWN cells, never the sibling's", () => {
    // Tiny cap (2) so the test is unambiguous.
    const mb = createSubagentMailbox({
      now: tick(),
      maxRetained: 100, // global stays high — proves per-sender path is the one acting
      maxUndeliveredPerSender: 2,
    })
    // Legit sibling sends first — its 2 messages must survive forever.
    mb.send({ from: "legit", to: "real-recipient", kind: "request", body: "legit-1" })
    mb.send({ from: "legit", to: "real-recipient", kind: "request", body: "legit-2" })
    // Attacker now floods 5 undelivered cells. Each excess send evicts the
    // attacker's OWN oldest undelivered cell first.
    for (let i = 0; i < 5; i++) {
      mb.send({ from: "attacker", to: `ghost-${i}`, kind: "request", body: `bad-${i}` })
    }
    // Legit sibling's mail is untouched.
    const bodies = mb.list().map((m) => m.body)
    expect(bodies).toContain("legit-1")
    expect(bodies).toContain("legit-2")
    // Attacker has at most 2 cells (its quota) — the LATEST 2.
    const attackerCells = mb.list().filter((m) => m.from === "attacker")
    expect(attackerCells.length).toBeLessThanOrEqual(2)
    // The oldest attacker cells (bad-0, bad-1, bad-2) were evicted — only the
    // most recent ones (bad-3, bad-4) remain.
    const attackerBodies = attackerCells.map((m) => m.body)
    expect(attackerBodies).toContain("bad-4")
    expect(attackerBodies).not.toContain("bad-0")
  })

  test("(4) eviction is FIFO within the offending sender (oldest sentAt first)", () => {
    const mb = createSubagentMailbox({
      now: tick(),
      maxRetained: 100,
      maxUndeliveredPerSender: 3,
    })
    // Send 6 from one sender; cap is 3.
    const ids: string[] = []
    for (let i = 0; i < 6; i++) {
      const m = mb.send({ from: "s", to: `t${i}`, kind: "request", body: `b${i}` })
      ids.push(m.id)
    }
    const surviving = new Set(mb.list().map((m) => m.id))
    // The 3 oldest (b0, b1, b2) are gone; the 3 newest (b3, b4, b5) remain.
    expect(surviving.has(ids[0])).toBe(false)
    expect(surviving.has(ids[1])).toBe(false)
    expect(surviving.has(ids[2])).toBe(false)
    expect(surviving.has(ids[3])).toBe(true)
    expect(surviving.has(ids[4])).toBe(true)
    expect(surviving.has(ids[5])).toBe(true)
  })

  test("(5) one sender's quota does NOT cap another's", () => {
    const mb = createSubagentMailbox({
      now: tick(),
      maxRetained: 100,
      maxUndeliveredPerSender: 2,
    })
    // Sender A: 2 sends (at cap, no eviction yet).
    mb.send({ from: "A", to: "ta1", kind: "request", body: "a1" })
    mb.send({ from: "A", to: "ta2", kind: "request", body: "a2" })
    // Sender B: also 2 sends — independent quota, neither A nor B is over.
    mb.send({ from: "B", to: "tb1", kind: "request", body: "b1" })
    mb.send({ from: "B", to: "tb2", kind: "request", body: "b2" })
    // All four survive.
    expect(mb.list().length).toBe(4)
    const bodies = mb.list().map((m) => m.body)
    expect(bodies).toEqual(expect.arrayContaining(["a1", "a2", "b1", "b2"]))
  })

  test("(6) quota is NOT a permanent lock: delivered cells no longer count", () => {
    const mb = createSubagentMailbox({
      now: tick(),
      maxRetained: 100,
      maxUndeliveredPerSender: 2,
    })
    // Fill to cap.
    mb.send({ from: "s", to: "x", kind: "request", body: "1" })
    mb.send({ from: "s", to: "x", kind: "request", body: "2" })
    // Recipient reads → both cells now delivered. The sender's undelivered
    // tally drops to 0 — fresh sends are accepted without evicting anything.
    expect(mb.read("x").length).toBe(2)
    mb.send({ from: "s", to: "x", kind: "request", body: "3" })
    mb.send({ from: "s", to: "x", kind: "request", body: "4" })
    // All 4 cells coexist: 2 delivered + 2 fresh undelivered.
    expect(mb.list().length).toBe(4)
    expect(
      mb
        .list()
        .map((m) => m.body)
        .sort(),
    ).toEqual(["1", "2", "3", "4"])
  })

  test("(7) cap=1 edge: only the most-recent undelivered cell from the sender remains", () => {
    const mb = createSubagentMailbox({
      now: tick(),
      maxRetained: 100,
      maxUndeliveredPerSender: 1,
    })
    for (let i = 0; i < 5; i++) {
      mb.send({ from: "s", to: `t${i}`, kind: "request", body: `m${i}` })
    }
    const own = mb.list().filter((m) => m.from === "s")
    expect(own.length).toBe(1)
    expect(own[0].body).toBe("m4")
  })

  test("(8) hostile-mixed-with-legit: real recipient still reads its message", () => {
    const mb = createSubagentMailbox({
      now: tick(),
      maxRetained: 1024,
      maxUndeliveredPerSender: 32,
    })
    // Legit sibling's lone message.
    mb.send({ from: "legit", to: "alice", kind: "request", body: "hi alice" })
    // Attacker floods 64 ghost sends — 2× quota.
    for (let i = 0; i < 64; i++) {
      mb.send({ from: "attacker", to: `ghost-${i}`, kind: "request", body: `flood-${i}` })
    }
    // Attacker is capped at 32 of its own undelivered cells.
    const attackerCount = mb.list().filter((m) => m.from === "attacker").length
    expect(attackerCount).toBeLessThanOrEqual(32)
    // Alice reads — legit message survives + is delivered.
    const inbox = mb.read("alice")
    expect(inbox.length).toBe(1)
    expect(inbox[0].body).toBe("hi alice")
  })

  test("(9) quota + global LRU interaction: per-sender first, then global if needed", () => {
    // Tight maxRetained AND tight per-sender — they compose.
    const mb = createSubagentMailbox({
      now: tick(),
      maxRetained: 3,
      maxUndeliveredPerSender: 2,
    })
    // A sends 3 → quota evicts oldest A; only 2 A's remain.
    mb.send({ from: "A", to: "x", kind: "request", body: "a1" })
    mb.send({ from: "A", to: "x", kind: "request", body: "a2" })
    mb.send({ from: "A", to: "x", kind: "request", body: "a3" })
    // B sends 2 → B is under its quota; global stays at 4 > 3.
    // Global LRU then triggers, evicting the oldest at `rank=1` — which is a2
    // (A's oldest remaining), preserving b1/b2/a3.
    mb.send({ from: "B", to: "y", kind: "request", body: "b1" })
    mb.send({ from: "B", to: "y", kind: "request", body: "b2" })
    expect(mb.list().length).toBe(3)
    const bodies = mb.list().map((m) => m.body)
    // a1 is gone (per-sender quota), a2 is gone (global LRU), a3 survives.
    expect(bodies).not.toContain("a1")
    expect(bodies).toContain("a3")
    expect(bodies).toContain("b1")
    expect(bodies).toContain("b2")
  })

  test("(10) hostile knob inputs (negative / NaN / 0 / Infinity) degrade to OFF", () => {
    // Each invalid value MUST be treated as "no quota" (legacy behavior).
    for (const bad of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
      const mb = createSubagentMailbox({
        now: tick(),
        maxRetained: 1000,
        maxUndeliveredPerSender: bad,
      })
      // Send 10 from one sender — no quota path means none get evicted.
      for (let i = 0; i < 10; i++) {
        mb.send({ from: "s", to: `t${i}`, kind: "request", body: `m${i}` })
      }
      expect(mb.list().length).toBe(10)
    }
  })

  test("(11) byte-identical regression: without the knob, (17) LRU semantics unchanged", () => {
    // The exact scenario from the existing test (17) — proves the new code
    // path is completely dormant when the knob is absent.
    const mb = createSubagentMailbox({ now: tick(), maxRetained: 2 })
    const m1 = mb.send({ from: "root", to: "x", kind: "request", body: "1" })
    mb.read("x") // m1 delivered
    mb.send({ from: "root", to: "y", kind: "request", body: "2" })
    mb.send({ from: "root", to: "z", kind: "request", body: "3" })
    const ids = mb.list().map((m) => m.id)
    expect(ids).not.toContain(m1.id)
    expect(mb.list().length).toBe(2)
  })
})
