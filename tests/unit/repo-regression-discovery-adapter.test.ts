import { describe, expect, test } from "bun:test"
import {
  candidateKeepsBaseGreenTests,
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
})
