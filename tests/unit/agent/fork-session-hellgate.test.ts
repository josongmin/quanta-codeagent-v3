/**
 * Fork-session hellgate (ADR-0201).
 *
 * Seals 13 invariants:
 *   F-01 unknown checkpoint → Err("checkpoint-not-found") (no throw)
 *   F-02 success → forked.messages deep-equal parent
 *   F-03 new sessionId != parent + UUID-v4 regex match
 *   F-04 post-fork record on parent does NOT mutate forked.messages
 *   F-05 two forks of same checkpoint → two ids, both equal messages
 *   F-06 lineageOf(forkedSid).parent === parentSessionId
 *   F-07 nested fork chain reachable via Lineage.chain()
 *   F-08 store at cap → fork still succeeds (eviction triggers)
 *   F-09 parent pruned → fork → Err("checkpoint-not-found")
 *   F-10 cloneSnapshot to existing dst → false (no-overwrite); fork → "duplicate-id"
 *   F-11 lineage cycle attempt → Err("lineage-cycle")
 *   F-12 forked.messages is frozen + same reference as snapshot
 *   F-13 1000 forks → lineage map cap respected (no unbounded growth)
 */

import { describe, expect, test } from "bun:test"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import {
  defaultLineage,
  defaultSessionForker,
  type ForkError,
  type SessionForker,
} from "@/agent/fork-session"
import type { Message } from "@/llm"

// ----------------------------------------------------------------------------
// harness
// ----------------------------------------------------------------------------

const mkMsg = (role: "user" | "assistant", text: string): Message => ({
  role,
  content: [{ type: "text", text }],
})

let tickValue = 1_000
const tick = (): number => {
  tickValue += 1
  return tickValue
}
const resetTick = (start = 1_000): void => {
  tickValue = start
}

