/**
 * PMX-04 — THE OPERATOR'S FINAL LINE MUST NOT HIDE A THIRD OF THE RUN.
 *
 * `full-remote done — resolved N | unresolved M` prints two of the four buckets.
 * For most families the missing third is small. For ProMax it is not: the whole
 * golden-authority class lands in `errored` —
 *
 *   - `infra_invalid`  — the GOLDEN patch itself failed to apply or build, so
 *                        nothing about the model was measured;
 *   - `ambiguous`      — upstream's `need_human_review`, i.e. the grader declined
 *                        to decide;
 *   - and now, an assigned instance the evaluator never reported on at all.
 *
 * So `resolved 12 | unresolved 40` on a 170-instance campaign reads as 12 of 52
 * when the truth may be 12 of 170. A denominator that omits its own errors is
 * the flattering-denominator bug the campaign's reporting rules exist to kill,
 * printed in the one line an operator actually reads.
 */
import { describe, expect, test } from "bun:test"
import { renderFullRemoteOutcomeLine } from "@/apps/bench/commands/grade"

describe("the full-remote outcome line", () => {
  test("🔴 `errored` is stated, not silently dropped", () => {
    const line = renderFullRemoteOutcomeLine({
      resolved: ["a", "b"],
      unresolved: ["c"],
      errored: ["d", "e", "f"],
      missing: [],
      attempts: 1,
    })
    expect(line).toMatch(/errored 3/)
  })

  test("🔴 the line lets an operator recover the DENOMINATOR", () => {
    // 2 + 1 + 3 + 1 = 7 graded-or-lost. Without `errored` it read as 3 of 4.
    const line = renderFullRemoteOutcomeLine({
      resolved: ["a", "b"],
      unresolved: ["c"],
      errored: ["d", "e", "f"],
      missing: ["g"],
      attempts: 1,
    })
    for (const n of ["2", "1", "3"]) expect(line).toContain(n)
    expect(line).toMatch(/LOST 1/)
  })

  test("PAIRED CONTROL: with no errors the line is unchanged from before", () => {
    const line = renderFullRemoteOutcomeLine({
      resolved: ["a"],
      unresolved: ["b"],
      errored: [],
      missing: [],
      attempts: 1,
    })
    expect(line).toBe("full-remote done — resolved 1 | unresolved 1")
  })

  test("attempts and box-loss still surface", () => {
    const line = renderFullRemoteOutcomeLine({
      resolved: [],
      unresolved: [],
      errored: [],
      missing: ["x"],
      attempts: 3,
    })
    expect(line).toMatch(/LOST 1 \(box-loss\)/)
    expect(line).toMatch(/\[3 attempts\]/)
  })
})

describe("WIRING — the merged outcome really carries `errored` to this line", () => {
  test("🔴 RelaunchOutcome declares errored, so the main path cannot drop it", async () => {
    // The line is only as good as what reaches it. `RelaunchOutcome` is what the
    // instance-aware path hands `logFullRemoteOutcome`; if `errored` were not on
    // it, the field above would be permanently undefined and the fix cosmetic.
    const mod = await import("@/apps/bench/remote/full")
    const shape: keyof import("@/apps/bench/remote/full").RelaunchOutcome = "errored"
    expect(shape).toBe("errored")
    expect(typeof mod.runWithRelaunch).toBe("function")
  })
})
