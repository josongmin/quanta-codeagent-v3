/**
 * Hellgate — `fromSnapshot` enforces the `todo.phaseId → phase.todoIds`
 * direction of the bidirectional membership invariant on RESTORE.
 *
 * Audit ref: SERDE (high) — `fromSnapshot` admitted `todo.phaseId` with no
 * existence/membership check, so a restore from an externally-persisted /
 * hand-editable snapshot could install a `Plan` that violates the invariant
 * `todo.phaseId ↔ phase.todoIds` that every mutation reducer guarantees via
 * `syncPhaseMembership` (and that `addTodos` rejects unknown phaseId as
 * `phase_not_found`).
 *
 * Class 9 (phase.todoIds → todos) was already covered. This proves the reverse
 * direction (corruption class 10) is now also rejected — FAIL-CLOSED, never
 * silently dropped or re-derived (re-deriving would hide the corruption).
 *
 * Adversarial cases proven:
 *   1. dangling `todo.phaseId` (phase does not exist)              → phase_not_found
 *   2. asymmetric membership (phase exists but omits the todo id)  → phase_membership_asymmetry/missing_in_phase
 *   3. a todo id claimed by two phases' todoIds                    → phase_membership_asymmetry/claimed_by_two_phases
 *   4. a WELL-FORMED plan round-trips unchanged (no false reject)
 */
import { describe, expect, test } from "bun:test"
import { fromSnapshot, toSnapshot } from "../snapshot"
import type { Plan } from "../types"

const NOW = 1_700_000_000_000

/** A well-formed two-phase plan honoring the bidirectional invariant. */
const wellFormedPlan = (): Plan => ({
  version: 3,
  name: "demo",
  overview: "two-phase plan",
  isProject: true,
  todos: {
    t1: {
      id: "t1",
      content: "first",
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
      dependencies: [],
      phaseId: "p1",
    },
    t2: {
      id: "t2",
      content: "second",
      status: "in_progress",
      createdAt: NOW,
      updatedAt: NOW + 1,
      dependencies: ["t1"],
      phaseId: "p2",
    },
  },
  phases: [
    { id: "p1", name: "alpha", todoIds: ["t1"], order: 0 },
    { id: "p2", name: "beta", todoIds: ["t2"], order: 1 },
  ],
  createdAt: NOW,
  updatedAt: NOW + 1,
})

/** Deep-clone a snapshot to a plain (mutable, unfrozen) JSON object so the
 *  test can corrupt it the way an external/hand-edited persisted snapshot
 *  would be corrupted, then feed it back through the parser. */
// biome-ignore lint/suspicious/noExplicitAny: deliberate corruption of a raw snapshot shape.
const rawSnapshot = (p: Plan): any => JSON.parse(JSON.stringify(toSnapshot(p)))

describe("fromSnapshot — todo.phaseId → phase membership (corruption class 10)", () => {
  test("ANTI-THEATER: well-formed plan round-trips unchanged (no false reject)", () => {
    const snap = toSnapshot(wellFormedPlan())
    const r = fromSnapshot(snap)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual(wellFormedPlan())
  })

  test("dangling todo.phaseId (phase absent) → rejected phase_not_found", () => {
    const raw = rawSnapshot(wellFormedPlan())
    // t1 now claims a phase that does not exist; phases[] only has p1/p2.
    raw.plan.todos.t1.phaseId = "ghost"
    raw.plan.phases[0].todoIds = [] // p1 no longer lists t1 either
    const r = fromSnapshot(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("phase_not_found")
      if (r.error.kind === "phase_not_found") expect(r.error.id).toBe("ghost")
    }
  })

  test("asymmetric membership (phase omits the todo id) → rejected", () => {
    const raw = rawSnapshot(wellFormedPlan())
    // t1.phaseId === p1, but p1.todoIds drops t1. The phase EXISTS, so this is
    // NOT phase_not_found — it is the reverse-direction asymmetry.
    raw.plan.phases[0].todoIds = []
    const r = fromSnapshot(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("phase_membership_asymmetry")
      // biome-ignore lint/suspicious/noExplicitAny: snapshot-only error shape narrowing.
      const e = r.error as any
      expect(e.todoId).toBe("t1")
      expect(e.phaseId).toBe("p1")
      expect(e.detail).toBe("missing_in_phase")
    }
  })

  test("todo id claimed by two phases → rejected", () => {
    const raw = rawSnapshot(wellFormedPlan())
    // p2 now ALSO lists t1; both phases claim t1. Still a real todo, so class 9
    // (phase→todo) passes; only the bidirectional cross-check catches it.
    raw.plan.phases[1].todoIds = ["t1", "t2"]
    const r = fromSnapshot(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("phase_membership_asymmetry")
      // biome-ignore lint/suspicious/noExplicitAny: snapshot-only error shape narrowing.
      const e = r.error as any
      expect(e.todoId).toBe("t1")
      expect(e.detail).toBe("claimed_by_two_phases")
    }
  })

  test("the original SERDE attack: hand-edited phaseId with no membership wiring", () => {
    // Exactly the admitted path: a snapshot where a todo carries phaseId but the
    // phase array was never updated to mirror it. Before the fix `fromSnapshot`
    // installed this plan verbatim; now it fails closed.
    const raw = rawSnapshot(wellFormedPlan())
    raw.plan.todos.t2.phaseId = "p1" // claim p1, but p1.todoIds=[t1] only
    const r = fromSnapshot(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("phase_membership_asymmetry")
  })
})