let uuidCounter = 0
const mintUuid = (): string => {
  uuidCounter += 1
  // RFC 4122 v4 shape — `4` in the third group, `8|9|a|b` start of the fourth.
  const c = uuidCounter.toString(16).padStart(8, "0")
  return `${c}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const freshForker = (
  storeOpts: { maxEntries?: number } = {},
  lineageMax?: number,
): { store: ReturnType<typeof defaultConversationCheckpointStore>; forker: SessionForker } => {
  resetTick()
  uuidCounter = 0
  const store = defaultConversationCheckpointStore({
    maxEntries: storeOpts.maxEntries ?? 50,
    now: tick,
  })
  const lineage = defaultLineage(
    lineageMax !== undefined ? { now: tick, maxEntries: lineageMax } : { now: tick },
  )
  const forker = defaultSessionForker(store, { now: tick, mintSessionId: mintUuid, lineage })
  return { store, forker }
}

// ----------------------------------------------------------------------------
// F-01 .. F-13
// ----------------------------------------------------------------------------

describe("fork-session hellgate (ADR-0201)", () => {
  test("HELL-F-01: fork(unknown) → Err('checkpoint-not-found'), no throw", () => {
    const { forker } = freshForker()
    const r = forker.fork("does-not-exist")
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.code).toBe("checkpoint-not-found")
    expect(typeof r.error.message).toBe("string")
  })

  test("HELL-F-02: fork(known) → messages deep-equal parent snapshot", () => {
    const { store, forker } = freshForker()
    const msgs = [mkMsg("user", "hi"), mkMsg("assistant", "hello")]
    store.record("parent-A", msgs)
    const r = forker.fork("parent-A")
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.messages.length).toBe(2)
    expect(r.value.messages[0]).toEqual(msgs[0] as Message)
    expect(r.value.messages[1]).toEqual(msgs[1] as Message)
  })

  test("HELL-F-03: new sessionId differs from parent + matches UUID v4 regex", () => {
    const { store, forker } = freshForker()
    store.record("parent-A", [mkMsg("user", "x")])
    const r = forker.fork("parent-A")
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.sessionId).not.toBe("parent-A")
    expect(r.value.sessionId).not.toBe(r.value.parentSessionId)
    expect(UUID_V4_RE.test(r.value.sessionId)).toBe(true)
    expect(r.value.parentSessionId).toBe("parent-A")
    expect(r.value.parentCheckpointId).toBe("parent-A")
  })

  test("HELL-F-04: post-fork record on parent does NOT mutate forked.messages (snapshot immutability)", () => {
    const { store, forker } = freshForker()
    const original: Message[] = [mkMsg("user", "v1")]
    store.record("parent-A", original)
    const r = forker.fork("parent-A")
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    const beforeLen = r.value.messages.length
    // Re-record the parent with a totally different shape.
    store.record("parent-A", [mkMsg("user", "v2"), mkMsg("assistant", "v2-reply")])
    // The fork handle holds the OLD frozen array.
    expect(r.value.messages.length).toBe(beforeLen)
    expect(r.value.messages[0]).toEqual(original[0] as Message)
  })

  test("HELL-F-05: same checkpoint forked twice → two ids, identical messages", () => {
    const { store, forker } = freshForker()
    const msgs = [mkMsg("user", "shared")]
    store.record("parent-A", msgs)
    const r1 = forker.fork("parent-A")
    const r2 = forker.fork("parent-A")
    expect(r1.ok && r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) throw new Error("unreachable")
    expect(r1.value.sessionId).not.toBe(r2.value.sessionId)
    // Same underlying frozen array (immutability sharing) — strict reference equality.
    expect(r1.value.messages).toBe(r2.value.messages)
  })

  test("HELL-F-06: lineageOf(forkedSid).parent === parentSessionId (read from store)", () => {
    const { store, forker } = freshForker()
    store.record("parent-A", [mkMsg("user", "x")])
    const r = forker.fork("parent-A")
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    const lineage = store.lineageOf(r.value.sessionId)
    expect(lineage.parent).toBe("parent-A")
    // root snapshot has no parent in the store's lineage map
    expect(store.lineageOf("parent-A").parent).toBe(null)
  })

  test("HELL-F-07: nested fork chain (A→B fork; B→C fork) → C's lineage chain reaches A via Lineage", () => {
    resetTick()
    uuidCounter = 0
    const store = defaultConversationCheckpointStore({ maxEntries: 50, now: tick })
    const lineage = defaultLineage({ now: tick })
    const forker = defaultSessionForker(store, { now: tick, mintSessionId: mintUuid, lineage })
    store.record("A", [mkMsg("user", "root")])
    const b = forker.fork("A")
    expect(b.ok).toBe(true)
    if (!b.ok) throw new Error("unreachable")
    const c = forker.fork(b.value.sessionId)
    expect(c.ok).toBe(true)
    if (!c.ok) throw new Error("unreachable")
    const chain = lineage.chain(c.value.sessionId)
    // chain is [c, b, a]
    expect(chain.length).toBe(3)
    expect(chain[0]).toBe(c.value.sessionId)
    expect(chain[1]).toBe(b.value.sessionId)
    expect(chain[2]).toBe("A")
  })

  test("HELL-F-08: store at cap → fork still succeeds (LRU eviction triggers, parent stays)", () => {
    // Cap = 2. Record parent, fill with one extra. Forking adds a 3rd entry —
    // eviction drops the OLDEST (which is the parent if it wasn't touched).
    // The fork still returns a handle (the messages array is captured BEFORE
    // the clone runs, so even if the parent gets evicted by the clone's own
    // insert pressure the handle stays whole).
    const { store, forker } = freshForker({ maxEntries: 2 })
    const parentMsgs = [mkMsg("user", "p")]
    store.record("parent-A", parentMsgs)
    store.record("other", [mkMsg("user", "o")])
    // store now: oldest=parent-A, newest=other. fork inserts a 3rd entry ⇒
    // parent-A is evicted (it's the oldest).
    const r = forker.fork("parent-A")
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value.messages.length).toBe(1)
    // parent-A is now gone from the store (evicted) but the fork handle holds
    // the snapshot — that's the immutability guarantee in action.
    expect(store.restore("parent-A")).toBe(null)
  })

  test("HELL-F-09: parent pruned away → fork → Err('checkpoint-not-found')", () => {
    const { store, forker } = freshForker()
    store.record("parent-A", [mkMsg("user", "x")])
    store.clear()
    const r = forker.fork("parent-A")
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.code).toBe("checkpoint-not-found")
  })

  test("HELL-F-10: cloneSnapshot to existing dst → false; fork on collision → 'duplicate-id'", () => {
    const { store } = freshForker()
    const msgs = [mkMsg("user", "x")]
    store.record("parent-A", msgs)
    store.record("parent-B", msgs)
    // Direct store call: dst already exists ⇒ strict no-overwrite.
    expect(store.cloneSnapshot("parent-A", "parent-B")).toBe(false)
    // src missing ⇒ false.
    expect(store.cloneSnapshot("missing", "new-id")).toBe(false)
    // identical src+dst ⇒ false (would be a no-op race).
    expect(store.cloneSnapshot("parent-A", "parent-A")).toBe(false)
    // Original 'parent-B' snapshot intact.
    expect(store.restore("parent-B")).not.toBe(null)

    // Now exercise fork-level duplicate-id mapping with a deterministic minter
    // that returns a colliding id.
    resetTick()
    const store2 = defaultConversationCheckpointStore({ maxEntries: 10, now: tick })
    const lineage = defaultLineage({ now: tick })
    store2.record("parent-A", msgs)
    store2.record("existing-id", msgs)
    const forker = defaultSessionForker(store2, {
      now: tick,
      mintSessionId: () => "existing-id",
      lineage,
    })
    const r = forker.fork("parent-A")
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.code).toBe("duplicate-id")
  })

  test("HELL-F-11: lineage cycle attempt → Err('lineage-cycle')", () => {
    const lineage = defaultLineage({ now: tick })
    // Build A as root, B as child of A. Now attempt to make A the child of B
    // — that closes a cycle (A → B → A).
    const r1 = lineage.attach("B", "A")
    expect(r1.ok).toBe(true)
    const r2 = lineage.attach("A", "B")
    expect(r2.ok).toBe(false)
    if (r2.ok) throw new Error("unreachable")
    expect((r2.error as ForkError).code).toBe("lineage-cycle")
    // Also reject self-parent.
    const r3 = lineage.attach("C", "C")
    expect(r3.ok).toBe(false)
    if (r3.ok) throw new Error("unreachable")
    expect((r3.error as ForkError).code).toBe("lineage-cycle")
  })

  test("HELL-F-12: forked.messages is the SAME frozen array as the snapshot (readonly)", () => {
    const { store, forker } = freshForker()
    const msgs = [mkMsg("user", "x")]
    store.record("parent-A", msgs)
    const r = forker.fork("parent-A")
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    // Strict reference equality with the stored snapshot.
    const restored = store.restore("parent-A")
    if (restored === null) throw new Error("parent-A vanished")
    expect(r.value.messages).toBe(restored)
    // The frozen array is read-only — push attempts must throw in strict mode.
    expect(Object.isFrozen(r.value.messages)).toBe(true)
    // Deliberate runtime freeze probe — push on a frozen array throws in
    // strict mode. Cast through `unknown` then to a mutable shape to avoid
    // `any` (biome forbids explicit any).
    const mutable = r.value.messages as unknown as Message[]
    expect(() => {
      mutable.push(mkMsg("user", "evil"))
    }).toThrow()
  })

  test("HELL-F-13: 1000 forks → lineage cap respected (no unbounded growth)", () => {
    // Cap lineage tracker low (10). Snapshot store cap also low. We want the
    // lineage tracker's `size()` to stay <= cap regardless of how many forks
    // run; the store handles its own eviction in parallel.
    const { store, forker: _f } = freshForker({ maxEntries: 50 })
    const lineage = defaultLineage({ now: tick, maxEntries: 10 })
    const forker = defaultSessionForker(store, {
      now: tick,
      mintSessionId: mintUuid,
      lineage,
    })
    store.record("parent-A", [mkMsg("user", "x")])
    let ok = 0
    let failed = 0
    for (let i = 0; i < 1000; i++) {
      const r = forker.fork("parent-A")
      if (r.ok) ok += 1
      else failed += 1
    }
    // Cap-respect: lineage never exceeds its max.
    expect(lineage.size()).toBeLessThanOrEqual(10)
    // The parent eventually gets evicted from the snapshot store (cap=50,
    // 1000 inserts), so SOME forks will fail with checkpoint-not-found —
    // but the FIRST batch must succeed.
    expect(ok).toBeGreaterThan(0)
    expect(ok + failed).toBe(1000)
  })
})
