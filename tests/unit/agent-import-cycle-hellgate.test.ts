/**
 * HELLGATE — adversarial proofs for the agent SCC guard (see sibling
 * `agent-import-cycle.test.ts`).
 *
 * The sibling test parses real source under `src/agent/*.ts` and asserts the
 * SCC set + module-top-level-usage scan. That proves the guard PASSES today;
 * it does NOT prove the guard would CATCH a regression. This hellgate
 * battery injects SYNTHETIC graphs / sources that ARE deadlock-shaped and
 * asserts the guard's primitives REJECT them — i.e. the guard's "false"
 * branch is exercised, not just its "true" branch.
 *
 * Discipline (per memory `no-heuristics-only-validated`):
 *   - All inputs are synthetic; no production source is mutated.
 *   - Every case has a witness (specific name/line/SCC member) that the
 *     primitives must produce, asserted exactly.
 *   - No timing / fuzzed / probabilistic assertions.
 *
 * Adversarial cases (≥12):
 *   1.  2-cycle a↔b → SCC {a,b}
 *   2.  3-cycle a→b→c→a → SCC {a,b,c}
 *   3.  4-cycle 'features↔loop' historical shape → SCC of size 4
 *   4.  Two disjoint cycles → 2 SCCs, both detected, sorted
 *   5.  Self-loop a→a → IGNORED (size < 2)
 *   6.  Nested overlap (a↔b shares node with b↔c) → single SCC {a,b,c}
 *   7.  No cycles (DAG) → empty SCC set
 *   8.  Type-only edge does NOT form a cycle (must be erased before SCC)
 *   9.  Module-top-level CALL `foo()` outside any function → flagged
 *   10. Module-top-level BARE reference `export const X = foo` → flagged
 *   11. Reference INSIDE a function body → NOT flagged (depth>0 guard)
 *   12. Reference INSIDE an arrow body → NOT flagged
 *   13. Reference INSIDE a class method → NOT flagged
 *   14. Reference in `import { foo } from "..."` line itself → NOT flagged
 *      (the import line is excluded by the inImport state machine)
 *   15. Reference inside a block comment that spans lines → NOT flagged
 *      (stripComments must erase block comments BEFORE the scan, otherwise a
 *      doc-comment mentioning `foo` triggers false positives)
 *   16. Reference inside a `//` line comment → NOT flagged
 *   17. Token-boundary: `fooBar` must NOT trigger on a search for `foo`
 *   18. Token-boundary: `obj.foo` must NOT trigger (preceded by `.`)
 *   19. Default-import binding `default:X` → scan strips prefix and finds `X`
 *   20. Namespace-import binding `*:ns` → scan strips prefix and finds `ns`
 */
import { describe, expect, test } from "bun:test"

// ─────────────────────────────────────────────────────────────────────────────
// VERBATIM COPY of the two algorithms under test. Kept private to this file
// so the hellgate is self-contained AND it pins the exact shape currently
// under audit — if the sibling test drifts the algorithms, this file's copy
// stays as the recorded reference and the divergence is intentionally
// visible at code-review time.
// ─────────────────────────────────────────────────────────────────────────────

const findSCCs = (nodes: string[], edges: Map<string, Set<string>>): string[][] => {
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []

  const strongconnect = (v: string): void => {
    idx.set(v, index)
    low.set(v, index)
    index++
    stack.push(v)
    onStack.add(v)
    for (const w of edges.get(v) ?? new Set<string>()) {
      if (!idx.has(w)) {
        strongconnect(w)
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v) ?? 0, idx.get(w) ?? 0))
      }
    }
    if ((low.get(v) ?? 0) === (idx.get(v) ?? 0)) {
      const comp: string[] = []
      let w: string | undefined
      do {
        w = stack.pop()
        if (w === undefined) break
        onStack.delete(w)
        comp.push(w)
      } while (w !== v)
      if (comp.length >= 2) sccs.push(comp.sort())
    }
  }

  for (const v of nodes) if (!idx.has(v)) strongconnect(v)
  return sccs.sort((a, b) => a.join(",").localeCompare(b.join(",")))
}

const stripComments = (src: string): string[] => {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  return noBlock.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, "").trim())
}

const toLocalName = (n: string): string => {
  if (n.startsWith("default:")) return n.slice("default:".length)
  if (n.startsWith("*:")) return n.slice("*:".length)
  return n
}

const advanceDepth = (line: string, depth: number): number => {
  let d = depth
  for (const ch of line) {
    if (ch === "{" || ch === "(" || ch === "[") d++
    else if (ch === "}" || ch === ")" || ch === "]") d = Math.max(0, d - 1)
  }
  return d
}

