import { describe, expect, test } from "bun:test"
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
})
