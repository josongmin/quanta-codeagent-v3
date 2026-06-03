// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these tests embed literal `${...}` inside plain strings ON PURPOSE — it is the parser INPUT (source text containing a template dynamic import), not an unintended template literal.
/**
 * Hellgate — reachability symbol PARSER (regression pins for the 3-round
 * self-audit). The `fc reachability` verdict is only as trustworthy as the
 * import/export extraction underneath it; two false-positive (over-flag) bugs
 * were found by self-audit and fixed. These tests freeze the fix so a future
 * regex refactor can't silently regress the parser back into mis-flagging
 * wired features as dead/unreachable.
 *
 *   PARSE-01  named / type / aliased imports recorded with ORIGINAL name
 *   PARSE-02  R1 BUG: `export type { X } from "y"` IS a re-export (was missed)
 *   PARSE-03  export *, export * as, plain re-export, default — all captured
 *   PARSE-04  wildcard uses (namespace / side-effect / dynamic-literal / default)
 *   PARSE-05  own declared exports incl. `export type`/`interface`/`enum`
 *   PARSE-06  R2 BUG: template dynamic import prefix extracted (was missed)
 *   PARSE-07  self-registration (top-level call) detected → never flagged dead
 */

import { describe, expect, test } from "bun:test"
import { parseSymbols, templatePrefixes } from "../../tools/feature-catalog/reachability"

describe("reachability parser — import/export extraction", () => {
  test("PARSE-01: named + type-inline + aliased imports keep the original name", () => {
    const p = parseSymbols(
      `import { foo, bar as baz } from "@/x"
       import { type Ty, qux } from "./y"
       import type { OnlyTy } from "./z"`,
    )
    const names = p.namedImports.map((n) => `${n.name}@${n.spec}`)
    expect(names).toContain("foo@@/x")
    expect(names).toContain("bar@@/x") // original name, not alias
    expect(names).toContain("qux@./y")
    expect(names).toContain("Ty@./y") // inline `type` stripped
    expect(names).toContain("OnlyTy@./z") // `import type {}`
  })

  test("PARSE-02 (R1 regression): `export type { X } from` is a re-export", () => {
    const p = parseSymbols(`export type { GitBudget } from "./_budget"`)
    const rx = p.reexports.find((r) => r.exposed === "GitBudget")
    expect(rx).toBeDefined()
    expect(rx?.srcName).toBe("GitBudget")
    expect(rx?.spec).toBe("./_budget")
  })

  test("PARSE-03: star / star-as / value re-export / default", () => {
    const p = parseSymbols(
      `export * from "./a"
       export * as ns from "./b"
       export { x, y as z } from "./c"
       export default thing`,
    )
    expect(p.starSpecs).toContain("./a")
    expect(p.ownExports.has("ns")).toBe(true) // star-as creates a local name
    expect(p.wildcardSpecs).toContain("./b") // …sourced wholesale from b
    expect(p.reexports.some((r) => r.srcName === "y" && r.exposed === "z")).toBe(true)
    expect(p.ownExports.has("default")).toBe(true)
  })

  test("PARSE-04: namespace / side-effect / dynamic-literal / default → whole-module", () => {
    const p = parseSymbols(
      `import * as ns from "./ns"
       import "./sideeffect"
       import def from "./def"
       const m = await import("./dyn")`,
    )
    expect(p.wildcardSpecs).toEqual(
      expect.arrayContaining(["./ns", "./sideeffect", "./def", "./dyn"]),
    )
  })

  test("PARSE-05: own declared exports (const/function/type/interface/enum)", () => {
    const p = parseSymbols(
      `export const a = 1
       export function b() {}
       export async function c() {}
       export class D {}
       export type E = number
       export interface F {}
       export enum G { x }`,
    )
    for (const n of ["a", "b", "c", "D", "E", "F", "G"]) expect(p.ownExports.has(n)).toBe(true)
  })

  test("PARSE-06 (R2 regression): template dynamic-import prefix extracted", () => {
    expect(templatePrefixes("const m = await import(`./mode-presets/${mode}`)")).toEqual([
      "./mode-presets",
    ])
    expect(templatePrefixes('import("./static")')).toEqual([]) // literal → not a template
    expect(templatePrefixes("await import(`@/plugins/${name}/entry`)")).toEqual(["@/plugins"])
  })

  test("PARSE-07: top-level call (self-registration) sets hasSideEffect", () => {
    expect(parseSymbols(`registerTool(myTool)`).hasSideEffect).toBe(true)
    expect(parseSymbols(`export const x = 1\nexport function f() {}`).hasSideEffect).toBe(false)
  })
})
