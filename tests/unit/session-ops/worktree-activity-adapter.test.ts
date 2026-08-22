/**
 * RFC-04 D3 — worktree runtime-progress → activity adapter hellgate (aug-22).
 *
 * The adapter is the ONE cross-domain seam that maps a worktree-create runtime
 * progress stream onto the D1 staged activity nodes (workspace/checkout). These
 * tests drive it through the REAL `createActivityStore` + `materialize` (per
 * jul-13/jul-15: a fake sink hides seam bugs), proving:
 *   - a `checkout-progress` event updates the D1 `checkout` node's LIVE % on
 *     `meta.checkoutPercentage` WITHOUT changing its `running` status (the core);
 *   - the adapter is INERT when staged off / no progress source — byte-identical
 *     to the D1-only baseline (red-on-injection twin flips the gate);
 *   - indeterminate/malformed ratios emit NO fabricated number;
 *   - the closed runtime union maps exhaustively to terminal settlement, and a
 *     retry (new operationId) is isolated with fresh progress.
 *
 * Pure adapter + pure spine ⇒ NO git / NO I/O — a cheap leaf-crate unit.
 */

import { describe, expect, test } from "bun:test"
import {
  type ActivitySnapshot,
  createActivityStore,
  worktreeOpenActivity,
  worktreeOpNodeId,
  worktreeStepId,
  worktreeStepOpen,
} from "@/activity"
import {
  checkoutPercentage,
  makeWorktreeActivityObserver,
  type WorktreeCreateProgress,
  worktreeProgressToActivity,
} from "@/runner/session-ops/worktree/activity-adapter"

const OP = "own-1"
const checkoutId = worktreeStepId(OP, "checkout")

/** Seed a store with the D1 staged parent + checkout child (as the transaction
 *  emits them BEFORE the git effect runs), so the adapter updates a REAL node. */
const seedD1 = (staged: boolean) => {
  const store = createActivityStore()
  store.emit(
    worktreeOpenActivity({
      operationId: OP,
      threadId: "t1",
      label: "feat/x",
      startedAt: 1,
    }),
  )
  if (staged) {
    store.emit(worktreeStepOpen(OP, "workspace", 1))
    store.emit(worktreeStepOpen(OP, "checkout", 2))
  }
  return store
}

const checkoutNode = (snap: ActivitySnapshot) => snap.byId.get(checkoutId)

