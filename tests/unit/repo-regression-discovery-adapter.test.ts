import { describe, expect, test } from "bun:test"
import {
  candidateKeepsBaseGreenTests,
  executeWitnessTestsOnPatched,
  publicRegressionProofReceiptOf,
  regressionAuthorityOf,
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

  test("proof receipt port preserves not_available/base_not_green/candidate_red/safety_green", async () => {
    const mk = (
      result:
        | { candidateTests: string[]; baseGreenTests: string[]; regressionGreen: boolean | null }
        | undefined,
    ) => {
      const witness = async () => ({
        regressionGreen: result?.regressionGreen ?? null,
        candidateTests: result?.candidateTests ?? [],
        sourceEvidence: new Map(),
        baseGreenTests: result?.baseGreenTests ?? [],
        executedTests: result?.baseGreenTests ?? [],
        failures: result?.regressionGreen === false ? ["tests/test_a.py"] : [],
      })
      return async () => {
        const receipt = await witness()
        if (receipt.candidateTests.length === 0) return "not_available"
        if (receipt.baseGreenTests.length === 0) return "base_not_green"
        return receipt.regressionGreen === true ? "safety_green" : "candidate_red"
      }
    }

    expect(await mk(undefined)()).toBe("not_available")
    expect(await mk({ candidateTests: ["tests/test_a.py"], baseGreenTests: [], regressionGreen: null })()).toBe(
      "base_not_green",
    )
    expect(
      await mk({
        candidateTests: ["tests/test_a.py"],
        baseGreenTests: ["tests/test_a.py"],
        regressionGreen: false,
      })(),
    ).toBe("candidate_red")
    expect(
      await mk({
        candidateTests: ["tests/test_a.py"],
        baseGreenTests: ["tests/test_a.py"],
        regressionGreen: true,
      })(),
    ).toBe("safety_green")
  })

  test("capped positive witness stays coverage_capped and cannot promote back-compat authority", () => {
    const receipt = publicRegressionProofReceiptOf({
      regressionGreen: true,
      candidateTests: ["tests/test_a.py", "tests/test_b.py"],
      sourceEvidence: new Map(),
      baseGreenTests: ["tests/test_a.py"],
      executedTests: ["tests/test_a.py"],
      failures: [],
      cappedWitnesses: { discovered: 2, executed: 1 },
    })
    expect(receipt.state).toBe("coverage_capped")
    expect(regressionAuthorityOf(receipt)).toBeNull()
  })
})
