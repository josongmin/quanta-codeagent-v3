/**
 * RFC-04 D3 — worktree runtime-progress → activity adapter hellgate (aug-22).
 *
 * The adapter is the ONE cross-domain seam that maps a worktree-create runtime
 * STAGE stream onto the D1 staged activity nodes (workspace/checkout). It is an
 * UNWIRED forward seam (no production caller — pinned by
 * `worktree-checkout-progress-retired.test.ts`); the delivered staged-card UX is
 * emitted directly by `current-thread-worktree.ts`. These tests drive the mapper
 * through the REAL `createActivityStore` + `materialize` (per jul-13/jul-15: a
 * fake sink hides seam bugs), proving:
 *   - each lifecycle stage (started/completed/failed) maps onto the D1 phase node;
 *   - the adapter is INERT when staged off / no progress source — byte-identical
 *     to the D1-only baseline (red-on-injection twin flips the gate);
 *   - the closed runtime union maps exhaustively to terminal settlement, and a
 *     retry (new operationId) is isolated with its own fresh stage stream.
 *
 * The RFC-04 D2 real-time checkout-% arm was RETIRED (RESOLUTION-PLAN R5): git
 * worktree add streams no checkout meter, so no real ratio can be produced. The
 * union carries only lifecycle stages now — there is no percentage to assert.
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

describe("worktreeProgressToActivity — exhaustive pure stage mapping", () => {
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

  test("pure mapper is exhaustive: every arm yields exactly one event", () => {
    expect(
      worktreeProgressToActivity(OP, { kind: "stage-started", stage: "workspace" }),
    ).toHaveLength(1)
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

    // Off path: same D1 nodes + a staged:false observer fed the SAME stages.
    const off = seedD1(true)
    const obs = makeWorktreeActivityObserver({ store: off, operationId: OP, staged: false })
    obs({ kind: "stage-started", stage: "checkout" })
    obs({ kind: "stage-completed", stage: "checkout" })
    const offNode = checkoutNode(off.snapshot())

    // RED-on-injection twin: if the observer emitted while off, status would
    // diverge from the baseline — this equality goes RED.
    expect(offNode?.status).toBe("running")
    expect(offNode).toEqual(baseNode)
    expect(off.snapshot().byId.size).toBe(baseline.snapshot().byId.size)
  })

  test("staged omitted ⇒ also inert (staged !== true)", () => {
    const store = seedD1(true)
    const obs = makeWorktreeActivityObserver({ store, operationId: OP })
    obs({ kind: "stage-completed", stage: "checkout" })
    // Inert: the checkout node stays exactly as D1 seeded it (running, no settle).
    expect(checkoutNode(store.snapshot())?.status).toBe("running")
  })
})

describe("retry isolation", () => {
  test("a retry (new operationId) is isolated with its own fresh stage stream", () => {
    const store = seedD1(true)
    const op2 = "own-2"
    store.emit(
      worktreeOpenActivity({ operationId: op2, threadId: "t1", label: "feat/x", startedAt: 3 }),
    )
    store.emit(worktreeStepOpen(op2, "checkout", 3))
    makeWorktreeActivityObserver({ store, operationId: OP, staged: true })({
      kind: "stage-completed",
      stage: "checkout",
    })
    makeWorktreeActivityObserver({ store, operationId: op2, staged: true })({
      kind: "failed",
      stage: "checkout",
      code: "x",
    })
    const snap = store.snapshot()
    // Each operation's checkout child settled independently — no cross-talk.
    expect(snap.byId.get(worktreeStepId(OP, "checkout"))?.status).toBe("done")
    expect(snap.byId.get(worktreeStepId(op2, "checkout"))?.status).toBe("failed")
  })
})

// Compile-time contract: the input union carries lifecycle stages only.
const _sample: WorktreeCreateProgress = { kind: "stage-started", stage: "checkout" }
void _sample