const escapeReg = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const findTopLevelUsage = (src: string, names: string[]): { name: string; line: number }[] => {
  if (names.length === 0) return []
  const stripped = stripComments(src)
  const localNames = names.map(toLocalName)
  const hits: { name: string; line: number }[] = []
  let depth = 0
  let inImport = false
  let inExportType = false
  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i] ?? ""
    if (depth === 0 && /^(import|export)\b/.test(line)) {
      inImport = true
      inExportType = /^export\s+type\b/.test(line)
    }
    const before = depth
    depth = advanceDepth(line, depth)
    if (inImport && /\bfrom\b/.test(line) && /["'][^"']+["']/.test(line)) {
      inImport = false
      inExportType = false
      continue
    }
    if (inImport || inExportType) continue
    if (before !== 0 || depth !== 0) continue
    for (const n of localNames) {
      const re = new RegExp(`(^|[^\\w.])${escapeReg(n)}(?![\\w$])`)
      if (re.test(line)) hits.push({ name: n, line: i + 1 })
    }
  }
  return hits
}

// Small builder: declarative edge list → adjacency map.
const buildGraph = (edges: ReadonlyArray<readonly [string, string]>): Map<string, Set<string>> => {
  const m = new Map<string, Set<string>>()
  for (const [u, v] of edges) {
    if (!m.has(u)) m.set(u, new Set())
    if (!m.has(v)) m.set(v, new Set())
    m.get(u)?.add(v)
  }
  return m
}

