/**
 * VerifyCheckpointBridge — edge / DI sibling hellgate (ADR-0123).
 *
 * Sibling to `verify-checkpoint-bridge-wire-hellgate.test.ts` (which pins the
 * guard-CHAIN wire path: shadowOdb absent ⇒ bridge silenced; verify PASS
 * triggers the call; verify FAIL does not). THIS file pins the BRIDGE itself
 * — `defaultVerifyCheckpointBridge` from `src/agent/verify-checkpoint-bridge.ts`
 * — under adversarial DI / no-throw / signal / repeat-call inputs.
 *
 * Coverage gap closed:
 *   - Existing wire test goes through `buildGuardChain` + `createVerifyGuard`
 *     and asserts call counts via a SPY bridge or a fake ODB.
 *   - This file drills DIRECTLY into `defaultVerifyCheckpointBridge` and pins
 *     the leaf invariants nobody asserted: undefined ODB short-circuit (no
 *     await on a hot path), repeated calls with same/different workspace,
 *     adversarial workspace strings (empty / unicode / very long), markVerified
 *     throws (sync + async), no-throw escape, concurrent fire-and-forget.
 *
 * 14 distinct cases.
 */

import { describe, expect, test } from "bun:test"
import { defaultVerifyCheckpointBridge } from "@/agent/verify-checkpoint-bridge"
import type { ShadowOdb } from "@/storage/shadow-odb"

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

const makeOdb = (
  markVerified: (workspace: string) => Promise<void>,
): { odb: ShadowOdb; calls: string[] } => {
  const calls: string[] = []
  const reject = () => Promise.reject(new Error("not used in this test"))
  return {
    calls,
    odb: {
      init: reject,
      registerHead: reject,
      diffSinceLast: reject,
      diffWorkspaceSinceLast: reject,
      rewindToLast: reject,
      listSnapshots: reject,
      cleanup: reject,
      restorePartial: reject,
      async markVerified(workspace: string) {
        calls.push(workspace)
        await markVerified(workspace)
      },
      rewindToVerified: reject,
    } as unknown as ShadowOdb,
  }
}

// =============================================================
// A. odb undefined / DI (4)
// =============================================================

describe("VerifyCheckpointBridge edge — A. odb undefined / DI", () => {
  test("BRIDGE-1: odb === undefined → onVerifySuccess resolves (no throw) and no call delivered anywhere", async () => {
    // Default-OFF: when no shadow ODB is wired, the bridge silently no-ops.
    // This is the byte-identical fallback for hosts that don't opt in.
    const bridge = defaultVerifyCheckpointBridge(undefined)
    // 5 calls with different workspaces — all must resolve.
    await bridge.onVerifySuccess("/abs/ws/A")
    await bridge.onVerifySuccess("/abs/ws/B")
    await bridge.onVerifySuccess("")
    await bridge.onVerifySuccess("/abs/ws/C")
    await bridge.onVerifySuccess("/abs/ws/D")
    // Nothing to assert beyond no-throw + no-side-effect. The fact that we
    // got here without an exception is the contract.
    expect(true).toBe(true)
  })

  test("BRIDGE-2: odb wired → onVerifySuccess forwards workspace VERBATIM to markVerified", async () => {
    const { odb, calls } = makeOdb(async () => {
      // No-op resolve.
    })
    const bridge = defaultVerifyCheckpointBridge(odb)
    await bridge.onVerifySuccess("/abs/ws/Alice")
    expect(calls).toEqual(["/abs/ws/Alice"])
  })

  test("BRIDGE-3: empty workspace string — passed through (bridge does NOT validate)", async () => {
    // The bridge is plane-clean — it forwards whatever the caller hands it.
    // Validation (if any) belongs to ShadowOdb, not here.
    const { odb, calls } = makeOdb(async () => undefined)
    const bridge = defaultVerifyCheckpointBridge(odb)
    await bridge.onVerifySuccess("")
    expect(calls).toEqual([""])
  })

  test("BRIDGE-4: unicode workspace string (kana + RTL + emoji) → forwarded byte-identical", async () => {
    const { odb, calls } = makeOdb(async () => undefined)
    const bridge = defaultVerifyCheckpointBridge(odb)
    const tricky = "/abs/ワーク/مَجلَّد/🌳/.git"
    await bridge.onVerifySuccess(tricky)
    expect(calls).toEqual([tricky])
  })
})

