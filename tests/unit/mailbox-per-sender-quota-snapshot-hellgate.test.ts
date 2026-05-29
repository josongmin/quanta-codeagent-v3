/**
 * R3 audit-H closeout — `fromSnapshot` per-sender quota application.
 *
 * R2 introduced `maxUndeliveredPerSender` but only applied it at `send()`
 * time. An adversarial snapshot (sourced from another process, peer-to-peer
 * sync, persisted state) could seed any number of undelivered cells past
 * the per-sender cap, and the in-memory state after `fromSnapshot()` would
 * sit ABOVE the cap silently. The `send`-time path would never reclaim the
 * excess because `enforcePerSenderQuota` only evicts AT EXCESS — once
 * imported, the cells stay until the global LRU catches them, but they
 * still occupy slots and re-create the audit-H R2 DoS surface (legit
 * sibling mail still gets crowded out at the same `rank=1` tier).
 *
 * Structural fix (this hellgate pins it): `fromSnapshot` now calls
 * `enforcePerSenderQuotaAll(cells, cursors, cap)` after rebuilding the
 * cell map. Every distinct sender in the snapshot is bounded to `cap`
 * (FIFO per-sender). Default-OFF: when the quota is undefined, the
 * snapshot is imported byte-identical to legacy behavior.
 *
 * Five adversarial scenarios:
 *   (1) cap=2, snapshot seeds 5 undelivered cells from `attacker` →
 *       cells.size === 2 + oldest 3 evicted
 *   (2) two distinct senders, cap=2; attacker has 5, sibling has 2
 *       → attacker capped at 2, sibling untouched
 *   (3) cap unset (default-OFF): snapshot with 100 cells passes through
 *       (legacy byte-identical)
 *   (4) snapshot mixes DELIVERED + UNDELIVERED for same sender; quota
 *       only counts undelivered, delivered cells survive
 *   (5) `fromSnapshot` then `send()`: the round-trip is consistent —
 *       post-import quota does not double-evict on the next `send`
 */

import { describe, expect, test } from "bun:test"
import {
  createSubagentMailbox,
  type MailboxMessage,
  type MailboxSnapshot,
} from "@/agent/subagent-mailbox"

const tick = (): (() => number) => {
  let n = 1000
  return () => ++n
}

/** Build a synthetic snapshot for testing — bypasses the public `send` so we
 *  can seed an arbitrarily large state (the adversarial vector). */
const synthSnapshot = (cells: readonly Partial<MailboxMessage>[]): MailboxSnapshot => ({
  messages: cells.map((c, i) => ({
    id: c.id ?? `msg_seed_${i}`,
    from: c.from ?? "",
    to: c.to ?? "",
    kind: c.kind ?? "request",
    body: c.body ?? "",
    sentAt: c.sentAt ?? 1000 + i,
    ...(c.correlationId !== undefined ? { correlationId: c.correlationId } : {}),
    ...(c.deliveredAt !== undefined ? { deliveredAt: c.deliveredAt } : {}),
  })),
})

