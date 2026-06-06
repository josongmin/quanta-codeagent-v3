/**
 * Hellgate — broadcast delivery must NOT be lost when a `read` is `limit`-capped.
 *
 * BUG (pre-fix): `collect` computed the broadcast cursor watermark
 * (`maxSeenSentAt`) over the ENTIRE undelivered set, then sliced to `limit`.
 * `markDelivered` advanced the per-agent cursor to that full-set max — so when an
 * inbox held MORE broadcasts than `limit`, the reader received only the first
 * `limit`, but its cursor jumped PAST all of them. Every broadcast beyond the
 * limit was silently marked seen and never delivered.
 *
 * This is on the DEFAULT push path: the peer-inbox auto-drain and the broker both
 * call `read` with a limit, so a teammate firing >limit broadcasts in one turn
 * loses mail. DIRECT mail was unaffected (per-recipient `directDelivered`); only
 * the broadcast fan-out primitive leaked.
 *
 * FIX (structural, mirrors the per-recipient DIRECT model): track broadcast
 * delivery PER RECIPIENT (a `broadcastReaders` set on each cell) instead of a
 * per-agent `sentAt` watermark cursor. No watermark ⇒ no over-advance ⇒ exact
 * once-per-agent delivery regardless of `limit`, and ties at the slice boundary
 * are impossible.
 */

import { describe, expect, test } from "bun:test"
import { createSubagentMailbox } from "@/agent/subagent-mailbox"

/** Monotonic clock so every `send` gets a distinct, ordered `sentAt`. */
const tick = () => {
  let n = 1000
  return () => ++n
}

describe("subagent mailbox — broadcast loss under limit (hellgate)", () => {
  test("(1) limit-capped read of N>limit broadcasts loses NONE on the next read", () => {
    const port = createSubagentMailbox({ now: tick() })
    for (let i = 0; i < 5; i++) {
      port.send({ from: "sender", to: "*", kind: "broadcast", body: `b${i}` })
    }
    // Agent A drains 2 of the 5.
    const first = port.read("A", { limit: 2 })
    expect(first.map((m) => m.body)).toEqual(["b0", "b1"])
    // The cursor must NOT have jumped past the unread 3.
    expect(port.pendingFor("A")).toBe(3)
    // The remaining 3 are still deliverable.
    const second = port.read("A")
    expect(second.map((m) => m.body)).toEqual(["b2", "b3", "b4"])
    expect(port.pendingFor("A")).toBe(0)
  })

  test("(2) broadcast is still delivered exactly once per agent (no dup, no loss)", () => {
    const port = createSubagentMailbox({ now: tick() })
    for (let i = 0; i < 4; i++) {
      port.send({ from: "sender", to: "*", kind: "broadcast", body: `m${i}` })
    }
    // Drain in two limited reads, then once more.
    const a1 = port.read("A", { limit: 1 }).map((m) => m.body)
    const a2 = port.read("A", { limit: 1 }).map((m) => m.body)
    const a3 = port.read("A").map((m) => m.body)
    expect([...a1, ...a2, ...a3]).toEqual(["m0", "m1", "m2", "m3"])
    // Idempotent — a fourth read sees nothing.
    expect(port.read("A")).toEqual([])
  })

  test("(3) per-recipient: A draining (even limited) never hides B's broadcasts", () => {
    const port = createSubagentMailbox({ now: tick() })
    for (let i = 0; i < 3; i++) {
      port.send({ from: "sender", to: "*", kind: "broadcast", body: `x${i}` })
    }
    // A drains all 3.
    expect(port.read("A").map((m) => m.body)).toEqual(["x0", "x1", "x2"])
    // B still sees its own full copy — independent cursor/recipient set.
    expect(port.pendingFor("B")).toBe(3)
    expect(port.read("B", { limit: 2 }).map((m) => m.body)).toEqual(["x0", "x1"])
    expect(port.read("B").map((m) => m.body)).toEqual(["x2"])
  })

  test("(4) interleaved direct + broadcast under limit loses neither", () => {
    const port = createSubagentMailbox({ now: tick() })
    port.send({ from: "sender", to: "*", kind: "broadcast", body: "bc0" }) // t=1001
    port.send({ from: "sender", to: "A", kind: "request", body: "dm0" }) //  t=1002
    port.send({ from: "sender", to: "*", kind: "broadcast", body: "bc1" }) // t=1003
    port.send({ from: "sender", to: "A", kind: "request", body: "dm1" }) //  t=1004
    // Drain 2 oldest (bc0, dm0).
    const first = port.read("A", { limit: 2 }).map((m) => m.body)
    expect(first).toEqual(["bc0", "dm0"])
    expect(port.pendingFor("A")).toBe(2)
    // The remaining broadcast + direct both survive.
    const rest = port.read("A").map((m) => m.body)
    expect(rest).toEqual(["bc1", "dm1"])
    expect(port.pendingFor("A")).toBe(0)
  })

  test("(5) a broadcast never returns to its own sender, even under limit churn", () => {
    const port = createSubagentMailbox({ now: tick() })
    port.send({ from: "sender", to: "*", kind: "broadcast", body: "self0" })
    port.send({ from: "sender", to: "*", kind: "broadcast", body: "self1" })
    expect(port.read("sender", { limit: 1 })).toEqual([])
    expect(port.pendingFor("sender")).toBe(0)
  })
})
