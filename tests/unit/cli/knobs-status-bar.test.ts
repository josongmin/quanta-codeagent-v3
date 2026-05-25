/**
 * `renderKnobStatusBar` — formatter contract:
 *   - 0 active ⇒ ""
 *   - 1..3 active ⇒ `[knobs: <comma-list>]` with per-value formatting:
 *       boolean true / string "on" ⇒ bare id
 *       number                     ⇒ `id:value`
 *       otherwise                  ⇒ `id=value`
 *   - 4+ active ⇒ `[knobs: N active]`
 *
 * The iteration order matches the input map's iteration order — we exercise
 * that by populating the source `Map` in a known order.
 */
import { describe, expect, test } from "bun:test"
import type { KnobValue, KnobValueMap } from "@/runner/knobs"
import { renderKnobStatusBar } from "../../../src/apps/cli/knobs-status-bar"

const mk = (
  pairs: ReadonlyArray<readonly [string, unknown]>,
  source: KnobValue<unknown>["source"] = "env",
): KnobValueMap => {
  const m = new Map<string, KnobValue<unknown>>()
  for (const [id, value] of pairs) m.set(id, { value, source })
  return m
}

describe("renderKnobStatusBar — empty / count branches", () => {
  test("0 active ⇒ empty string", () => {
    expect(renderKnobStatusBar(mk([]))).toBe("")
  })

  test("1 boolean true ⇒ bare id", () => {
    expect(renderKnobStatusBar(mk([["skills", true]]))).toBe("[knobs: skills]")
  })

  test("1 string 'on' ⇒ bare id (treated identically to true)", () => {
    expect(renderKnobStatusBar(mk([["closeout-guard", "on"]]))).toBe("[knobs: closeout-guard]")
  })

  test("1 number ⇒ id:value", () => {
    expect(renderKnobStatusBar(mk([["branch-search", 3]]))).toBe("[knobs: branch-search:3]")
  })

  test("1 string ⇒ id=value", () => {
    expect(renderKnobStatusBar(mk([["persona", "pragmatic"]]))).toBe("[knobs: persona=pragmatic]")
  })
})

describe("renderKnobStatusBar — mixed small-list (2..3) branch", () => {
  test("2 mixed ⇒ +-joined", () => {
    expect(
      renderKnobStatusBar(
        mk([
          ["persona", "pragmatic"],
          ["working-state", true],
        ]),
      ),
    ).toBe("[knobs: persona=pragmatic + working-state]")
  })

  test("3 mixed ⇒ +-joined", () => {
    expect(
      renderKnobStatusBar(
        mk([
          ["skills", true],
          ["persona", "friendly"],
          ["branch-search", 5],
        ]),
      ),
    ).toBe("[knobs: skills + persona=friendly + branch-search:5]")
  })

  test("iteration order is preserved (insertion order of source Map)", () => {
    expect(
      renderKnobStatusBar(
        mk([
          ["c", "x"],
          ["a", "x"],
          ["b", "x"],
        ]),
      ),
    ).toBe("[knobs: c=x + a=x + b=x]")
  })
})

describe("renderKnobStatusBar — 4+ count branch", () => {
  test("4 active ⇒ count summary", () => {
    expect(
      renderKnobStatusBar(
        mk([
          ["a", true],
          ["b", true],
          ["c", true],
          ["d", true],
        ]),
      ),
    ).toBe("[knobs: 4 active]")
  })

  test("12 active ⇒ count summary", () => {
    const pairs: Array<readonly [string, unknown]> = []
    for (let i = 0; i < 12; i++) pairs.push([`k${i}`, true])
    expect(renderKnobStatusBar(mk(pairs))).toBe("[knobs: 12 active]")
  })
})

describe("renderKnobStatusBar — value-type edge cases (in small-list mode)", () => {
  test("boolean false ⇒ id=false (NOT bare — only true/'on' shorten)", () => {
    expect(renderKnobStatusBar(mk([["hooks", false]]))).toBe("[knobs: hooks=false]")
  })

  test("null ⇒ id=null (String(null))", () => {
    expect(renderKnobStatusBar(mk([["x", null]]))).toBe("[knobs: x=null]")
  })

  test("number 0 ⇒ id:0 (number branch wins over falsy check)", () => {
    expect(renderKnobStatusBar(mk([["repro-test", 0]]))).toBe("[knobs: repro-test:0]")
  })
})
