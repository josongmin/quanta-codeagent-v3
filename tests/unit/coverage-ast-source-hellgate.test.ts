/**
 * Hellgate — AST-precise coverage source (ADR-0167).
 *
 * Seals:
 *   A. Branch types         (HELL-1..11) — 11 cases
 *   B. False-positive immunity (HELL-12..16) — 5 cases
 *   C. Nested + composite   (HELL-17..19) — 3 cases
 *   D. CoverageSource port parity (HELL-20..22) — 3 cases
 *
 * All cases use a real tmpdir + real fs writes + crafted V8 JSON; no mocks.
 * Each branch-count assertion fixes the V8 outer range at `count=1` so the
 * line-coverage ratio is 1 — the relevant numerator under test is the
 * AST-derived `branchCount` (the numerator/denominator pair is sealed by
 * the v8-source hellgate; this file seals the AST visitor only).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  astCoverageSource,
  type CoverageSource,
  defaultV8CoverageSource,
} from "@/observability/coverage"

let workDir = ""
let sourceDir = ""

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cov-ast-"))
  sourceDir = await mkdtemp(join(tmpdir(), "cov-pkg-"))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
  await rm(sourceDir, { recursive: true, force: true })
})

const writeV8 = async (
  scripts: Array<{
    url: string
    functions: Array<{ ranges: Array<{ startOffset: number; endOffset: number; count: number }> }>
  }>,
): Promise<string> => {
  const doc = { result: scripts.map((s, i) => ({ scriptId: String(i + 1), ...s })) }
  const p = join(workDir, "coverage.json")
  await writeFile(p, JSON.stringify(doc), "utf8")
  return p
}

const writeSource = async (basename: string, body: string): Promise<string> => {
  const p = join(sourceDir, basename)
  await writeFile(p, body, "utf8")
  return p
}

/** Build a V8 doc for `src` with full coverage, run astCoverageSource, return
 *  the file's branchCount (or -1 when the file vanished). */
let counter = 0
const runBranchCount = async (src: string): Promise<number> => {
  counter += 1
  const file = await writeSource(`b-${counter}.ts`, src)
  const cov = await writeV8([
    {
      url: `file://${file}`,
      functions: [{ ranges: [{ startOffset: 0, endOffset: src.length, count: 1 }] }],
    },
  ])
  const report = await astCoverageSource().read(cov)
  return report.files[0]?.branchCount ?? -1
}

