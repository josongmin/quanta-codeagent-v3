/**
 * TEST-QUALITY RATCHET (jun-08 test-suite audit forcing function).
 *
 * Two classes of "test-for-test-sake" smell are frozen here as DECREASING
 * CEILINGS (same burn-down idiom as the no-raw-env / gate-vocab ratchets): the
 * count may only DECREASE; a NEW instance trips the ceiling.
 *
 *   A) `expect(true).toBe(true)` — an always-green terminator. The remaining
 *      ones are genuine NO-THROW contracts (real code runs above; a throw fails
 *      the test). They are weak, not wrong, so the ceiling is the current count
 *      rather than 0. PREFER strengthening to an observable assertion
 *      (`expect(() => action()).not.toThrow()`, a handler count, an empty
 *      offenders array) over adding a new terminator. Pure documentation/
 *      "design-pin"/"tombstone" placeholders were deleted in the audit — do not
 *      reintroduce them; a `NOTE:` comment carries the same intent with no
 *      always-green test.
 *
 *   B) SOURCE-LOC BUDGET asserts — `expect(linesOf(file)).toBeLessThan(N)`.
 *      These churn on every legit one-line composition add (the `300→334`
 *      bump history) and never catch a bug. The structural intent ("host stays
 *      declarative / slim") is enforced by import-fence + no-let + one-factory-
 *      export guards instead. Ceiling is 0: do not add a new source-line-count
 *      budget. (Line-WIDTH bounds like `ln.length < 80` and output-tail caps
 *      like `out.length <= 4000` are behavioral and are NOT matched here.)
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

const ROOTS = ["tests", "src"]

/** This ratchet file embeds the offending patterns inside matcher self-tests;
 *  exclude it so it never counts itself. */
const SELF = "test-quality-ratchet-hellgate.test.ts"

const isComment = (l: string): boolean => {
  const t = l.trimStart()
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")
}

function* walkTests(dir: string): Generator<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === "__snapshots__") continue
      yield* walkTests(p)
    } else if (entry.endsWith(".test.ts") && entry !== SELF) {
      yield p
    }
  }
}

// ── A. always-green `expect(true).toBe(true)` terminators ────────────────────
const TRUE_TERMINATOR = /expect\(\s*true\s*\)\s*\.\s*toBe\(\s*true\s*\)/g

// ── B. source-line-count budget: `expect(<loc-ish var>).toBeLessThan(N)` in a
//    file that derives a line count via `.split("\n").length`. ───────────────
const LOC_ASSERT = /expect\(\s*\w*(?:loc|lines|lineCount|locCount|sloc)\w*\s*\)\s*\.\s*toBeLessThan(?:OrEqual)?\(/i
const LINE_COUNT_DERIVE = /\.split\(\s*["'`]\\n["'`]\s*\)\s*\.length/
const LOC_ASSERT_INLINE = /\.split\(\s*["'`]\\n["'`]\s*\)\s*\.length\s*\)?\s*\.\s*toBeLessThan(?:OrEqual)?\(/

const scan = (): {
  trueTerminators: { total: number; byFile: Record<string, number> }
  locBudgets: { total: number; byFile: Record<string, number> }
} => {
  const tt: Record<string, number> = {}
  const loc: Record<string, number> = {}
  for (const root of ROOTS) {
    for (const file of walkTests(root)) {
      const text = readFileSync(file, "utf8")
      const fileHasLineCount = LINE_COUNT_DERIVE.test(text)
      let ttN = 0
      let locN = 0
      for (const line of text.split("\n")) {
        if (isComment(line)) continue
        const m = line.match(TRUE_TERMINATOR)
        if (m) ttN += m.length
        if (LOC_ASSERT_INLINE.test(line)) locN += 1
        else if (fileHasLineCount && LOC_ASSERT.test(line)) locN += 1
      }
      const key = file.replace(/\\/g, "/")
      if (ttN > 0) tt[key] = ttN
      if (locN > 0) loc[key] = locN
    }
  }
  const sum = (r: Record<string, number>): number => Object.values(r).reduce((a, b) => a + b, 0)
  return {
    trueTerminators: { total: sum(tt), byFile: tt },
    locBudgets: { total: sum(loc), byFile: loc },
  }
}

const offenderList = (byFile: Record<string, number>): string =>
  Object.entries(byFile)
    .sort((a, b) => b[1] - a[1])
    .map(([f, n]) => `  ${f}: ${n}`)
    .join("\n")

// Baseline high-water marks (jun-08 audit). May ONLY decrease.
const TRUE_TERMINATOR_CEILING = 12
const LOC_BUDGET_CEILING = 0

describe("test-quality ratchet (jun-08 audit)", () => {
  test(`A: expect(true).toBe(true) terminators stay <= ${TRUE_TERMINATOR_CEILING} (burn-down)`, () => {
    const { trueTerminators } = scan()
    if (trueTerminators.total > TRUE_TERMINATOR_CEILING) {
      throw new Error(
        `\`expect(true).toBe(true)\` terminators rose to ${trueTerminators.total} ` +
          `(ceiling ${TRUE_TERMINATOR_CEILING}). Strengthen to an observable assertion ` +
          `(not.toThrow / a count / an empty offenders array) instead of adding an ` +
          `always-green terminator. Offenders:\n${offenderList(trueTerminators.byFile)}`,
      )
    }
    expect(trueTerminators.total).toBeLessThanOrEqual(TRUE_TERMINATOR_CEILING)
  })

  test(`B: source-LOC-count budget asserts stay <= ${LOC_BUDGET_CEILING} (forbidden)`, () => {
    const { locBudgets } = scan()
    if (locBudgets.total > LOC_BUDGET_CEILING) {
      throw new Error(
        `Source-line-count budget asserts rose to ${locBudgets.total} (ceiling ${LOC_BUDGET_CEILING}). ` +
          `A \`toBeLessThan(N)\` on a file's line count churns on every legit edit and ` +
          `catches no bug — enforce structure with import-fence / no-let / one-export ` +
          `guards instead. Offenders:\n${offenderList(locBudgets.byFile)}`,
      )
    }
    expect(locBudgets.total).toBeLessThanOrEqual(LOC_BUDGET_CEILING)
  })

  test("matchers catch the smell but not behavioral length bounds", () => {
    // A: terminator forms
    expect("expect(true).toBe(true)".match(TRUE_TERMINATOR)?.length).toBe(1)
    expect("expect( true ).toBe( true )".match(TRUE_TERMINATOR)?.length).toBe(1)
    // B: source-LOC inline + the loc-var form is gated on a line-count derive
    expect(LOC_ASSERT_INLINE.test('expect(src.split("\\n").length).toBeLessThan(200)')).toBe(true)
    expect(LOC_ASSERT.test("expect(loc).toBeLessThan(200)")).toBe(true)
    expect(LOC_ASSERT.test("expect(lines).toBeLessThanOrEqual(65)")).toBe(true)
    // Behavioral length bounds must NOT be matched as LOC budgets:
    expect(LOC_ASSERT.test("expect(ln.length).toBeLessThan(80)")).toBe(false)
    expect(LOC_ASSERT.test("expect(out.length).toBeLessThanOrEqual(4000)")).toBe(false)
  })
})
