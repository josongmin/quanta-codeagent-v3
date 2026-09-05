/**
 * SECURITY DRY HELLGATE — both redactors consume the shared fabricated corpus.
 */
import { describe, expect, test } from "bun:test"
import { redactSecrets } from "@/security"
import { redactValue } from "@/shared"
import { HIGH_VALUE_SECRET_SHAPES } from "../_support/secret-shape-corpus"

const scrubbedByTrajectory = (s: string): boolean => redactValue(s) !== s
const scrubbedBySecurity = (s: string): boolean =>
  redactSecrets(s, { origin: "tool_result" }).text !== s

describe("redaction parity — BOTH scrubbers redact every high-value secret shape", () => {
  test("corpus floor", () => {
    expect(HIGH_VALUE_SECRET_SHAPES.length).toBeGreaterThanOrEqual(17)
  })
  for (const row of HIGH_VALUE_SECRET_SHAPES) {
    test(`${row.label}: redactValue (trajectory) scrubs it`, () => {
      expect(scrubbedByTrajectory(row.sample)).toBe(true)
    })
    test(`${row.label}: redactSecrets (security) scrubs it`, () => {
      expect(scrubbedBySecurity(row.sample)).toBe(true)
    })
  }

  test("a benign string is NOT scrubbed by either (no over-redaction)", () => {
    const benign = "the quick brown fox ran 42 tests successfully"
    expect(scrubbedByTrajectory(benign)).toBe(false)
    expect(scrubbedBySecurity(benign)).toBe(false)
  })
})
