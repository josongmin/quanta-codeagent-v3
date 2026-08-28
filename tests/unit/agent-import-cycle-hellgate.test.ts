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
 *   21. LATCH REGRESSION — a `from`-less top-level `export` (`export const f =
 *      (`) must NOT blind the scanner to the rest of the file. This is the
 *      defect that made the sibling's assertion (c) inert: `inImport` was set
 *      on any depth-0 `import|export` line and cleared only by a quoted module
 *      specifier after `from`, so `export const …` swallowed every following
 *      line. Measured before the fix on the four whitelisted files, the latch
 *      fired at conversation-action.ts:64, steering.ts:40, mcp-bridge.ts:80,
 *      mcp-reload-source.ts:43 — and the set of eager-reference lines the old
 *      scanner reached was fully DISJOINT from the lines that actually carry
 *      module-init references (0 of 10 / 8 / 7 / 5).
 *   22. LATCH REGRESSION — `export interface`/`export type` preamble likewise
 *      must not swallow a later eager usage.
 *   23. Multi-line `import { … } from "…"` continuation lines still produce NO
 *      hits (what the latch legitimately protected — the fix must not trade
 *      one defect for the other).
 *   24. `export { foo }` with NO `from` clause is a live re-export BINDING, not
 *      a module-init read → NOT flagged, and does not swallow the file.
 *   25. Multi-line `export type T = …` union does not swallow the file.
 *   26. Eager usage in a STATIC class field IS flagged; the same usage in an
 *      instance field / method body is NOT.
 */
import { describe, expect, test } from "bun:test"

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH. This file used to carry a VERBATIM COPY of
// `findSCCs` / `findTopLevelUsage`. That copy is why the `inImport`-latch
// defect survived: the scanner existed in two places, so "fixed in one place"
// meant "still broken in the other", and the hellgate — the very battery whose
// job is to prove the guard binds — was asserting against its own stale twin.
// The primitives are now IMPORTED from the sibling. ESM caches the module, so
// the sibling's two real-source `describe`s register exactly once per process
// regardless of load order; running this file alone simply also runs them.
// ─────────────────────────────────────────────────────────────────────────────
import { findSCCs, findTopLevelUsage } from "./agent-import-cycle.test"

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

  test("[10] bare module-top-level reference is flagged, with or without `export`", () => {
    // Pre-fix this was a "documented limitation": a line starting with
    // `export` latched the import state machine, so `export const X = foo` was
    // never scanned. Both forms are real module-init reads and both must be
    // flagged now.
    const bare = ['import { foo } from "./x"', "", "const X = foo"].join("\n")
    expect(findTopLevelUsage(bare, ["foo"]).some((h) => h.line === 3)).toBe(true)

    const exported = ['import { foo } from "./x"', "", "export const X = foo"].join("\n")
    expect(findTopLevelUsage(exported, ["foo"]).some((h) => h.line === 3)).toBe(true)
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
// LATCH REGRESSION BATTERY. Every case below FAILS against the pre-fix
// `inImport` state machine and PASSES against the AST scanner. Cases 23/24/25
// are the paired control: they pin what the latch legitimately protected, so
// the fix cannot be "delete the latch and accept the false positives".
// ─────────────────────────────────────────────────────────────────────────────

describe("HELLGATE — a `from`-less export must not blind the rest of the file", () => {
  test("[21] eager usage AFTER `export const f = (` is still flagged", () => {
    // Shape of mcp-reload-source.ts: `export const disambiguateMcpToolNames = (`
    // at L43 latched the old scanner ON for the remaining 109 lines.
    const src = [
      'import { foo } from "./x"',
      "",
      "export const f = (",
      "  a: number,",
      "): number => a + 1",
      "",
      "const eager = foo",
      "void eager",
    ].join("\n")
    const hits = findTopLevelUsage(src, ["foo"])
    expect(hits).toEqual([{ name: "foo", line: 7 }])
  })

  test("[22] eager usage AFTER `export interface` / `export type` preamble is flagged", () => {
    // Shape of conversation-action.ts (`export type ConversationAction =` @L64)
    // and mcp-bridge.ts (`export type ElicitationPrompterFactory = …` @L80).
    const src = [
      'import { foo } from "./x"',
      "",
      "export interface Opts {",
      "  a: number",
      "}",
      "",
      'export type Kind = "a" | "b"',
      "",
      "foo()",
    ].join("\n")
    const hits = findTopLevelUsage(src, ["foo"])
    expect(hits).toEqual([{ name: "foo", line: 9 }])
  })

  test("[23] PAIRED CONTROL — multi-line `import { … } from` stays fully skipped", () => {
    // This is what `inImport` legitimately protected. The AST skips the whole
    // ImportDeclaration node, so continuation lines cannot produce hits — and
    // a real eager use after the block still must.
    const src = [
      "import {",
      "  foo,",
      "  bar,",
      '} from "./x"',
      "",
      "export const ok = () => foo()",
    ].join("\n")
    expect(findTopLevelUsage(src, ["foo", "bar"])).toEqual([])

    const withEager = [...src.split("\n"), "", "const eager = bar", "void eager"].join("\n")
    expect(findTopLevelUsage(withEager, ["foo", "bar"])).toEqual([{ name: "bar", line: 8 }])
  })

  test("[24] PAIRED CONTROL — `export { foo }` with no `from` is a binding, not a read", () => {
    // steering.ts:40 is exactly this shape. A re-export creates a live binding;
    // it never evaluates `foo` at module init, so it must NOT be flagged — and
    // it must not swallow the file either.
    const src = [
      'import { foo } from "./x"',
      "",
      "export { foo }",
      "",
      "export const ok = () => foo()",
    ].join("\n")
    expect(findTopLevelUsage(src, ["foo"])).toEqual([])

    const withEager = [...src.split("\n"), "", "const eager = foo", "void eager"].join("\n")
    expect(findTopLevelUsage(withEager, ["foo"])).toEqual([{ name: "foo", line: 7 }])
  })

  test("[25] PAIRED CONTROL — multi-line `export type` union does not swallow the file", () => {
    const src = [
      'import { foo } from "./x"',
      "",
      "export type Kind =",
      '  | { kind: "a" }',
      '  | { kind: "b" }',
      "",
      "foo()",
    ].join("\n")
    expect(findTopLevelUsage(src, ["foo"])).toEqual([{ name: "foo", line: 7 }])
  })

  test("[26] static class field IS eager; instance field and method body are NOT", () => {
    const eager = [
      'import { foo } from "./x"',
      "",
      "export class C {",
      "  static readonly v = foo",
      "}",
    ].join("\n")
    expect(findTopLevelUsage(eager, ["foo"])).toEqual([{ name: "foo", line: 4 }])

    const lazy = [
      'import { foo } from "./x"',
      "",
      "export class C {",
      "  readonly v = foo",
      "  m() {",
      "    return foo()",
      "  }",
      "}",
    ].join("\n")
    expect(findTopLevelUsage(lazy, ["foo"])).toEqual([])
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