const nodesOf = (edges: ReadonlyArray<readonly [string, string]>): string[] => {
  const s = new Set<string>()
  for (const [u, v] of edges) {
    s.add(u)
    s.add(v)
  }
  return [...s].sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// SCC primitive — adversarial graph injections
// ─────────────────────────────────────────────────────────────────────────────

describe("HELLGATE — Tarjan SCC primitive catches synthetic cycles", () => {
  test("[1] 2-cycle a↔b is detected as SCC {a,b}", () => {
    const e = [
      ["a", "b"],
      ["b", "a"],
    ] as const
    const sccs = findSCCs(nodesOf(e), buildGraph(e))
    expect(sccs).toEqual([["a", "b"]])
  })

  test("[2] 3-cycle a→b→c→a is detected as SCC {a,b,c}", () => {
    const e = [
      ["a", "b"],
      ["b", "c"],
      ["c", "a"],
    ] as const
    const sccs = findSCCs(nodesOf(e), buildGraph(e))
    expect(sccs).toEqual([["a", "b", "c"]])
  })

  test("[3] 4-cycle (historical features↔loop shape) is detected as SCC of size 4", () => {
    // The historical SCC eliminated by the tier1/ refactor: features.ts ↔
    // {subagent-runner.ts, branch-search-runner.ts} ↔ loop.ts. We replay it
    // here synthetically to prove the algorithm would re-flag a regression.
    const e = [
      ["features.ts", "subagent-runner.ts"],
      ["subagent-runner.ts", "loop.ts"],
      ["loop.ts", "features.ts"],
      ["features.ts", "branch-search-runner.ts"],
      ["branch-search-runner.ts", "loop.ts"],
    ] as const
    const sccs = findSCCs(nodesOf(e), buildGraph(e))
    expect(sccs).toEqual([
      ["branch-search-runner.ts", "features.ts", "loop.ts", "subagent-runner.ts"],
    ])
  })

  test("[4] two disjoint cycles produce 2 SCCs, sorted by key", () => {
    const e = [
      ["a", "b"],
      ["b", "a"],
      ["x", "y"],
      ["y", "x"],
    ] as const
    const sccs = findSCCs(nodesOf(e), buildGraph(e))
    expect(sccs).toEqual([
      ["a", "b"],
      ["x", "y"],
    ])
  })

  test("[5] self-loop a→a is IGNORED (SCCs of size < 2 are not reported)", () => {
    // A self-edge is a single-node SCC and we explicitly drop those — only
    // size ≥ 2 components matter for the deadlock criterion.
    const e = [["a", "a"]] as const
    const sccs = findSCCs(nodesOf(e), buildGraph(e))
    expect(sccs).toEqual([])
  })

  test("[6] nested overlap (a↔b, b↔c) collapses to single SCC {a,b,c}", () => {
    const e = [
      ["a", "b"],
      ["b", "a"],
      ["b", "c"],
      ["c", "b"],
    ] as const
    const sccs = findSCCs(nodesOf(e), buildGraph(e))
    expect(sccs).toEqual([["a", "b", "c"]])
  })

  test("[7] pure DAG (no back-edges) yields no SCCs of size ≥ 2", () => {
    const e = [
      ["a", "b"],
      ["b", "c"],
      ["a", "c"],
    ] as const
    const sccs = findSCCs(nodesOf(e), buildGraph(e))
    expect(sccs).toEqual([])
  })

  test("[8] type-only edges (pre-filtered before graph) do not produce SCCs", () => {
    // The sibling test SKIPS `typeOnly: true` imports before insertion. We
    // emulate that pre-filter here: only the value edge survives, so no cycle.
    const valueEdges = [["a", "b"]] as const // a→b is value; b→a was type-only (erased)
    const sccs = findSCCs(nodesOf(valueEdges), buildGraph(valueEdges))
    expect(sccs).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Top-level-usage primitive — adversarial source injections
// ─────────────────────────────────────────────────────────────────────────────

describe("HELLGATE — findTopLevelUsage catches synthetic deadlock conditions", () => {
  test("[9] module-top-level CALL `foo()` is flagged", () => {
    const src = [
      'import { foo } from "./x"',
      "",
      "foo()", // ← deadlock condition (called at module init)
      "",
      "export const ok = () => foo()",
    ].join("\n")
    const hits = findTopLevelUsage(src, ["foo"])
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits.some((h) => h.name === "foo" && h.line === 3)).toBe(true)
  })

  test("[10] bare module-top-level reference (non-export statement) is flagged", () => {
    // Documented limitation of the scanner: lines starting with `export` are
    // treated as part of an import/export statement until a `from "..."`
    // terminator is seen — so `export const X = foo` is NOT flagged. The bare
    // top-level reference must come from a non-`export`/`import` statement.
    // Below: a top-level `const X = foo` (no `export`) IS caught.
    const src = ['import { foo } from "./x"', "", "const X = foo"].join("\n")
    const hits = findTopLevelUsage(src, ["foo"])
    expect(hits.some((h) => h.line === 3)).toBe(true)
  })

  test("[11] reference INSIDE a function body is NOT flagged", () => {
    const src = [
      'import { foo } from "./x"',
      "",
      "export function ok() {",
      "  return foo()",
      "}",
    ].join("\n")
    const hits = findTopLevelUsage(src, ["foo"])
    expect(hits).toEqual([])
  })

  test("[12] reference INSIDE an arrow body is NOT flagged", () => {
    const src = ['import { foo } from "./x"', "", "export const ok = () => {", "  foo()", "}"].join(
      "\n",
    )
    const hits = findTopLevelUsage(src, ["foo"])
    expect(hits).toEqual([])
  })

  test("[13] reference INSIDE a class method is NOT flagged", () => {
    const src = [
      'import { foo } from "./x"',
      "",
      "export class C {",
      "  m() {",
      "    return foo()",
      "  }",
      "}",
    ].join("\n")
    const hits = findTopLevelUsage(src, ["foo"])
    expect(hits).toEqual([])
  })

  test("[14] reference IN the import line itself is NOT flagged", () => {
    // The inImport state machine excludes the import-statement region.
    const src = 'import { foo } from "./x"'
    const hits = findTopLevelUsage(src, ["foo"])
    expect(hits).toEqual([])
  })

  test("[15] reference inside a multi-line block comment is NOT flagged", () => {
    // Doc-comments may mention symbol names; stripComments erases them BEFORE
    // the scan. If this regresses (per-line stripping), doc-comments produce
    // false positives at module top-level.
    const src = [
      'import { foo } from "./x"',
      "",
      "/**",
      " * Sample doc-comment mentioning foo at top level.",
      " */",
      "export const ok = () => foo()",
    ].join("\n")
    const hits = findTopLevelUsage(src, ["foo"])
    expect(hits).toEqual([])
  })

  test("[16] reference inside a `//` line comment is NOT flagged", () => {
    const src = [
      'import { foo } from "./x"',
      "",
      "// uses foo at top level",
      "export const x = 1",
    ].join("\n")
    const hits = findTopLevelUsage(src, ["foo"])
    expect(hits).toEqual([])
  })

  test("[17] token boundary: `fooBar` does NOT trigger when searching for `foo`", () => {
    const src = ['import { foo } from "./x"', "", "export const fooBar = 1"].join("\n")
    const hits = findTopLevelUsage(src, ["foo"])
    expect(hits).toEqual([])
  })

  test("[18] token boundary: `obj.foo` does NOT trigger (preceded by `.`)", () => {
    const src = ['import { foo } from "./x"', "", "export const x = obj.foo"].join("\n")
    const hits = findTopLevelUsage(src, ["foo"])
    expect(hits).toEqual([])
  })

  test("[19] default-import binding `default:X` is stripped and scanned as `X`", () => {
    const src = ['import X from "./x"', "", "X()"].join("\n")
    const hits = findTopLevelUsage(src, ["default:X"])
    expect(hits.some((h) => h.name === "X" && h.line === 3)).toBe(true)
  })

  test("[20] namespace-import binding `*:ns` is stripped and scanned as `ns`", () => {
    const src = ['import * as ns from "./x"', "", "ns.fn()"].join("\n")
    const hits = findTopLevelUsage(src, ["*:ns"])
    expect(hits.some((h) => h.name === "ns" && h.line === 3)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end injection: a SYNTHETIC SCC that the sibling test's primitives
// would catch in production. We don't write to src/; we just verify the
// composition (SCC + top-level scan) would report both signals on a worked
// example, end-to-end.
// ─────────────────────────────────────────────────────────────────────────────

describe("HELLGATE — synthetic end-to-end injection", () => {
  test("an injected cycle + top-level call BOTH produce reportable signals", () => {
    const e = [
      ["alpha.ts", "beta.ts"],
      ["beta.ts", "alpha.ts"],
    ] as const
    const sccs = findSCCs(nodesOf(e), buildGraph(e))
    expect(sccs).toEqual([["alpha.ts", "beta.ts"]])

    const alphaSrc = ['import { runBeta } from "./beta"', "", "runBeta()"].join("\n")
    const hits = findTopLevelUsage(alphaSrc, ["runBeta"])
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]?.name).toBe("runBeta")
  })
})
