/**
 * A dataset family that the running MODE cannot honor must REFUSE, not apply
 * itself halfway.
 *
 * aug-23, measured on the real CLI (`--dry-run`, 3/3 reproducible):
 *
 *   run --dry-run --limit 1                          -> preset agentless-v3-thin-strict
 *   run --dataset-family verified --dry-run --limit 1 -> preset agentless-v3-thin-strict
 *   run --dataset-family promax   --dry-run --limit 1 -> preset agentless-v1
 *
 * The third run is CUSTOM-CORPUS mode: no `--swebench`, so it reads the local
 * 500-row corpus, never calls the family's corpus reader, never runs the ProMax
 * preflight, grades with the local `testCmd`, and — deliberately, BFND-02 — does
 * not stamp `datasetFamily` into the report. Exactly ONE thing survived: the
 * family's `remoteDefaultPreset` had already been seeded into the execution
 * preset at the composition root.
 *
 * So the report is honestly labelled `verified` while the CONFIGURATION is
 * ProMax's. That is the worst shape for a measurement tool: an operator who adds
 * `--dataset-family promax` to one arm of a local A/B silently gets a different
 * agent preset on that arm, and neither the plan nor the report discloses it.
 * The dry-run does not even print a family line in this mode.
 *
 * `--dataset-family`'s own help text promises "an explicit unknown/blank family
 * is REFUSED, never silently defaulted — a typo must not grade one corpus with
 * another's harness". That promise is enforced on the family's VALUE. This guard
 * extends it to the family's APPLICABILITY: a selector the mode cannot honor is
 * refused rather than half-applied.
 */
import { describe, expect, test } from "bun:test"
import {
  assertFamilySelectorHonored,
  BENCH_EXECUTION_MODES,
  MODE_HONORS_FAMILY,
} from "@/apps/bench/family-mode-honor"

describe("a family selector the mode cannot honor is refused", () => {
  test("custom-corpus + EXPLICIT family ⇒ refuses", () => {
    expect(() =>
      assertFamilySelectorHonored({
        mode: "custom-corpus",
        familySelector: "explicit",
        datasetFamily: "promax",
      }),
    ).toThrow(/custom-corpus/i)
  })

  test("the refusal names the family, the reason, and the honest alternative", () => {
    let message = ""
    try {
      assertFamilySelectorHonored({
        mode: "custom-corpus",
        familySelector: "explicit",
        datasetFamily: "promax",
      })
    } catch (e) {
      message = (e as Error).message
    }
    // the family the operator actually named — not a generic "invalid mode"
    expect(message).toContain("promax")
    // WHY it cannot be honored: this mode reads no SWE dataset
    expect(message).toMatch(/reads no SWE dataset|no dataset|never reads/i)
    // the one effect that WOULD have leaked through, named so the operator can
    // tell whether that is what they wanted
    expect(message).toMatch(/preset/i)
  })

  test("PAIRED CONTROL: custom-corpus + ABSENT selector is untouched", () => {
    expect(() =>
      assertFamilySelectorHonored({
        mode: "custom-corpus",
        familySelector: "absent",
        datasetFamily: "verified",
      }),
    ).not.toThrow()
  })

  test("PAIRED CONTROL: official-dataset mode honors an explicit family", () => {
    for (const family of ["verified", "pro", "promax"] as const) {
      expect(() =>
        assertFamilySelectorHonored({
          mode: "official-dataset",
          familySelector: "explicit",
          datasetFamily: family,
        }),
      ).not.toThrow()
    }
  })

  test("DRIFT GUARD: every execution mode is classified, both directions", () => {
    // (see below for the WIRING proof — a pure guard nothing calls is a dead seam)
    // A new mode must be classified here or this fails to compile//run — the
    // table is keyed by the closed union, and the runtime check catches a key
    // added to one side only.
    expect(Object.keys(MODE_HONORS_FAMILY).sort()).toEqual([...BENCH_EXECUTION_MODES].sort())
    expect(BENCH_EXECUTION_MODES.length).toBeGreaterThan(1)
    // at least one mode on each side, else the guard is vacuous
    const values = Object.values(MODE_HONORS_FAMILY)
    expect(values).toContain(true)
    expect(values).toContain(false)
  })
})

/**
 * WIRING PROOF — the guard above is only worth anything if the composition root
 * actually calls it. A pure predicate with no live call site is the dead-seam
 * shape this repo has been bitten by before, and a unit test of the predicate
 * alone cannot tell the two apart.
 *
 * These drive the REAL `runMain`. `--dry-run` is required (not `--help`):
 * `--help` returns from `runMain` well before the mode split, so a `--help`
 * flavour of this test would pass with the call site deleted.
 */
const withArgv = async <T>(argv: readonly string[], body: () => Promise<T>): Promise<T> => {
  const argvBefore = process.argv
  const envBefore = { ...process.env }
  process.argv = ["bun", "cli.ts", ...argv]
  try {
    return await body()
  } finally {
    process.argv = argvBefore
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, envBefore)
  }
}

const noopExit = (): never => undefined as never

describe("WIRING — the composition root enforces it on the live custom-corpus path", () => {
  test("runMain REJECTS an explicit family in custom-corpus mode", async () => {
    const { runMain, __resetBenchExitForTest } = await import("@/apps/bench/run-main")
    await withArgv(["run", "--dataset-family", "promax", "--dry-run", "--limit", "1"], async () => {
      // RED-ON-INJECTION: delete the `assertFamilySelectorHonored(...)` call in
      // run-main.ts and this resolves instead of rejecting — which is exactly
      // the silent agentless-v1 swap this whole file exists to stop.
      await expect(runMain({ exit: noopExit })).rejects.toThrow(/cannot be honored/i)
    })
    __resetBenchExitForTest()
  })

  test("PAIRED CONTROL: the same run WITHOUT the family flag is not rejected", async () => {
    const { runMain, __resetBenchExitForTest } = await import("@/apps/bench/run-main")
    await withArgv(["run", "--dry-run", "--limit", "1"], async () => {
      // Proves the rejection is caused by the SELECTOR, not by `--dry-run`, the
      // corpus, or anything else in this argv shape.
      await expect(runMain({ exit: noopExit })).resolves.toBeUndefined()
    })
    __resetBenchExitForTest()
  })
})
