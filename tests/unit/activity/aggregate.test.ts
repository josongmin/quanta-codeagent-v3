/**
 * RFC-04 (R6) D1 — aggregate invariance hellgate (aug-22 absorption).
 *
 * The load-bearing D1 receipt: adding an `operation` container with `step`
 * children (and typed progress) must leave the AGENT aggregate byte-identical —
 * structural op/step nodes are NOT workers and must never fabricate
 * agent/running/stuck counts (the `kind:"agent"` accounting error the workflow
 * sink makes, deliberately NOT copied).
 *
 * Everything round-trips through a REAL store + `materialize` (never a
 * single-literal assertion), and the invariance is proven by DIFFERENCE against
 * a coarse baseline — with a red-on-injection twin proving the test has teeth.
 */

import { describe, expect, test } from "bun:test"
import { type ActivityEvent, type ActivityKind, createActivityStore } from "@/activity"

const open = (id: string, parentId: string | null, kind: ActivityKind): ActivityEvent => ({
  type: "node_open",
  node: { id, parentId, kind, label: id },
})

describe("D1 · agent aggregate invariance", () => {
  test("an operation + 3 step children leave the agent aggregate unchanged", () => {
    // Baseline: one real worker agent, nothing else.
    const baseline = createActivityStore()
    baseline.emit(open("agent-1", null, "agent"))
    const base = baseline.snapshot().aggregate

    // Staged: the SAME worker plus a full staged worktree operation.
    const staged = createActivityStore()
    staged.emit(open("agent-1", null, "agent"))
    staged.emit(open("op", null, "operation"))
    staged.emit(open("s1", "op", "step"))
    staged.emit(open("s2", "op", "step"))
    staged.emit(open("s3", "op", "step"))
    const agg = staged.snapshot().aggregate

    expect(agg.agents).toBe(base.agents) // op/step are NOT agent-kind
    expect(agg.running).toBe(base.running)
    expect(agg.stuck).toBe(base.stuck)
    expect(agg.tokens).toBe(base.tokens)
    expect(agg.toolCalls).toBe(base.toolCalls)
  })

  test('red-on-injection: making the steps kind:"agent" DOES corrupt the aggregate', () => {
    // Proves the invariance above is real (not vacuous): the SAME shape with
    // step nodes mislabelled `agent` inflates the worker count.
    const baseline = createActivityStore()
    baseline.emit(open("agent-1", null, "agent"))
    const base = baseline.snapshot().aggregate

    const corrupted = createActivityStore()
    corrupted.emit(open("agent-1", null, "agent"))
    corrupted.emit(open("op", null, "operation"))
    corrupted.emit(open("s1", "op", "agent")) // <- the accounting error
    corrupted.emit(open("s2", "op", "agent"))
    corrupted.emit(open("s3", "op", "agent"))
    const agg = corrupted.snapshot().aggregate

    expect(agg.agents).toBe(base.agents + 3) // inflated — confirms the guard bites
    expect(agg.running).toBe(base.running + 3)
  })

  test("node_progress on a step leaves the aggregate unchanged (progress is not a metric)", () => {
    const store = createActivityStore()
    store.emit(open("s", null, "step"))
    const before = store.snapshot().aggregate
    store.emit({
      type: "node_progress",
      id: "s",
      progress: { kind: "ratio", completed: 5, total: 10 },
    })
    const after = store.snapshot()

    expect(after.aggregate).toEqual(before) // no counter perturbation
    // and the typed progress rides the node itself (not free-form meta).
    expect(after.byId.get("s")?.progress).toEqual({ kind: "ratio", completed: 5, total: 10 })
  })

  test("node_progress for an unknown id is a NO-THROW drop (spine parity)", () => {
    const store = createActivityStore()
    store.emit(open("known", null, "step"))
    expect(() =>
      store.emit({ type: "node_progress", id: "ghost", progress: { kind: "indeterminate" } }),
    ).not.toThrow()
    expect(store.snapshot().byId.has("ghost")).toBe(false)
  })

  test("store-applied regression guard: a rewinding progress becomes indeterminate on the node", () => {
    const store = createActivityStore()
    store.emit(open("s", null, "step"))
    store.emit({
      type: "node_progress",
      id: "s",
      progress: { kind: "ratio", completed: 8, total: 10 },
    })
    store.emit({
      type: "node_progress",
      id: "s",
      progress: { kind: "ratio", completed: 3, total: 10 },
    })
    expect(store.snapshot().byId.get("s")?.progress).toEqual({ kind: "indeterminate" })
  })
})