// =============================================================
// B. no-throw invariant under adversarial ODB (4)
// =============================================================

describe("VerifyCheckpointBridge edge — B. no-throw invariant", () => {
  test("BRIDGE-5: markVerified rejects with Error → bridge SWALLOWS, no propagation to caller", async () => {
    // Source (verify-checkpoint-bridge.ts L38-L47): hard NO-THROW invariant.
    const { odb } = makeOdb(async () => {
      throw new Error("simulated init-missing")
    })
    const bridge = defaultVerifyCheckpointBridge(odb)
    let threw: unknown = null
    try {
      await bridge.onVerifySuccess("/ws")
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
  })

  test("BRIDGE-6: markVerified rejects with non-Error (string) → still swallowed", async () => {
    // The catch-block has no value binding (`catch {}`) so anything is caught.
    const { odb } = makeOdb(async () => {
      throw "stringly-typed failure"
    })
    const bridge = defaultVerifyCheckpointBridge(odb)
    let threw: unknown = null
    try {
      await bridge.onVerifySuccess("/ws")
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
  })

  test("BRIDGE-7: markVerified throws SYNCHRONOUSLY (rare, but bridge must guard) → swallowed", async () => {
    // A misbehaving ODB might throw before returning the Promise (e.g. a
    // null-deref inside markVerified before the first `await`). The bridge's
    // try/catch must catch both shapes.
    const odb = {
      init: () => Promise.reject(new Error("nu")),
      registerHead: () => Promise.reject(new Error("nu")),
      diffSinceLast: () => Promise.reject(new Error("nu")),
      diffWorkspaceSinceLast: () => Promise.reject(new Error("nu")),
      rewindToLast: () => Promise.reject(new Error("nu")),
      listSnapshots: () => Promise.reject(new Error("nu")),
      cleanup: () => Promise.reject(new Error("nu")),
      restorePartial: () => Promise.reject(new Error("nu")),
      markVerified(_workspace: string): Promise<void> {
        throw new Error("synchronous boom")
      },
      rewindToVerified: () => Promise.reject(new Error("nu")),
    } as unknown as ShadowOdb
    const bridge = defaultVerifyCheckpointBridge(odb)
    let threw: unknown = null
    try {
      await bridge.onVerifySuccess("/ws")
    } catch (e) {
      threw = e
    }
    expect(threw).toBeNull()
  })

  test("BRIDGE-8: alternating failing + succeeding calls — failures don't break subsequent calls", async () => {
    let toggle = false
    const { odb, calls } = makeOdb(async () => {
      toggle = !toggle
      if (toggle) throw new Error("boom")
      // even calls succeed
    })
    const bridge = defaultVerifyCheckpointBridge(odb)
    // 4 calls — odd ones throw, even ones succeed.
    await bridge.onVerifySuccess("/A")
    await bridge.onVerifySuccess("/B")
    await bridge.onVerifySuccess("/C")
    await bridge.onVerifySuccess("/D")
    // markVerified was called 4 times regardless of throws (we record before
    // awaiting in our helper). Bridge state survived 2 throws.
    expect(calls).toEqual(["/A", "/B", "/C", "/D"])
  })
})

// =============================================================
// C. repeat-call / concurrency / sticky state (3)
// =============================================================

describe("VerifyCheckpointBridge edge — C. repeat / concurrency", () => {
  test("BRIDGE-9: repeated calls with SAME workspace → each forwarded (NOT deduped at bridge level)", async () => {
    // The bridge is a thin pass-through. Dedup of "already-verified" is a
    // higher-layer concern (e.g. inside ShadowOdb.markVerified).
    const { odb, calls } = makeOdb(async () => undefined)
    const bridge = defaultVerifyCheckpointBridge(odb)
    await bridge.onVerifySuccess("/ws/A")
    await bridge.onVerifySuccess("/ws/A")
    await bridge.onVerifySuccess("/ws/A")
    expect(calls).toEqual(["/ws/A", "/ws/A", "/ws/A"])
  })

  test("BRIDGE-10: concurrent onVerifySuccess (3 in-flight) → all eventually call markVerified, ordering preserved by sink", async () => {
    // Parallel firing — the bridge does not serialize. Each await runs to
    // completion independently.
    const order: string[] = []
    const odb = {
      init: () => Promise.reject(new Error("nu")),
      registerHead: () => Promise.reject(new Error("nu")),
      diffSinceLast: () => Promise.reject(new Error("nu")),
      diffWorkspaceSinceLast: () => Promise.reject(new Error("nu")),
      rewindToLast: () => Promise.reject(new Error("nu")),
      listSnapshots: () => Promise.reject(new Error("nu")),
      cleanup: () => Promise.reject(new Error("nu")),
      restorePartial: () => Promise.reject(new Error("nu")),
      async markVerified(workspace: string) {
        // Resolve in workspace-sorted order via microtask hop, then push.
        await Promise.resolve()
        order.push(workspace)
      },
      rewindToVerified: () => Promise.reject(new Error("nu")),
    } as unknown as ShadowOdb
    const bridge = defaultVerifyCheckpointBridge(odb)
    await Promise.all([
      bridge.onVerifySuccess("/c"),
      bridge.onVerifySuccess("/a"),
      bridge.onVerifySuccess("/b"),
    ])
    expect(order.length).toBe(3)
    // Order matches call order (microtask hops are FIFO within the same tick).
    expect(order).toEqual(["/c", "/a", "/b"])
  })

  test("BRIDGE-11: bridge instance is STATELESS — no memoization of seen workspaces", async () => {
    // Construct a new bridge each call → identical observable behavior.
    const { odb, calls } = makeOdb(async () => undefined)
    const b1 = defaultVerifyCheckpointBridge(odb)
    const b2 = defaultVerifyCheckpointBridge(odb)
    await b1.onVerifySuccess("/X")
    await b2.onVerifySuccess("/X")
    expect(calls).toEqual(["/X", "/X"]) // both calls delivered (no dedup)
  })
})

// =============================================================
// D. surface contract (3)
// =============================================================

describe("VerifyCheckpointBridge edge — D. surface contract", () => {
  test("BRIDGE-12: bridge returns the exact public surface — only `onVerifySuccess` exposed", () => {
    const bridge = defaultVerifyCheckpointBridge(undefined)
    const keys = Object.keys(bridge)
    expect(keys).toEqual(["onVerifySuccess"])
  })

  test("BRIDGE-13: onVerifySuccess returns Promise<void> — fulfilled value is undefined", async () => {
    const bridge = defaultVerifyCheckpointBridge(undefined)
    const ret = bridge.onVerifySuccess("/ws")
    expect(ret).toBeInstanceOf(Promise)
    const v = await ret
    expect(v).toBeUndefined()
  })

  test("BRIDGE-14: very long workspace string (8 KiB) — forwarded without truncation", async () => {
    // The bridge does not trim or hash — passes verbatim. ShadowOdb is the
    // layer that hashes (ADR-0108) but only inside its own implementation.
    const { odb, calls } = makeOdb(async () => undefined)
    const bridge = defaultVerifyCheckpointBridge(odb)
    const huge = `/abs/${"q".repeat(8 * 1024)}`
    await bridge.onVerifySuccess(huge)
    expect(calls).toEqual([huge])
    expect(calls[0]?.length).toBe(huge.length)
  })
})
