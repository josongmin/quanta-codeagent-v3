import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  mayQuarantine,
  preserveFirstFailure,
  requiredOutcomeAfterRetry,
} from "../../../tools/dev/verification-first-failure"
import {
  NIGHTLY_MEMBERSHIP,
  NIGHTLY_SCHEDULES,
} from "../../../tools/dev/verification-nightly-manifest"

describe("first failure is immutable", () => {
  test("retry pass is not required green", () => {
    const first = {
      testId: "tests/unit/a.test.ts",
      kind: "assertion" as const,
      fingerprint: "abc",
      sha: "deadbeef",
      elapsedMs: 12,
    }
    expect(requiredOutcomeAfterRetry(first, true)).toBe("failed")
    expect(preserveFirstFailure(first, { passed: true, fingerprint: "abc" }).required).toBe(
      "failed",
    )
  })

  test("chunk 16 is not eligible for quarantine", () => {
    expect(mayQuarantine("tests/unit/bench-full-remote-hellgate.test.ts")).toBe(false)
  })
})

describe("nightly membership", () => {
  test("keeps the existing schedule inventory and cache-off", () => {
    expect(NIGHTLY_SCHEDULES.map((row) => row.file)).toEqual([
      "verification-nightly.yml",
      "ci.yml",
      "agent-nightly-regression.yml",
      "grounding-live-gate.yml",
    ])
    expect(NIGHTLY_MEMBERSHIP.cacheMode).toBe("off")
    expect(NIGHTLY_MEMBERSHIP.excludesPaidEvalMove).toBe(true)
  })

  test("includes only lanes the nightly workflow and script actually run", async () => {
    const repo = join(import.meta.dir, "../../..")
    const pkg = JSON.parse(await Bun.file(join(repo, "package.json")).text()) as {
      readonly scripts?: Record<string, string>
    }
    const nightlyScript = pkg.scripts?.["verify:nightly"] ?? ""
    const workflow = await Bun.file(join(repo, ".github/workflows/verification-nightly.yml")).text()
    const laneWired = (lane: string): boolean => {
      if (lane !== "cache-off-full-suite") return false
      return (
        nightlyScript.includes("QUANTA_TEST_CACHE=off") &&
        nightlyScript.includes("gate.ts nightly") &&
        workflow.includes("bun run verify:nightly")
      )
    }
    expect(NIGHTLY_MEMBERSHIP.includes.length).toBeGreaterThan(0)
    for (const lane of NIGHTLY_MEMBERSHIP.includes) {
      expect(laneWired(lane)).toBe(true)
    }
    expect(laneWired("exhaustive-fuzz")).toBe(false)
    expect(nightlyScript).not.toContain("exhaustive-fuzz")
    expect(workflow).not.toContain("exhaustive-fuzz")
  })
})
