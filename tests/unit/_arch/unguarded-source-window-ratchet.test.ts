/**
 * RATCHET — `x.slice(a, y.indexOf(lit))` over source text has no failure mode.
 *
 * `String.prototype.slice` reads a negative end as an offset from the END of the
 * string, so a missing end anchor yields `-1` and the window silently widens to
 * almost the whole file instead of erroring. Every assertion over that window then
 * passes for the wrong reason. A missing START anchor is harmless by comparison: it
 * gives an empty window, which fails loudly. Only the end is dangerous, which is why
 * the shape survives review.
 *
 * Measured, three times, each a constructed false PASS:
 *
 *  - `b3456-feature-seams-hellgate` sliced between `'"gh_pr_view"'` and
 *    `"lsp_diagnostics"`. The `lsp_diagnostics` ROW had been deleted and the token
 *    survived only in a two-line obituary comment. Deleting that comment — routine
 *    tidying — moved the window from 818 bytes to 50,903, and then stripping the
 *    exact documentation the guard exists to pin left it at 11 pass / 0 fail.
 *  - `process-lifecycle-kill-bounds` sliced to `"releaseLease:"`. `quarantineLane({`
 *    occurs twice in the target, so a widened window is satisfied by the unrelated
 *    occurrence: the survivor hook could stop quarantining the lane and stay green.
 *  - `web-goal-command-wiring-hellgate` sliced to `"})"` — two generic characters.
 *    False PASS and false RED both: unwiring `readGoal` while leaving the identifier
 *    in a comment stayed green, and adding one benign line containing `})` before
 *    the key turned it red with the wiring untouched.
 *
 * `tests/unit/_shared/slice-between.ts` throws when either anchor is missing, naming
 * which one. This ratchet caps the remaining raw sites so the class can only shrink.
 *
 * NOT a blanket ban: some raw sites parse RUNTIME data (a DAP wire frame, a path
 * segment) where a missing separator is itself the failure the test is asserting
 * about. The ceiling lets those stay while forbidding new source-window sites.
 */
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/**
 * Current raw-site high-water mark. May ONLY decrease, as sites migrate to
 * `sliceBetween`. Raising it re-opens a class with three proven false passes.
 */
const RAW_SLICE_CEILING = 18

interface RawSite {
  readonly file: string
  readonly line: number
  readonly text: string
}

/** Two-arg `.slice(a, b)` whose END argument contains an `.indexOf(...)` call. */
export const rawSourceWindows = (repoRoot: string, files: readonly string[]): RawSite[] => {
  const out: RawSite[] = []
  for (const rel of files) {
    const text = readFileSync(join(repoRoot, rel), "utf8")
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "slice" &&
        n.arguments.length === 2
      ) {
        const end = n.arguments[1] as ts.Expression
        let hasIndexOf = false
        const scan = (x: ts.Node): void => {
          if (
            ts.isCallExpression(x) &&
            ts.isPropertyAccessExpression(x.expression) &&
            x.expression.name.text === "indexOf"
          ) {
            hasIndexOf = true
          }
          ts.forEachChild(x, scan)
        }
        scan(end)
        if (hasIndexOf) {
          out.push({
            file: rel,
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
            text: n.getText(sf).replace(/\s+/g, " ").slice(0, 100),
          })
        }
      }
      ts.forEachChild(n, visit)
    }
    ts.forEachChild(sf, visit)
  }
  return out
}

const testFiles = (): string[] =>
  execFileSync("git", ["ls-files", "--", "tests"], { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.tsx?$/.test(f))
    // the helper's own test demonstrates the raw idiom on purpose, side by side
    .filter((f) => f !== "tests/unit/_shared/slice-between.test.ts")

describe("unguarded source-window ratchet", () => {
  test("ANTI-VACUITY: the census reaches a real corpus and the detector works", () => {
    const files = testFiles()
    expect(files.length, "no test files scanned — the ceiling would be free").toBeGreaterThan(2000)
    // The detector must SEE the shape and must not see the safe forms.
    const probe = (src: string): number => {
      const p = "/tmp/__probe.ts"
      const sf = ts.createSourceFile(p, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)
      let n = 0
      const visit = (x: ts.Node): void => {
        if (
          ts.isCallExpression(x) &&
          ts.isPropertyAccessExpression(x.expression) &&
          x.expression.name.text === "slice" &&
          x.arguments.length === 2
        ) {
          let found = false
          const scan = (y: ts.Node): void => {
            if (
              ts.isCallExpression(y) &&
              ts.isPropertyAccessExpression(y.expression) &&
              y.expression.name.text === "indexOf"
            ) {
              found = true
            }
            ts.forEachChild(y, scan)
          }
          scan(x.arguments[1] as ts.Expression)
          if (found) n += 1
        }
        ts.forEachChild(x, visit)
      }
      ts.forEachChild(sf, visit)
      return n
    }
    expect(probe('s.slice(s.indexOf("a"), s.indexOf("b"))')).toBe(1)
    expect(probe('s.slice(0, s.indexOf("b"))')).toBe(1)
    // safe forms the detector must NOT count
    expect(probe('s.slice(s.indexOf("a"))')).toBe(0)
    expect(probe("s.slice(0, 10)")).toBe(0)
    expect(probe('sliceBetween(s, "a", "b")')).toBe(0)
  })

  test(`raw source windows stay <= ${RAW_SLICE_CEILING} (burn-down only)`, () => {
    const sites = rawSourceWindows(REPO_ROOT, testFiles())
    // biome-ignore lint/suspicious/noConsole: ratchet visibility for reviewers
    console.log(`[raw-source-window] ${sites.length}/${RAW_SLICE_CEILING} unguarded sites`)
    if (sites.length > RAW_SLICE_CEILING) {
      const list = sites.map((s) => `  ${s.file}:${s.line}  ${s.text}`).join("\n")
      throw new Error(
        `${sites.length} unguarded source-window slices (ceiling ${RAW_SLICE_CEILING}). ` +
          `A missing end anchor reads -1 as an offset from the end of the string and widens ` +
          `the window to the rest of the file, so the assertion passes for the wrong reason. ` +
          `Use \`sliceBetween\` from tests/unit/_shared/slice-between.ts:\n${list}`,
      )
    }
    expect(sites.length).toBeLessThanOrEqual(RAW_SLICE_CEILING)
  })

  test("the three migrated sites are not in the census any more", () => {
    const byFile = new Set(rawSourceWindows(REPO_ROOT, testFiles()).map((s) => s.file))
    for (const f of [
      "tests/unit/b3456-feature-seams-hellgate.test.ts",
      "tests/unit/web-goal-command-wiring-hellgate.test.ts",
      "tests/unit/dev/process-lifecycle-kill-bounds.test.ts",
    ]) {
      expect(byFile.has(f), `${f} regressed to a raw source window`).toBe(false)
    }
  })
})
