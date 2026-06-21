import { describe, expect, test } from "bun:test"
import {
  candidateKeepsBaseGreenTests,
  executeWitnessTestsOnPatched,
  keepBaseGreenDiscoveredTests,
} from "@/apps/bench/eval/repo-regression-discovery-adapter"

describe("repo regression discovery adapter helpers", () => {
  test("base preflight keeps the individually green subset", async () => {
    const kept = await keepBaseGreenDiscoveredTests(
      ["tests/test_a.py", "tests/test_b.py", "tests/test_c.py"],
      async (test) =>
        test === "tests/test_a.py" ? true : test === "tests/test_b.py" ? null : false,
    )
    expect(kept).toEqual(["tests/test_a.py"])
  })

  test("candidate must keep every base-green discovered test green", async () => {
    await expect(
      candidateKeepsBaseGreenTests(["tests/test_a.py", "tests/test_b.py"], async () => true),
    ).resolves.toBe(true)

    await expect(
      candidateKeepsBaseGreenTests(
        ["tests/test_a.py", "tests/test_b.py"],
        async (test) => test === "tests/test_a.py",
      ),
    ).resolves.toBe(false)
  })

  test("candidate non-verdict after base-green is treated as a regression, not fail-open", async () => {
    await expect(candidateKeepsBaseGreenTests(["tests/test_a.py"], async () => null)).resolves.toBe(
      false,
    )
  })

  // ── Hellgate: regressionGreen=false is execution-backed, never static-rank ──
  describe("ExecutedWitnessResult: only an executed failure rejects", () => {
    test("a failing EXECUTED witness rejects, and names the executed tests + failure", async () => {
      const executed: string[] = []
      const out = await executeWitnessTestsOnPatched(
        ["tests/test_a.py", "tests/test_b.py"],
        async (test) => {
          executed.push(test)
          return test === "tests/test_b.py" ? false : true
        },
      )
      expect(out.regressionGreen).toBe(false)
      // The rejection is backed by a real execution receipt: the failing test
      // was actually run, and is reported in failures.
      expect(out.executedTests).toEqual(["tests/test_a.py", "tests/test_b.py"])
      expect(out.failures).toEqual(["tests/test_b.py"])
      expect(executed).toEqual(["tests/test_a.py", "tests/test_b.py"])
    })

    test("all executed witnesses green ⇒ regressionGreen=true, no failures", async () => {
      const out = await executeWitnessTestsOnPatched(
        ["tests/test_a.py", "tests/test_b.py"],
        async () => true,
      )
      expect(out.regressionGreen).toBe(true)
      expect(out.executedTests).toEqual(["tests/test_a.py", "tests/test_b.py"])
      expect(out.failures).toEqual([])
    })

    test("a static candidate that is NEVER executed cannot reject (empty set ⇒ green, no run)", async () => {
      let ran = false
      const out = await executeWitnessTestsOnPatched([], async () => {
        ran = true
        return false
      })
      // No execution receipt ⇒ no rejection. `false` is unreachable without a run.
      expect(ran).toBe(false)
      expect(out.regressionGreen).toBe(true)
      expect(out.executedTests).toEqual([])
      expect(out.failures).toEqual([])
    })

    test("a non-verdict (null) on the patched tree counts as a witness failure", async () => {
      const out = await executeWitnessTestsOnPatched(["tests/test_a.py"], async () => null)
      expect(out.regressionGreen).toBe(false)
      expect(out.failures).toEqual(["tests/test_a.py"])
    })
  })
})
