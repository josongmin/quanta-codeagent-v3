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
    expect(line).toBe("full-remote done — resolved 2 | unresolved 1 | errored 3")
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
    // EXACT, and with every count DISTINCT. Substring checks plus a paired
    // control whose two counts were both 1 left the line permutation-blind:
    // swapping resolved and unresolved in the renderer kept every assertion in
    // this file green, in a file whose whole subject is the line not
    // misreporting the run.
    expect(line).toBe(
      "full-remote done — resolved 2 | unresolved 1 | errored 3 | ⚠️ LOST 1 (box-loss)",
    )
  })

  test("PAIRED CONTROL: with no errors the line is unchanged from before", () => {
    // distinct counts, so the assertion is not symmetric under a swap
    const line = renderFullRemoteOutcomeLine({
      resolved: ["a", "b"],
      unresolved: ["c"],
      errored: [],
      missing: [],
      attempts: 1,
    })
    expect(line).toBe("full-remote done — resolved 2 | unresolved 1")
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
  /**
   * This block used to be
   *
   *     const shape: keyof RelaunchOutcome = "errored"
   *     expect(shape).toBe("errored")
   *
   * which asserts nothing at RUNTIME — it is `"errored" === "errored"` — and
   * `bun test` does not typecheck, so the type annotation carrying the whole
   * claim was never evaluated by anything that ran. Deleting `errored` from the
   * merged outcome left it green.
   *
   * So: run the REAL relaunch merge and put its REAL output through the line.
   */
  test("🔴 an attempt's errored instances survive the merge and reach the line", async () => {
    const { runWithRelaunch } = await import("@/apps/bench/remote/full")
    const out = await runWithRelaunch(
      (ids) => ({
        run: async () => ({
          resolved: [],
          unresolved: [],
          errored: [...ids],
          emptyPatch: [],
          reportPaths: [],
        }),
      }),
      { expected: ["a-1", "b-2", "c-3"], maxRelaunch: 0, onLog: () => {} },
    )
    expect(out.errored, "the merge dropped the errored instances").toEqual(["a-1", "b-2", "c-3"])
    expect(renderFullRemoteOutcomeLine(out)).toMatch(/errored 3/)
  })
})

/**
 * THE FINAL LINE MUST NOT ASSERT A CAUSE IT DOES NOT KNOW.
 *
 * `⚠️ LOST N (box-loss)` and `❓ LOST (never graded across N attempts)` name
 * spot reclaim as the cause of every uncovered instance. But
 * `promax-no-retry-on-deterministic` exists precisely because a permanent
 * CONFIGURATION refusal also lands there — and it prints one line after the log
 * that just said this was NOT box loss.
 */
describe("the LOST note does not claim a cause it cannot know", () => {
  test("🔴 a run stopped by a deterministic refusal is not labelled box-loss", async () => {
    const { FamilyBootstrapError } = await import(
      "@/apps/bench/remote/box-session/family-bootstrap-exec"
    )
    const { runWithRelaunch } = await import("@/apps/bench/remote/full")
    const out = await runWithRelaunch(
      () => ({
        run: async () => {
          throw new FamilyBootstrapError('bootstrap step "campaign-root" FAILED (exit 1)')
        },
      }),
      { expected: ["a-1"], maxRelaunch: 1, onLog: () => {} },
    )
    const line = renderFullRemoteOutcomeLine(out)
    expect(line, "a config refusal was reported as box loss").not.toMatch(/box-loss/)
    expect(line, "the operator is told nothing about the missing instance").toMatch(/LOST 1/)
  })

  test("PAIRED CONTROL: a genuine box loss still says box-loss", () => {
    const line = renderFullRemoteOutcomeLine({
      resolved: [],
      unresolved: [],
      errored: [],
      missing: ["x"],
      attempts: 2,
      stoppedEarly: false,
    })
    expect(line).toMatch(/LOST 1 \(box-loss\)/)
  })
})

/**
 * "EXHAUSTED N ATTEMPTS" MUST COUNT ATTEMPTS THAT RAN.
 *
 * The exhausted line printed the CONFIGURED total, not what happened. A run
 * stopped after one attempt by a deterministic refusal reported "exhausted 2
 * attempt(s)" — a second box that was never launched.
 */
describe("the exhausted line counts what actually ran", () => {
  test("🔴 a run stopped after ONE attempt does not claim two", async () => {
    const { FamilyBootstrapError } = await import(
      "@/apps/bench/remote/box-session/family-bootstrap-exec"
    )
    const { runWithRelaunch } = await import("@/apps/bench/remote/full")
    const logs: string[] = []
    await runWithRelaunch(
      () => ({
        run: async () => {
          throw new FamilyBootstrapError('bootstrap step "campaign-root" FAILED (exit 1)')
        },
      }),
      { expected: ["a-1"], maxRelaunch: 1, onLog: (m) => logs.push(m) },
    )
    const exhausted = logs.find((l) => l.includes("attempt(s)")) ?? ""
    expect(exhausted, "no exhausted line was printed at all").not.toBe("")
    expect(exhausted, "it claimed a box that was never launched").not.toMatch(/exhausted 2/)
    expect(exhausted).toMatch(/1 attempt\(s\)/)
  })

  test("PAIRED CONTROL: a run that really used every attempt says so", async () => {
    const { runWithRelaunch } = await import("@/apps/bench/remote/full")
    const logs: string[] = []
    await runWithRelaunch(
      () => ({
        run: async () => ({
          resolved: [],
          unresolved: [],
          errored: [],
          emptyPatch: [],
          reportPaths: [],
        }),
      }),
      { expected: ["a-1"], maxRelaunch: 1, onLog: (m) => logs.push(m) },
    )
    expect(logs.find((l) => l.includes("attempt(s)")) ?? "").toMatch(/exhausted 2 attempt\(s\)/)
  })
})