// ────────────────────────────────────────────────────────────────────────────
// A. BRANCH TYPES (11)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage / A. AST branch types", () => {
  test("HELL-1: `if (x) {}` → 1 branch (then arm)", async () => {
    const count = await runBranchCount("function f(x){ if (x) { return 1 } }\n")
    expect(count).toBe(1)
  })

  test("HELL-2: `if (x) {} else {}` → 2 branches (then + else)", async () => {
    const count = await runBranchCount("function f(x){ if (x) { return 1 } else { return 0 } }\n")
    expect(count).toBe(2)
  })

  test("HELL-3: `if (x) {} else if (y) {} else {}` → 4 branches", async () => {
    // Outer if: +1 then, +1 else. Inner if (nested in else slot): +1 then,
    // +1 else. Total = 4.
    const count = await runBranchCount(
      "function f(x,y){ if (x) { return 1 } else if (y) { return 2 } else { return 3 } }\n",
    )
    expect(count).toBe(4)
  })

  test("HELL-4: switch with 3 cases + default → 4 branches", async () => {
    const src = [
      "function f(x){",
      "  switch (x) {",
      "    case 1: return 1",
      "    case 2: return 2",
      "    case 3: return 3",
      "    default: return 0",
      "  }",
      "}",
      "",
    ].join("\n")
    const count = await runBranchCount(src)
    expect(count).toBe(4)
  })

  test("HELL-5: ternary `a ? b : c` → 2 branches", async () => {
    const count = await runBranchCount("const r = (a:number, b:number, c:number) => a ? b : c\n")
    expect(count).toBe(2)
  })

  test("HELL-6: `a && b` → 1 branch", async () => {
    const count = await runBranchCount("const r = (a:boolean, b:boolean) => a && b\n")
    expect(count).toBe(1)
  })

  test("HELL-7: `a || b` → 1 branch", async () => {
    const count = await runBranchCount("const r = (a:boolean, b:boolean) => a || b\n")
    expect(count).toBe(1)
  })

  test("HELL-8: `a ?? b` (nullish coalesce) → 1 branch", async () => {
    const count = await runBranchCount("const r = (a:unknown, b:unknown) => a ?? b\n")
    expect(count).toBe(1)
  })

  test("HELL-9: `for (let i=0; i<n; i++) {}` → 1 branch (loop body)", async () => {
    const count = await runBranchCount("function f(n:number){ for (let i = 0; i < n; i++) {} }\n")
    expect(count).toBe(1)
  })

  test("HELL-10: `while (x) {}` → 1 branch", async () => {
    const count = await runBranchCount("function f(x:boolean){ while (x) {} }\n")
    expect(count).toBe(1)
  })

  test("HELL-11: `try {} catch (e) {}` → 1 branch (catch arm)", async () => {
    const count = await runBranchCount("function f(){ try { return 1 } catch (e) { return 0 } }\n")
    expect(count).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// B. FALSE-POSITIVE IMMUNITY (5)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage / B. AST false-positive immunity", () => {
  test("HELL-12: branch keywords INSIDE a string literal → 0 branches", async () => {
    const count = await runBranchCount('const s = "if (x) { return 1 } else { return 0 }"\n')
    expect(count).toBe(0)
  })

  test("HELL-13: branch keywords INSIDE a regex literal → 0 branches", async () => {
    const count = await runBranchCount("const r = /if|else|while|for/g\n")
    expect(count).toBe(0)
  })

  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal "${}" semantics
  test("HELL-14: `&&` inside template `${}` IS counted (executable expression)", async () => {
    // Documented policy (ADR-0170 §template): expressions inside `${}` are
    // real executable JS and DO contribute to branch count.
    const count = await runBranchCount(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal "${}" semantics
      "const r = (a:boolean,b:boolean) => `hello ${a && b} world`\n",
    )
    expect(count).toBe(1)
  })

  test("HELL-15: branch keyword inside a `// line comment` → 0 branches", async () => {
    const count = await runBranchCount("// if (x) { return 1 } else { return 0 }\nconst k = 1\n")
    expect(count).toBe(0)
  })

  test("HELL-16: real `if` next to a `/* block comment */` → 1 branch (comment skipped)", async () => {
    const count = await runBranchCount(
      "/* if-else stuff */ function f(z:boolean){ if (z) { return 1 } }\n",
    )
    expect(count).toBe(1)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// C. NESTED + COMPOSITE (3)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage / C. AST nested + composite", () => {
  test("HELL-17: nested if-else inside outer if → 3 branches", async () => {
    // Outer if: +1 then (the only arm — no outer else). Inner if-else:
    // +1 then, +1 else. Total = 3.
    const count = await runBranchCount(
      "function f(x:boolean,y:boolean){ if (x) { if (y) { return 1 } else { return 2 } } }\n",
    )
    expect(count).toBe(3)
  })

  test("HELL-18: switch case body contains an if-else → 3 branches", async () => {
    // SwitchStatement: 1 case + 0 default = 1 (we count CaseClauses, not the
    // arms-out-of-the-switch). Inner if-else: +1 then, +1 else. Total = 3.
    const src = [
      "function f(x:number,y:boolean){",
      "  switch(x){",
      "    case 1: if (y) { return 1 } else { return 2 }; break",
      "  }",
      "}",
      "",
    ].join("\n")
    const count = await runBranchCount(src)
    expect(count).toBe(3)
  })

  test("HELL-19: `for (const x of y) if (x) {}` → 2 branches (loop + if-then)", async () => {
    const count = await runBranchCount(
      "function f(y:boolean[]){ for (const x of y) if (x) { return 1 } }\n",
    )
    expect(count).toBe(2)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// D. CoverageSource PORT PARITY (3)
// ────────────────────────────────────────────────────────────────────────────
describe("coverage / D. AST port parity vs v8-source", () => {
  test("HELL-20: astCoverageSource() returns a CoverageSource (compile-level)", () => {
    const src: CoverageSource = astCoverageSource()
    expect(typeof src.read).toBe("function")
  })

  test("HELL-21: read() returns a structurally-valid CoverageReport", async () => {
    const text = "function f(x:boolean){ if (x) { return 1 } else { return 0 } }\n"
    const file = await writeSource("port.ts", text)
    const cov = await writeV8([
      {
        url: `file://${file}`,
        functions: [{ ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }] }],
      },
    ])
    const report = await astCoverageSource().read(cov)
    // Structural shape
    expect(Array.isArray(report.files)).toBe(true)
    expect(typeof report.totals.linesPercent).toBe("number")
    expect(typeof report.totals.branchesPercent).toBe("number")
    expect(typeof report.totals.statementsPercent).toBe("number")
    expect(report.totals.fileCount).toBe(1)
    expect(typeof report.generatedAt).toBe("number")
    // The single file shows up
    expect(report.files).toHaveLength(1)
    expect(report.files[0]?.file).toBe(file)
    // Branch count is the AST count (if-else → 2)
    expect(report.files[0]?.branchCount).toBe(2)
  })

  test("HELL-22: same V8 input — AST differs from v8 heuristic on branch-keyword string", async () => {
    // A file whose ONLY "branches" live inside a string literal:
    //   - v8 heuristic strips strings, then counts keywords ⇒ 0 in theory,
    //     BUT the heuristic also counts `&&`/`||`/`?:` inside template
    //     literals (it blanks them) and a constant `1` has zero of those.
    //   - We use a SECOND case where the string contains real branch tokens
    //     PLUS a real branch outside it — the heuristic UNDER-strips because
    //     its regex-based string strip is line-anchored (no multi-line); the
    //     AST gets it right.
    //
    // Pragmatic test: a file whose entire content is a single REGEX with
    // branch tokens — v8 heuristic doesn't strip regex literals, so it
    // counts `|`-bracketed alternatives as `||` branches. AST sees only
    // a RegularExpressionLiteral and contributes 0.
    const text = "const r = /if|else|while|for/g\n"
    const file = await writeSource("diff.ts", text)
    const cov = await writeV8([
      {
        url: `file://${file}`,
        functions: [{ ranges: [{ startOffset: 0, endOffset: text.length, count: 1 }] }],
      },
    ])
    const v8Report = await defaultV8CoverageSource().read(cov)
    const astReport = await astCoverageSource().read(cov)
    const v8Branches = v8Report.files[0]?.branchCount ?? -1
    const astBranches = astReport.files[0]?.branchCount ?? -1
    // AST is precise: regex contributes 0.
    expect(astBranches).toBe(0)
    // V8 heuristic over-counts (the regex `|` alternatives ARE seen as `||`
    // by the operator-pair regex). PROOF the AST is strictly more precise.
    expect(v8Branches).toBeGreaterThan(astBranches)
  })
})
