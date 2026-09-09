import { describe, expect, test } from "bun:test"
import {
  aggregateRequiredNeeds,
  requiredCheckOutcome,
} from "../../../tools/dev/verification-required-results"
import type { VerificationOutcome } from "../../../tools/dev/verification-result"

describe("required check truth table", () => {
  test("unexpected skip fails", () => {
    expect(requiredCheckOutcome({ github: "skipped", policy: "passed" })).toBe("fail")
    expect(requiredCheckOutcome({ github: "cancelled", policy: "passed" })).toBe("fail")
  })

  test("policy not-selected accepts skipped or success", () => {
    expect(requiredCheckOutcome({ github: "skipped", policy: "not-selected" })).toBe("pass")
    expect(requiredCheckOutcome({ github: "success", policy: "not-selected" })).toBe("pass")
    expect(requiredCheckOutcome({ github: "failure", policy: "not-selected" })).toBe("fail")
  })

  test("github success still fails when policy is failed", () => {
    const failed: VerificationOutcome = "failed"
    expect(requiredCheckOutcome({ github: "success", policy: failed })).toBe("fail")
  })

  test("empty needs or a skipped required job fail closed", () => {
    expect(aggregateRequiredNeeds({})).toBe("fail")
    expect(
      aggregateRequiredNeeds({
        "static-code": { result: "success" },
        contract: { result: "skipped" },
      }),
    ).toBe("fail")
    expect(
      aggregateRequiredNeeds({
        "static-code": { result: "success" },
        catalog: { result: "success" },
      }),
    ).toBe("pass")
  })
})
