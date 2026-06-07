/**
 * Hellgate — agent-requested rules matcher (gap-other-agent GAP 6).
 *
 * Cursor's 4th rule type (`AgentFetched`): description-only rules the LLM summons
 * on demand via `fetch_rules`. quanta DROPS description-only rules at load
 * (glob-rules.ts:97-116) — they can never auto-inject. This is the essential pure
 * matcher that lets an `fetch_rules` tool rank those rules by a query.
 *
 * Deterministic (no arbitrary fuzzy threshold): score = count of distinct,
 * non-stopword query tokens present in the rule's name+description; return rules
 * with score > 0, ranked by score desc then name (stable), capped at `limit`.
 *
 * Invariants:
 *   1. Real token overlap ⇒ match; ranked by overlap count.
 *   2. No overlap / all-stopword query ⇒ [] (no spurious matches).
 *   3. Stable tie-break by name; `limit` respected.
 *   4. NO-THROW on empty inputs.
 */
import { describe, expect, test } from "bun:test"
import { matchRulesByDescription } from "@/agent/agent-requested-rules"
import type { RequestableRule } from "@/agent/agent-requested-rules"

const rule = (name: string, description: string): RequestableRule => ({ name, description, body: "…" })
const rules: readonly RequestableRule[] = [
  rule("ts-style", "TypeScript code style and naming conventions"),
  rule("py-style", "Python formatting and lint rules"),
  rule("commit", "Git commit message format and conventions"),
  rule("ts-test", "TypeScript testing conventions with bun"),
]
const names = (rs: readonly RequestableRule[]) => rs.map((r) => r.name)

describe("matchRulesByDescription — overlap + ranking", () => {
  test("query matches by token overlap, ranked", () => {
    const got = names(matchRulesByDescription("typescript conventions", rules))
    expect(got[0]).toBe("ts-style") // 2 overlaps (typescript, conventions)
    expect(got).toContain("ts-test") // 1 overlap (typescript)
    expect(got).not.toContain("py-style") // 0 overlap
  })
  test("single-token query", () => {
    expect(names(matchRulesByDescription("commit", rules))).toEqual(["commit"])
  })
})

describe("matchRulesByDescription — no spurious matches", () => {
  test("all-stopword / empty query ⇒ []", () => {
    expect(matchRulesByDescription("how to use the", rules)).toEqual([])
    expect(matchRulesByDescription("", rules)).toEqual([])
    expect(matchRulesByDescription("   ", rules)).toEqual([])
  })
  test("zero-overlap query ⇒ []", () => {
    expect(matchRulesByDescription("kubernetes docker", rules)).toEqual([])
  })
})

describe("matchRulesByDescription — determinism + limit", () => {
  test("equal-score ties break by name (stable)", () => {
    // "conventions" hits ts-style, commit, ts-test (1 each) → name order.
    const got = names(matchRulesByDescription("conventions", rules))
    expect(got).toEqual(["commit", "ts-style", "ts-test"])
  })
  test("limit caps the result count", () => {
    expect(matchRulesByDescription("conventions", rules, 2)).toHaveLength(2)
  })
  test("empty rule set ⇒ [] (no throw)", () => {
    expect(matchRulesByDescription("anything", [])).toEqual([])
  })
})
