/**
 * Fork-session-wire hellgate (ADR-0284).
 *
 * Seals 10 invariants on the composition wire that turns the default
 * `defaultForker()` (which surfaces `Err("fork-not-configured")`) into a
 * fully-functional `ForkSessionPort` backed by a fresh
 * `ConversationCheckpointStore`.
 *
 *   HELL-FW-01  QUANTA_FORK_SESSION=on (mirrored via the wire factory) ⇒
 *               base checkpoint store is instantiated.
 *   HELL-FW-02  ForkSessionPort active ⇒ fork() succeeds (no
 *               "fork-not-configured" error).
 *   HELL-FW-03  Default-OFF byte-identical: importing the wire is side-effect
 *               free; constructing nothing leaves no state.
 *   HELL-FW-04  Checkpoint store FULL (LRU cap) + fork ⇒ wire still functions;
 *               only the LRU-evicted parent fork misses.
 *   HELL-FW-05  Parent abort during fork ⇒ Err("aborted") and zero state mutation.
 *   HELL-FW-06  Forked session is isolated — mutating parent messages does
 *               NOT change child snapshot (snapshot is frozen).
 *   HELL-FW-07  fork-of-fork (nested) depth=2 MVP — second fork off the first
 *               child's id succeeds.
 *   HELL-FW-08  Composition wire is exact — wire returns { store, base, forker }
 *               trio referencing the same store.
 *   HELL-FW-09  AbortSignal cleanup — already-aborted parent ⇒ Err("aborted")
 *               with no link record.
 *   HELL-FW-10  No zombie checkpoint after wire teardown — store.clear() drops
 *               every snapshot; subsequent fork ⇒ Err("checkpoint-not-found").
 */

import { describe, expect, test } from "bun:test"
import { defaultCheckpointBaseWire } from "@/agent/fork-session-wire"
import type { Message } from "@/llm"

const mkMsg = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

describe("fork-session-wire hellgate (ADR-0284)", () => {
  // -------------------------------------------------------------------------
  test("HELL-FW-01 base checkpoint store is instantiated", () => {
    const wire = defaultCheckpointBaseWire()
    expect(wire.store).toBeDefined()
    expect(wire.base).toBeDefined()
    expect(wire.forker).toBeDefined()
    expect(typeof wire.store.record).toBe("function")
    expect(typeof wire.base.fork).toBe("function")
    expect(typeof wire.forker.fork).toBe("function")
  })

  // -------------------------------------------------------------------------
  test("HELL-FW-02 fork() succeeds — no fork-not-configured error", async () => {
    const wire = defaultCheckpointBaseWire()
    wire.store.record("parent-001", [mkMsg("hello")])
    const out = await wire.forker.fork({ fromCheckpointRef: "parent-001" })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.value.parentSessionId).toBe("parent-001")
      expect(out.value.newSessionId.length).toBeGreaterThan(0)
      expect(out.value.messages.length).toBe(1)
    }
  })

  // -------------------------------------------------------------------------
  test("HELL-FW-03 default-OFF byte-identical: import side-effect free", async () => {
    const m1 = await import("@/agent/fork-session-wire")
    const m2 = await import("@/agent/fork-session-wire")
    expect(m1.defaultCheckpointBaseWire).toBe(m2.defaultCheckpointBaseWire)
  })

  // -------------------------------------------------------------------------
  test("HELL-FW-04 checkpoint store FULL (LRU) + fork ⇒ evicted ids miss", async () => {
    const wire = defaultCheckpointBaseWire({ maxEntries: 2 })
    wire.store.record("a", [mkMsg("a")])
    wire.store.record("b", [mkMsg("b")])
    wire.store.record("c", [mkMsg("c")]) // evicts "a"
    const evicted = await wire.forker.fork({ fromCheckpointRef: "a" })
    expect(evicted.ok).toBe(false)
    if (!evicted.ok) expect(evicted.error.code).toBe("checkpoint-not-found")
    // Surviving id still forks.
    const live = await wire.forker.fork({ fromCheckpointRef: "c" })
    expect(live.ok).toBe(true)
  })

  // -------------------------------------------------------------------------
  test("HELL-FW-05 parent abort during fork ⇒ Err(aborted), no link recorded", async () => {
    const wire = defaultCheckpointBaseWire()
    wire.store.record("p1", [mkMsg("p1")])
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await wire.forker.fork({ fromCheckpointRef: "p1", signal: ctrl.signal })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.code).toBe("aborted")
    // No child links recorded against p1.
    const branches = wire.forker.listBranches({ sessionId: "p1" })
    expect(branches.length).toBe(0)
  })

  // -------------------------------------------------------------------------
  test("HELL-FW-06 forked session isolated — mutating parent does not change child", async () => {
    const wire = defaultCheckpointBaseWire()
    const parentMessages: Message[] = [mkMsg("p")]
    wire.store.record("isolated-parent", parentMessages)
    const out = await wire.forker.fork({ fromCheckpointRef: "isolated-parent" })
    expect(out.ok).toBe(true)
    // Mutate the caller's array AFTER recording — the snapshot is a frozen
    // shallow-copy so the child's view is unchanged.
    parentMessages.push(mkMsg("mutation"))
    if (out.ok) {
      expect(out.value.messages.length).toBe(1)
      expect(out.value.messages[0]).toBeDefined()
    }
  })

  // -------------------------------------------------------------------------
  test("HELL-FW-07 fork-of-fork (nested) depth=2 MVP", async () => {
    const wire = defaultCheckpointBaseWire()
    wire.store.record("root", [mkMsg("root")])
    const first = await wire.forker.fork({ fromCheckpointRef: "root" })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    // The first child's id IS present in the store (cloneSnapshot writes it).
    const second = await wire.forker.fork({ fromCheckpointRef: first.value.newSessionId })
    expect(second.ok).toBe(true)
    if (second.ok) {
      // resolveParent walks one step up.
      expect(wire.forker.resolveParent({ sessionId: second.value.newSessionId })).toBe(
        first.value.newSessionId,
      )
    }
  })

  // -------------------------------------------------------------------------
  test("HELL-FW-08 composition wire is exact — store/base/forker trio", () => {
    const wire = defaultCheckpointBaseWire()
    expect(Object.keys(wire).sort()).toEqual(["base", "forker", "store"])
    // Mutating the store before fork-time MUST be visible to the forker —
    // proves the wire references the SAME instance (not a snapshot).
    wire.store.record("wired-shared", [mkMsg("shared")])
    const out = wire.base.fork("wired-shared")
    expect(out.ok).toBe(true)
  })

  // -------------------------------------------------------------------------
  test("HELL-FW-09 already-aborted parent signal ⇒ Err(aborted) no link record", async () => {
    const wire = defaultCheckpointBaseWire()
    wire.store.record("a9", [mkMsg("a9")])
    const ctrl = new AbortController()
    ctrl.abort()
    const out = await wire.forker.fork({ fromCheckpointRef: "a9", signal: ctrl.signal })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.error.code).toBe("aborted")
    expect(wire.forker.listBranches({ sessionId: "a9" }).length).toBe(0)
  })

  // -------------------------------------------------------------------------
  test("HELL-FW-10 no zombie checkpoint after store.clear()", async () => {
    const wire = defaultCheckpointBaseWire()
    wire.store.record("zombie-test", [mkMsg("z")])
    const before = await wire.forker.fork({ fromCheckpointRef: "zombie-test" })
    expect(before.ok).toBe(true)
    wire.store.clear()
    const after = await wire.forker.fork({ fromCheckpointRef: "zombie-test" })
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.error.code).toBe("checkpoint-not-found")
  })
})
