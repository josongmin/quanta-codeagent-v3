/**
 * The per-test lens — pinned where it is cheap to pin.
 *
 * `tools/dev/empty-mirror-check.ts` judges a FILE: it runs `bun test <file>` and
 * reads one verdict. That is enough for a guard whose every test consumes the
 * corpus, and blind whenever one test in the file throws on a blanked tree while
 * another passes over an empty listing — the file reads RED and the vacuous test
 * inside it is invisible. Measured: `cross-slice-cycle` hid TWO that way, and
 * `manifest-codex-compat` hid one more behind a `catch { continue }`.
 *
 * The sweep itself is not run here. It builds two mirrors per file and spawns
 * one `bun test` per scanning test, which is minutes of wall clock — the CLI
 * form (`bun run tools/dev/per-test-vacuity.ts <cases.json>`) is where that
 * lives. What is pinned here is the part a regression would silently break: the
 * comparison rule, and the extraction that decides which tests the rule is
 * applied to.
 */

import { describe, expect, test } from "bun:test"
import { isVacuous, namesOf, SCAN } from "@/../tools/dev/per-test-vacuity"

describe("per-test vacuity — the comparison rule", () => {
  test("🔴 asserting LESS over a blanked tree while passing is the finding", () => {
    // The live shape: 68 `expect()` calls against the real corpus, ZERO against
    // the blanked one, green both times.
    expect(isVacuous({ verdict: "green", calls: 0 }, { verdict: "green", calls: 68 })).toBe(true)
  })

  test("equal counts are NOT a finding — the test never touched the corpus", () => {
    // This is the overwhelming majority and the reason the rule is a comparison
    // rather than "it passed on a blank tree": over the whole population 378
    // tests passed the blanked arm and 377 asserted identically in both.
    expect(isVacuous({ verdict: "green", calls: 4 }, { verdict: "green", calls: 4 })).toBe(false)
  })

  test("a red or crashed arm is never a finding", () => {
    // A guard that goes red, or that throws because its corpus is missing, is
    // refusing to report over nothing. Counting either as vacuous would invert
    // the verdict on the guards that behave correctly.
    expect(isVacuous({ verdict: "red", calls: 0 }, { verdict: "green", calls: 9 })).toBe(false)
    expect(isVacuous({ verdict: "infra", calls: 0 }, { verdict: "green", calls: 9 })).toBe(false)
    // And a control arm that did not itself pass makes the comparison meaningless.
    expect(isVacuous({ verdict: "green", calls: 0 }, { verdict: "infra", calls: 0 })).toBe(false)
  })

  test("more calls on the blanked arm is not a finding either", () => {
    expect(isVacuous({ verdict: "green", calls: 9 }, { verdict: "green", calls: 4 })).toBe(false)
  })
})

describe("per-test vacuity — which tests the rule is applied to", () => {
  const fsCall = `read${"dir"}Sync`

  test("🔴 the module preamble travels with each test", () => {
    // A scan at module scope is consumed by every test in the file, so a lens
    // that only looked at the test body would exclude the whole file. That is
    // how the two `cross-slice-cycle` bans would have been missed: their
    // directory constant is declared at module scope.
    const src =
      `import { ${fsCall} } from "node:fs"\n` +
      `const all = ${fsCall}("some-dir")\n` +
      `test("uses the module scan", () => { expect(all).toEqual([]) })\n`
    const [only] = namesOf(src)
    expect(only?.name).toBe("uses the module scan")
    expect(SCAN.test(only?.body ?? "")).toBe(true)
  })

  test("each test gets its OWN body, not the next one's", () => {
    const src =
      `test("first", () => { expect(1).toBe(1) })\n` +
      `test("second", () => { const x = ${fsCall}("d"); expect(x).toEqual([]) })\n`
    const got = namesOf(src)
    expect(got.map((t) => t.name)).toEqual(["first", "second"])
    // Without per-test slicing every test in a file inherits every scan, and the
    // lens would run each one for nothing.
    expect(SCAN.test(got[0]?.body ?? "")).toBe(false)
    expect(SCAN.test(got[1]?.body ?? "")).toBe(true)
  })

  test("🔴 a name inside a BLOCK comment does not become a test", () => {
    // A line comment is already excluded by the anchor — `^\s*` cannot consume
    // `//` — so a `// test(…)` fixture pins nothing and a mutation that deletes
    // the comment stripper survives it. The shape that actually needs stripping
    // is a commented-out test sitting at column 0 inside a block, which this
    // repo has: it would be dispatched to `bun test -t`, match nothing, and be
    // reported as no-tests.
    const src = `/*\ntest("commented out", () => {})\n*/\ntest("real", () => { expect(1).toBe(1) })\n`
    expect(namesOf(src).map((t) => t.name)).toEqual(["real"])
  })

  test("test.each / it.only variants are still extracted", () => {
    const src = `test.only("only one", () => {})\nit.skip("skipped", () => {})\n`
    expect(namesOf(src).map((t) => t.name)).toEqual(["only one", "skipped"])
  })
})
