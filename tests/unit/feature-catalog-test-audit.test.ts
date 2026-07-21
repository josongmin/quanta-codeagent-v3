// test-audit meta: synthetic declarations below exercise the scanner itself.
import { describe, expect, test } from "bun:test"
import {
  compareTestAuditBaseline,
  runAllRules,
  snapshotTestAuditBaseline,
} from "../../tools/feature-catalog/test-audit"

const reportFor = (text: string) =>
  runAllRules({ ts: [{ path: "tests/unit/x.test.ts", text }], js: [] })

describe("test-audit baseline", () => {
  test("the explicit meta marker excludes scanner fixtures from all static rules", () => {
    expect(
      reportFor('// test-audit meta\ntest("cleanup abort env", () => {})').totalViolations,
    ).toBe(0)
  })

  test("a baseline accepts exactly its recorded violations", () => {
    const report = reportFor('test("cleanup", () => expect(true).toBe(true))')
    const baseline = snapshotTestAuditBaseline(report)
    expect(compareTestAuditBaseline(report, baseline)).toEqual({
      newViolations: [],
      resolvedViolations: [],
    })
  })

  test("a new violation is strict-visible while a removed one asks to tighten", () => {
    const prior = reportFor('test("cleanup", () => expect(true).toBe(true))')
    const baseline = snapshotTestAuditBaseline(prior)
    const current = reportFor(
      'test("cleanup", () => expect(true).toBe(true))\ntest("abort", () => expect(true).toBe(true))',
    )
    const comparison = compareTestAuditBaseline(current, baseline)
    expect(comparison.newViolations).toHaveLength(1)
    expect(comparison.newViolations[0]).toContain("R9")

    const resolved = compareTestAuditBaseline(reportFor('import x from "@/x"'), baseline)
    expect(resolved.newViolations).toHaveLength(0)
    expect(resolved.resolvedViolations).toHaveLength(2)
  })
})