describe("checkoutPercentage — git's own ratio, never fabricated", () => {
  test("valid counts → integer percentage in [0,100]", () => {
    expect(checkoutPercentage(0, 100)).toBe(0)
    expect(checkoutPercentage(42, 100)).toBe(42)
    expect(checkoutPercentage(1, 3)).toBe(33)
    expect(checkoutPercentage(100, 100)).toBe(100)
  })
  test("malformed / indeterminate → null (no fabricated number)", () => {
    expect(checkoutPercentage(1, 0)).toBeNull() // zero total
    expect(checkoutPercentage(-1, 100)).toBeNull() // negative completed
    expect(checkoutPercentage(101, 100)).toBeNull() // regressing / overshoot
    expect(checkoutPercentage(Number.NaN, 100)).toBeNull()
    expect(checkoutPercentage(5, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe("worktreeProgressToActivity — exhaustive pure mapping", () => {
  test("checkout-progress → checkout node meta %, status stays running", () => {
    const store = seedD1(true)
    const obs = makeWorktreeActivityObserver({ store, operationId: OP, staged: true })
    obs({ kind: "checkout-progress", completed: 42, total: 100 })
    const n = checkoutNode(store.snapshot())
    expect(n?.meta?.checkoutPercentage).toBe("42")
    // RED-on-injection twin: the % is a META refresh, NOT a status transition.
    expect(n?.status).toBe("running")
  })

  test("indeterminate checkout-progress → NO event, node stays running w/o %", () => {
    const store = seedD1(true)
    const obs = makeWorktreeActivityObserver({ store, operationId: OP, staged: true })
    obs({ kind: "checkout-progress", completed: 1, total: 0 })
    const n = checkoutNode(store.snapshot())
    expect(n?.status).toBe("running")
    expect(n?.meta?.checkoutPercentage).toBeUndefined()
  })

  test("stage-completed(checkout) → checkout done; container derives done", () => {
    const store = seedD1(true)
    const obs = makeWorktreeActivityObserver({ store, operationId: OP, staged: true })
    obs({ kind: "stage-completed", stage: "checkout" })
    const snap = store.snapshot()
    expect(checkoutNode(snap)?.status).toBe("done")
    // parent has workspace(open,running) + checkout(done): still running (open).
    expect(snap.byId.get(worktreeOpNodeId(OP))?.status).toBe("running")
  })

  test("failed(checkout) → checkout failed; container derives failed", () => {
    const store = seedD1(true)
    // settle workspace so only the failed checkout drives the derivation.
    store.emit({ type: "node_status", id: worktreeStepId(OP, "workspace"), status: "done" })
    // close the parent op node (caller-settled) so derivation reads terminal.
    store.emit({ type: "node_status", id: worktreeOpNodeId(OP), status: "done" })
    const obs = makeWorktreeActivityObserver({ store, operationId: OP, staged: true })
    obs({ kind: "failed", stage: "checkout", code: "git-add-failed" })
    const snap = store.snapshot()
    expect(checkoutNode(snap)?.status).toBe("failed")
    // deriveContainerStatus: a closed container with a failed child reads failed.
    expect(snap.byId.get(worktreeOpNodeId(OP))?.status).toBe("failed")
  })

  test("stage-started → opens the named stage node as a phase (not agent)", () => {
    const store = seedD1(false) // only the parent op node seeded
    const obs = makeWorktreeActivityObserver({ store, operationId: OP, staged: true })
    obs({ kind: "stage-started", stage: "checkout" })
    const n = checkoutNode(store.snapshot())
    expect(n?.status).toBe("running")
    expect(n?.kind).toBe("phase") // structural — never inflates agent counts
  })

  test("pure mapper is exhaustive: every arm yields at least the expected events", () => {
    expect(
      worktreeProgressToActivity(OP, { kind: "stage-started", stage: "workspace" }),
    ).toHaveLength(1)
    expect(
      worktreeProgressToActivity(OP, { kind: "checkout-progress", completed: 5, total: 10 }),
    ).toHaveLength(1)
    expect(
      worktreeProgressToActivity(OP, { kind: "checkout-progress", completed: 5, total: 0 }),
    ).toHaveLength(0) // indeterminate ⇒ empty
    expect(
      worktreeProgressToActivity(OP, { kind: "stage-completed", stage: "checkout" }),
    ).toHaveLength(1)
    expect(
      worktreeProgressToActivity(OP, { kind: "failed", stage: "checkout", code: "x" }),
    ).toHaveLength(1)
  })
})

describe("adapter inertness — default-OFF byte-identical", () => {
  test("staged off ⇒ observer is a no-op ⇒ checkout node identical to baseline", () => {
    // Baseline: D1 nodes, NO adapter interaction.
    const baseline = seedD1(true)
    const baseNode = checkoutNode(baseline.snapshot())

    // Off path: same D1 nodes + a staged:false observer fed the SAME progress.
    const off = seedD1(true)
    const obs = makeWorktreeActivityObserver({ store: off, operationId: OP, staged: false })
    obs({ kind: "checkout-progress", completed: 77, total: 100 })
    obs({ kind: "stage-completed", stage: "checkout" })
    const offNode = checkoutNode(off.snapshot())

    // RED-on-injection twin: if the observer emitted while off, meta/status
    // would diverge from the baseline — this equality goes RED.
    expect(offNode?.meta?.checkoutPercentage).toBeUndefined()
    expect(offNode).toEqual(baseNode)
    expect(off.snapshot().byId.size).toBe(baseline.snapshot().byId.size)
  })

  test("staged omitted ⇒ also inert (staged !== true)", () => {
    const store = seedD1(true)
    const obs = makeWorktreeActivityObserver({ store, operationId: OP })
    obs({ kind: "checkout-progress", completed: 50, total: 100 })
    expect(checkoutNode(store.snapshot())?.meta?.checkoutPercentage).toBeUndefined()
  })
})

describe("double-emit + retry isolation", () => {
  test("two checkout-progress events ⇒ ONE checkout node, latest %", () => {
    const store = seedD1(true)
    const obs = makeWorktreeActivityObserver({ store, operationId: OP, staged: true })
    obs({ kind: "checkout-progress", completed: 10, total: 100 })
    obs({ kind: "checkout-progress", completed: 90, total: 100 })
    const snap = store.snapshot()
    expect(checkoutNode(snap)?.meta?.checkoutPercentage).toBe("90")
    // idempotent re-open ⇒ still exactly one checkout child under the op node.
    expect(snap.childIds.get(worktreeOpNodeId(OP))).toEqual([
      worktreeStepId(OP, "workspace"),
      checkoutId,
    ])
  })

  test("a retry (new operationId) is isolated with its own fresh progress", () => {
    const store = seedD1(true)
    const op2 = "own-2"
    store.emit(
      worktreeOpenActivity({ operationId: op2, threadId: "t1", label: "feat/x", startedAt: 3 }),
    )
    store.emit(worktreeStepOpen(op2, "checkout", 3))
    makeWorktreeActivityObserver({ store, operationId: OP, staged: true })({
      kind: "checkout-progress",
      completed: 10,
      total: 100,
    })
    makeWorktreeActivityObserver({ store, operationId: op2, staged: true })({
      kind: "checkout-progress",
      completed: 55,
      total: 100,
    })
    const snap = store.snapshot()
    expect(snap.byId.get(worktreeStepId(OP, "checkout"))?.meta?.checkoutPercentage).toBe("10")
    expect(snap.byId.get(worktreeStepId(op2, "checkout"))?.meta?.checkoutPercentage).toBe("55")
  })
})

// Compile-time contract: the input union matches the documented RFC-04 shape.
const _sample: WorktreeCreateProgress = { kind: "checkout-progress", completed: 1, total: 2 }
void _sample