describe("R3 audit-H — fromSnapshot per-sender quota (snapshot hole)", () => {
  test("(1) cap=2: 5 undelivered cells from same sender → trimmed to 2 oldest evicted", () => {
    const mb = createSubagentMailbox({
      now: tick(),
      maxRetained: 100,
      maxUndeliveredPerSender: 2,
    })
    const snap = synthSnapshot(
      [0, 1, 2, 3, 4].map((i) => ({
        id: `msg_a${i}`,
        from: "attacker",
        to: `ghost-${i}`,
        kind: "request",
        body: `m${i}`,
        sentAt: 1000 + i,
      })),
    )
    mb.fromSnapshot(snap)
    const all = mb.list()
    expect(all.length).toBe(2)
    // FIFO per-sender: oldest 3 (a0/a1/a2) evicted; newest 2 (a3/a4) survive.
    const tos = all.map((m) => m.to).sort()
    expect(tos).toEqual(["ghost-3", "ghost-4"])
  })

  test("(2) two senders, cap=2: attacker capped, sibling untouched", () => {
    const mb = createSubagentMailbox({
      now: tick(),
      maxRetained: 100,
      maxUndeliveredPerSender: 2,
    })
    const seeds: Partial<MailboxMessage>[] = []
    for (let i = 0; i < 5; i++) {
      seeds.push({
        id: `msg_atk${i}`,
        from: "attacker",
        to: `ghost-${i}`,
        kind: "request",
        body: `atk-${i}`,
        sentAt: 1000 + i,
      })
    }
    // Sibling has 2 cells (at cap, not over).
    seeds.push({
      id: "msg_sib0",
      from: "sibling",
      to: "root",
      kind: "request",
      body: "legit-0",
      sentAt: 2000,
    })
    seeds.push({
      id: "msg_sib1",
      from: "sibling",
      to: "root",
      kind: "request",
      body: "legit-1",
      sentAt: 2001,
    })
    mb.fromSnapshot(synthSnapshot(seeds))
    const all = mb.list()
    const attackerCells = all.filter((m) => m.from === "attacker")
    const siblingCells = all.filter((m) => m.from === "sibling")
    // Attacker's 5 → trimmed to 2.
    expect(attackerCells.length).toBe(2)
    // Sibling's 2 → all preserved (NEVER touched by attacker's quota path).
    expect(siblingCells.length).toBe(2)
    expect(siblingCells.map((c) => c.body).sort()).toEqual(["legit-0", "legit-1"])
  })

  test("(3) default-OFF (no cap): 100-cell snapshot imported byte-identical", () => {
    const mb = createSubagentMailbox({
      now: tick(),
      maxRetained: 1000, // raise global cap so retention does not interfere
      // intentionally NO maxUndeliveredPerSender — legacy posture
    })
    const seeds: Partial<MailboxMessage>[] = []
    for (let i = 0; i < 100; i++) {
      seeds.push({
        id: `msg_${i}`,
        from: "attacker",
        to: `ghost-${i}`,
        kind: "request",
        body: `m${i}`,
        sentAt: 1000 + i,
      })
    }
    mb.fromSnapshot(synthSnapshot(seeds))
    expect(mb.list().length).toBe(100)
  })

  test("(4) snapshot mixes DELIVERED + UNDELIVERED for same sender", () => {
    const mb = createSubagentMailbox({
      now: tick(),
      maxRetained: 100,
      maxUndeliveredPerSender: 2,
    })
    // Delivered cells (carry deliveredAt + concrete `to`) do NOT count in the
    // quota — only undelivered cells do.
    const seeds: Partial<MailboxMessage>[] = []
    for (let i = 0; i < 3; i++) {
      seeds.push({
        id: `msg_d${i}`,
        from: "attacker",
        to: `peer-${i}`,
        kind: "response",
        body: `delivered-${i}`,
        sentAt: 1000 + i,
        deliveredAt: 1500 + i, // marks them delivered
      })
    }
    for (let i = 0; i < 4; i++) {
      seeds.push({
        id: `msg_u${i}`,
        from: "attacker",
        to: `ghost-${i}`,
        kind: "request",
        body: `undelivered-${i}`,
        sentAt: 2000 + i,
      })
    }
    mb.fromSnapshot(synthSnapshot(seeds))
    const all = mb.list()
    // 3 delivered survive (not counted) + 2 undelivered (cap) = 5 total.
    expect(all.length).toBe(5)
    const delivered = all.filter((m) => m.deliveredAt !== undefined)
    expect(delivered.length).toBe(3)
    const undelivered = all.filter((m) => m.deliveredAt === undefined)
    expect(undelivered.length).toBe(2)
    // FIFO within undelivered: oldest 2 (u0/u1) evicted, newest 2 (u2/u3) survive.
    expect(undelivered.map((m) => m.to).sort()).toEqual(["ghost-2", "ghost-3"])
  })

  test("(5) fromSnapshot then send: round-trip is consistent (no double-evict)", () => {
    const mb = createSubagentMailbox({
      now: tick(),
      maxRetained: 100,
      maxUndeliveredPerSender: 3,
    })
    // Seed AT-cap (exactly 3 undelivered for attacker).
    const seeds: Partial<MailboxMessage>[] = []
    for (let i = 0; i < 3; i++) {
      seeds.push({
        id: `msg_seed${i}`,
        from: "attacker",
        to: `ghost-${i}`,
        kind: "request",
        body: `seed-${i}`,
        sentAt: 1000 + i,
      })
    }
    mb.fromSnapshot(synthSnapshot(seeds))
    expect(mb.list().length).toBe(3)
    // One more send → pushes past cap → FIFO evicts the oldest seed.
    mb.send({ from: "attacker", to: "ghost-3", kind: "request", body: "fresh" })
    const all = mb.list()
    expect(all.length).toBe(3)
    // `ghost-0` is the oldest → evicted; `ghost-3` (fresh) survives.
    expect(all.some((m) => m.to === "ghost-0")).toBe(false)
    expect(all.some((m) => m.to === "ghost-3")).toBe(true)
  })
})
