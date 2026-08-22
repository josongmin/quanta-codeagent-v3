/**
 * RFC-04 D1 — staged worktree-init producer hellgate (aug-22 absorption).
 *
 * D1 refines the single coarse worktree-op `phase` node into a PARENT CONTAINER
 * with staged child step nodes (workspace / checkout / setup), MIRRORING the
 * `createWorkflowSink` container pattern (`store.ts:113`) but WITHOUT its
 * `kind:"agent"` accounting error — the steps are `kind:"phase"` so they never
 * fabricate agent/worker counts. The container's status is DERIVED by
 * `deriveContainerStatus` (`spine.ts`), which is why `skipped ≠ failed` is
 * load-bearing: a proceed-after-setup-skip must leave the container `done`.
 *
 * Every status assertion round-trips through a REAL store + `materialize` (never
 * a single-literal assertion on a raw event) and each load-bearing rule carries
 * a red-on-injection twin (per the vacuity trap, jul-4 / test-quality-culture):
 *   A. staged children render UNDER the parent container; container derives done (3)
 *   B. skipped ≠ failed — the load-bearing derivation + its injection twin       (3)
 *   C. aggregate agent/running/stuck invariance: coarse ≡ staged                 (2)
 *   D. flag-OFF byte-identical vs single-node + off-vs-on differs (twin)         (2)
 */

import { describe, expect, test } from "bun:test"
import {
  type ActivitySnapshot,
  createActivityStore,
  worktreeOpenActivity,
  worktreeOpNodeId,
  worktreeSettleActivity,
  worktreeStepId,
  worktreeStepOpen,
  worktreeStepSettle,
} from "@/activity"

const OP = "op-d1"
const openOpts = {
  operationId: OP,
  threadId: "thread-A",
  label: "worktree: fork-x",
  startedAt: 1000,
}

/** Materialize a coarse (single-node) worktree operation: open → settle. */
const coarse = (kind: "ready" | "failed"): ActivitySnapshot => {
  const store = createActivityStore()
  store.emit(worktreeOpenActivity(openOpts))
  store.emit(worktreeSettleActivity(OP, kind, 2000))
  return store.snapshot()
}

// ── A. staged children render under the parent container ─────────────────────

describe("A — staged children under the parent container", () => {
  test("A1 — workspace + checkout attach as leaf children of the op node; container derives done", () => {
    const store = createActivityStore()
    store.emit(worktreeOpenActivity(openOpts))
    store.emit(worktreeStepOpen(OP, "workspace", 1000))
    store.emit(worktreeStepSettle(OP, "workspace", "done", 1001))
    store.emit(worktreeStepOpen(OP, "checkout", 1001))
    store.emit(worktreeStepSettle(OP, "checkout", "done", 1500))
    store.emit(worktreeSettleActivity(OP, "ready", 2000))
    const s = store.snapshot()

    const parent = worktreeOpNodeId(OP)
    // The op node is now a CONTAINER with the two stage children (first-seen order).
    expect(s.childIds.get(parent)).toEqual([
      worktreeStepId(OP, "workspace"),
      worktreeStepId(OP, "checkout"),
    ])
    // Children are real leaves with the mirrored workflow-sink labels.
    const ws = s.byId.get(worktreeStepId(OP, "workspace"))
    const co = s.byId.get(worktreeStepId(OP, "checkout"))
    expect(ws?.parentId).toBe(parent)
    expect(ws?.label).toBe("Preparing workspace")
    expect(ws?.status).toBe("done")
    expect(co?.label).toBe("Checking out files")
    expect(co?.status).toBe("done")
    // Parent status is DERIVED from the (all-done) children — honest container.
    expect(s.byId.get(parent)?.status).toBe("done")
    // The parent keeps the correlation; the children do NOT (so a surface that
    // filters op nodes by correlation still finds exactly ONE — the e2e fence).
    expect(s.byId.get(parent)?.correlation?.operationId).toBe(OP)
    expect(ws?.correlation).toBeUndefined()
    expect(co?.correlation).toBeUndefined()
  })

  test("A2 — a failed checkout child makes the container derive failed", () => {
    const store = createActivityStore()
    store.emit(worktreeOpenActivity(openOpts))
    store.emit(worktreeStepOpen(OP, "workspace", 1000))
    store.emit(worktreeStepSettle(OP, "workspace", "done", 1001))
    store.emit(worktreeStepOpen(OP, "checkout", 1001))
    store.emit(worktreeStepSettle(OP, "checkout", "failed", 1500))
    // Parent asserted `failed` too (the transition settles failed on git error).
    store.emit(worktreeSettleActivity(OP, "failed", 2000))
    const s = store.snapshot()
    expect(s.byId.get(worktreeStepId(OP, "checkout"))?.status).toBe("failed")
    expect(s.byId.get(worktreeOpNodeId(OP))?.status).toBe("failed")
  })

  test("A3 — step id is a stable, namespaced fn of (op, step) — no sibling alias", () => {
    expect(worktreeStepId(OP, "workspace")).toBe(`${worktreeOpNodeId(OP)}/workspace`)
    // A `/` in the operationId is url-encoded by the parent id, so the step id
    // can never break the namespace or alias a sibling operation's step.
    expect(worktreeStepId("a/b", "checkout")).toBe("worktree-op/a%2Fb/checkout")
    expect(worktreeStepId("a/b", "checkout")).not.toBe(worktreeStepId("a", "b/checkout" as never))
  })
})

// ── B. skipped ≠ failed (the #1 load-bearing semantic) ──────────────────────

