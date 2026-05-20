import { describe, expect, test } from "bun:test"
import { HARD_DENY_RULES } from "@/permission/policy"

/**
 * Rule-level enforcement for the HARD_DENY catalog. CR3 follow-up: each rule
 * carries its own `mustBlock` / `mustAllow` cases so adding the 12th rule
 * (or modifying any existing one) fails closed unless the author also writes
 * the positive AND negative cases. End-to-end behavior on `hardDeny(action)`
 * stays covered by `tests/unit/permission-hardening.test.ts`.
 */

describe("HARD_DENY rule catalog — structural invariants", () => {
  test("at least 11 rules exist (CR3 baseline)", () => {
    expect(HARD_DENY_RULES.length).toBeGreaterThanOrEqual(11)
  })

  test("rule names are unique", () => {
    const names = HARD_DENY_RULES.map((r) => r.name)
    const unique = new Set(names)
    expect(unique.size).toBe(names.length)
  })

  test("rule names are non-empty kebab-case identifiers", () => {
    for (const r of HARD_DENY_RULES) {
      expect(r.name.length).toBeGreaterThan(0)
      // kebab-case: lowercase letters/digits with single-dash separators.
      expect(r.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
  })

  test("each rule has a one-line description", () => {
    for (const r of HARD_DENY_RULES) {
      expect(r.description.length).toBeGreaterThan(0)
      expect(r.description.includes("\n")).toBe(false)
    }
  })

  test("each rule declares at least one mustBlock and one mustAllow case", () => {
    for (const r of HARD_DENY_RULES) {
      expect(r.mustBlock.length).toBeGreaterThanOrEqual(1)
      expect(r.mustAllow.length).toBeGreaterThanOrEqual(1)
    }
  })
})

describe("HARD_DENY rule catalog — mustBlock positives fire", () => {
  for (const rule of HARD_DENY_RULES) {
    for (const cmd of rule.mustBlock) {
      test(`[${rule.name}] blocks: ${cmd}`, () => {
        expect(rule.pattern.test(cmd)).toBe(true)
      })
    }
  }
})

describe("HARD_DENY rule catalog — mustAllow negatives stay clean", () => {
  for (const rule of HARD_DENY_RULES) {
    for (const cmd of rule.mustAllow) {
      test(`[${rule.name}] does NOT match: ${cmd}`, () => {
        expect(rule.pattern.test(cmd)).toBe(false)
      })
    }
  }
})
