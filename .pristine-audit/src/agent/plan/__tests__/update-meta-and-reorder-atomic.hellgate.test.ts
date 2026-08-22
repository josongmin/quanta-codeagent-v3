/**
 * T04 hellgate — `updateMetaAndReorder` is ONE atomic store mutation.
 *
 * Audit ref: L2 H6 (updateMeta + reorderPhases composed as TWO store calls
 * with TWO version bumps; partial-failure leaves meta landed but order not).
 *
 * Invariants proven:
 *   1. Success bumps version by EXACTLY 1 (not 2) — meta + reorder are one CAS.
 *   2. When the reorder set is invalid, NEITHER the meta change NOR the order
 *      change is applied (all-or-nothing — no half-mutation).
 *   3. Meta-only (no phaseOrder) behaves like updateMeta (single bump).
 *   4. Reorder-only (no meta) behaves like reorderPhases (single bump).
 */
import { describe, expect, test } from "bun:test"
import { createPlan, updateMetaAndReorder } from "../mutations"
import type { CreatePlanArgs, Plan, PlanResult } from "../types"

const NOW = 1_700_000_000_000
const seqGen = (prefix = "id"): (() => string) => {
  let n = 0
  return () => {
    n += 1
    return `${prefix}-${n}`
  }
}
const unwrap = <T>(r: PlanResult<T>): T => {
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`)
  return r.value
}
const planOf = (r: PlanResult): Plan => unwrap(r).plan

const base = (): Plan => {
  const args: CreatePlanArgs = {
    name: "orig",
    overview: "ov",
    todos: [{ content: "A" }, { content: "B" }],
    phases: [
      { name: "P1", todoIndexes: [0] },
      { name: "P2", todoIndexes: [1] },
    ],
  }
  return planOf(createPlan(args, NOW, seqGen()))
}

describe("T04 — updateMetaAndReorder atomicity", () => {
  test("meta + reorder land together with ONE version bump", () => {
    const plan = base()
    const [p1, p2] = plan.phases
    if (p1 === undefined || p2 === undefined) throw new Error("setup")
    const next = planOf(updateMetaAndReorder(plan, { name: "renamed" }, [p2.id, p1.id], NOW + 1))
    expect(next.version).toBe(plan.version + 1)
    expect(next.name).toBe("renamed")
    expect(next.phases.map((p) => p.id)).toEqual([p2.id, p1.id])
    // order indices renumbered.
    expect(next.phases[0]?.order).toBe(0)
    expect(next.phases[1]?.order).toBe(1)
  })

  test("invalid reorder set → error AND meta NOT applied (all-or-nothing)", () => {
    const plan = base()
    const r = updateMetaAndReorder(plan, { name: "should-not-stick" }, ["ghost"], NOW + 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("phase_not_found")
    // Caller still holds the ORIGINAL plan: name unchanged, version unchanged.
    expect(plan.name).toBe("orig")
    expect(plan.version).toBe(0)
  })

  test("invalid meta (name too long) → error and order NOT applied", () => {
    const plan = base()
    const [p1, p2] = plan.phases
    if (p1 === undefined || p2 === undefined) throw new Error("setup")
    const huge = "x".repeat(100_000)
    const r = updateMetaAndReorder(plan, { name: huge }, [p2.id, p1.id], NOW + 1)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("content_too_long")
    expect(plan.phases.map((p) => p.id)).toEqual([p1.id, p2.id])
  })

  test("meta-only (no phaseOrder) is a single bump, order preserved", () => {
    const plan = base()
    const next = planOf(updateMetaAndReorder(plan, { overview: "new-ov" }, undefined, NOW + 1))
    expect(next.version).toBe(plan.version + 1)
    expect(next.overview).toBe("new-ov")
    expect(next.phases.map((p) => p.id)).toEqual(plan.phases.map((p) => p.id))
  })

  test("reorder-only (empty meta) is a single bump, meta preserved", () => {
    const plan = base()
    const [p1, p2] = plan.phases
    if (p1 === undefined || p2 === undefined) throw new Error("setup")
    const next = planOf(updateMetaAndReorder(plan, {}, [p2.id, p1.id], NOW + 1))
    expect(next.version).toBe(plan.version + 1)
    expect(next.name).toBe("orig")
    expect(next.phases.map((p) => p.id)).toEqual([p2.id, p1.id])
  })

  test("no-op (empty meta, no order) still bumps exactly once", () => {
    const plan = base()
    const next = planOf(updateMetaAndReorder(plan, {}, undefined, NOW + 1))
    expect(next.version).toBe(plan.version + 1)
  })
})