describe("B — skipped ≠ failed (deriveContainerStatus is load-bearing)", () => {
  // Note: D1 does NOT wire a `setup` child into the transaction (that is D3,
  // PARKED). This exercises the PRODUCER's skip capability + the derivation rule
  // that makes the future "Environment setup skipped" honest.
  test("B1 — a proceed-after-setup-skip leaves the container DONE (skip is non-fatal)", () => {
    const store = createActivityStore()
    store.emit(worktreeOpenActivity(openOpts))
    store.emit(worktreeStepOpen(OP, "workspace", 1000))
    store.emit(worktreeStepSettle(OP, "workspace", "done", 1001))
    store.emit(worktreeStepOpen(OP, "setup", 1500))
    store.emit(worktreeStepSettle(OP, "setup", "skipped", 1600))
    store.emit(worktreeSettleActivity(OP, "ready", 2000))
    const s = store.snapshot()
    expect(s.byId.get(worktreeStepId(OP, "setup"))?.status).toBe("skipped")
    // The created worktree is honestly DONE despite the skipped setup.
    expect(s.byId.get(worktreeOpNodeId(OP))?.status).toBe("done")
    expect(s.byId.get(worktreeStepId(OP, "setup"))?.label).toBe("Setting up environment")
  })

  test("B2 — RED-ON-INJECTION: flip the skip → failed and the container derives FAILED", () => {
    // Same shape as B1 but the proceed-anyway step is (wrongly) `failed`. If the
    // derivation did NOT distinguish skipped from failed, B1 would already be
    // failing; this proves the distinction is real (not cosmetic).
    const store = createActivityStore()
    store.emit(worktreeOpenActivity(openOpts))
    store.emit(worktreeStepOpen(OP, "workspace", 1000))
    store.emit(worktreeStepSettle(OP, "workspace", "done", 1001))
    store.emit(worktreeStepOpen(OP, "setup", 1500))
    store.emit(worktreeStepSettle(OP, "setup", "failed", 1600))
    store.emit(worktreeSettleActivity(OP, "ready", 2000))
    const s = store.snapshot()
    expect(s.byId.get(worktreeOpNodeId(OP))?.status).toBe("failed")
    // Direct contrast with B1: identical events except skipped→failed flips the
    // derived container status. That delta is the load-bearing property.
    expect(s.byId.get(worktreeOpNodeId(OP))?.status).not.toBe(
      coarse("ready").byId.get(worktreeOpNodeId(OP))?.status,
    )
  })
})

// ── C. aggregate invariance (structural steps never fabricate worker counts) ─

describe("C — aggregate agent/running/stuck invariance", () => {
  test("C1 — staged (parent + 2 phase children) ≡ coarse in agents/running/stuck", () => {
    const staged = createActivityStore()
    staged.emit(worktreeOpenActivity(openOpts))
    staged.emit(worktreeStepOpen(OP, "workspace", 1000))
    staged.emit(worktreeStepSettle(OP, "workspace", "done", 1001))
    staged.emit(worktreeStepOpen(OP, "checkout", 1001))
    staged.emit(worktreeStepSettle(OP, "checkout", "done", 1500))
    staged.emit(worktreeSettleActivity(OP, "ready", 2000))
    const a = staged.snapshot().aggregate
    const b = coarse("ready").aggregate
    // The structural stages are `phase` (never `agent`) — no worker fabrication.
    expect(a.agents).toBe(b.agents)
    expect(a.running).toBe(b.running)
    expect(a.stuck).toBe(b.stuck)
  })

  test("C2 — RED-ON-INJECTION control: an `agent`-kind child WOULD bump the count", () => {
    // Proves C1 is non-vacuous: the aggregate genuinely responds to an
    // agent-kind child, so the phase-kind choice in C1 is what preserves it.
    const store = createActivityStore()
    store.emit(worktreeOpenActivity(openOpts))
    store.emit({
      type: "node_open",
      node: {
        id: `${worktreeOpNodeId(OP)}/rogue`,
        parentId: worktreeOpNodeId(OP),
        kind: "agent",
        label: "rogue",
        status: "running",
      },
    })
    store.emit(worktreeSettleActivity(OP, "ready", 2000))
    expect(store.snapshot().aggregate.agents).toBe(coarse("ready").aggregate.agents + 1)
  })
})

// ── D. flag-OFF byte-identical vs the single-node output ─────────────────────

describe("D — flag-OFF byte-identical (single coarse node)", () => {
  test("D1 — the coarse stream leaves the op node a leaf with its asserted status", () => {
    const s = coarse("ready")
    const parent = worktreeOpNodeId(OP)
    expect(s.roots).toEqual([parent])
    expect(s.childIds.get(parent) ?? []).toEqual([]) // no children — leaf
    expect(s.byId.get(parent)?.status).toBe("done") // asserted (not derived)
  })

  test("D2 — off-vs-on genuinely differs (twin): staged emits children, coarse does not", () => {
    const on = createActivityStore()
    on.emit(worktreeOpenActivity(openOpts))
    on.emit(worktreeStepOpen(OP, "workspace", 1000))
    on.emit(worktreeStepSettle(OP, "workspace", "done", 1001))
    on.emit(worktreeSettleActivity(OP, "ready", 2000))
    const parent = worktreeOpNodeId(OP)
    expect((on.snapshot().childIds.get(parent) ?? []).length).toBeGreaterThan(0)
    expect((coarse("ready").childIds.get(parent) ?? []).length).toBe(0)
  })
})
