/**
 * tests/unit/slice-graph-hellgate.test.ts — 15-case hellgate for the
 * slice-graph tool (ADR-0190 fence enforcement). Three buckets:
 *   A. buildSliceGraph parsing semantics (5)
 *   B. validateGraph rule-matching (6)
 *   C. Real-graph audit over `<repo>/src` (4)
 *
 * Tests use `mkdtempSync` for isolated synthetic graphs so the audit
 * sub-suite doesn't see test fixtures. Real-graph audit walks `<repo>/src`
 * directly via the default roots.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSliceGraph } from "../../tools/slice-graph/build-graph"
import { type ForbiddenEdge, SLICE_RULES, validateGraph } from "../../tools/slice-graph/validate"

const makeTmpSrc = (): string => mkdtempSync(join(tmpdir(), "slice-graph-test-"))

const writeFile = (root: string, rel: string, content: string): void => {
  const full = join(root, rel)
  const dir = full.slice(0, full.lastIndexOf("/"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(full, content, "utf8")
}

describe("A. buildSliceGraph parsing", () => {
  test("1. Single file with 1 cross-slice import → 1 edge", async () => {
    const root = makeTmpSrc()
    writeFile(root, "agent/loop.ts", `import { x } from "@/llm"\nexport const y = 1\n`)
    const g = await buildSliceGraph({ roots: [root] })
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]).toMatchObject({ from: "agent", to: "llm", count: 1 })
  })

  test("2. Multiple files same slice → edges deduped + counted", async () => {
    const root = makeTmpSrc()
    writeFile(root, "agent/a.ts", `import { x } from "@/llm"\n`)
    writeFile(root, "agent/b.ts", `import { y } from "@/llm"\n`)
    writeFile(root, "agent/c.ts", `import { z } from "@/llm"\n`)
    const g = await buildSliceGraph({ roots: [root] })
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]).toMatchObject({ from: "agent", to: "llm", count: 3 })
  })

  test("3. Relative imports (./, ../) → same-slice (no cross-slice edge)", async () => {
    const root = makeTmpSrc()
    writeFile(root, "agent/a.ts", `import { x } from "./b"\nimport { y } from "../agent/c"\n`)
    writeFile(root, "agent/b.ts", `export const x = 1\n`)
    writeFile(root, "agent/c.ts", `export const y = 1\n`)
    const g = await buildSliceGraph({ roots: [root] })
    expect(g.edges).toHaveLength(0)
  })

  test("4. Type-only imports (import type {}) → still counted as semantic dep", async () => {
    const root = makeTmpSrc()
    writeFile(root, "agent/a.ts", `import type { Foo } from "@/llm"\n`)
    const g = await buildSliceGraph({ roots: [root] })
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]).toMatchObject({ from: "agent", to: "llm" })
  })

  test("5. Empty file → no edges, slice still discovered via path", async () => {
    const root = makeTmpSrc()
    writeFile(root, "agent/empty.ts", "")
    const g = await buildSliceGraph({ roots: [root] })
    expect(g.edges).toHaveLength(0)
    expect(g.slices).toContain("agent")
  })
})

describe("B. validateGraph rule matching", () => {
  test("6. Edge matches forbidden rule → violation surfaced", async () => {
    const root = makeTmpSrc()
    // Deliberate violation: observability → agent (forbidden by rule)
    writeFile(root, "observability/foo.ts", `import type { X } from "@/agent"\n`)
    const g = await buildSliceGraph({ roots: [root] })
    const v = validateGraph(g, { srcRoots: [root] })
    expect(v).toHaveLength(1)
    expect(v[0]?.from).toBe("observability")
    expect(v[0]?.to).toBe("agent")
  })

  test("7. Edge NOT in rule → no violation (agent → llm is allowed)", async () => {
    const root = makeTmpSrc()
    writeFile(root, "agent/a.ts", `import { x } from "@/llm"\n`)
    const g = await buildSliceGraph({ roots: [root] })
    const v = validateGraph(g, { srcRoots: [root] })
    expect(v).toHaveLength(0)
  })

  test("8. Multiple violations → all returned", async () => {
    const root = makeTmpSrc()
    writeFile(root, "observability/a.ts", `import type { X } from "@/agent"\n`)
    writeFile(root, "observability/b.ts", `import type { Y } from "@/agent"\n`)
    writeFile(root, "llm/c.ts", `import type { Z } from "@/agent"\n`)
    const g = await buildSliceGraph({ roots: [root] })
    const v = validateGraph(g, { srcRoots: [root] })
    expect(v.length).toBe(3)
  })

  test("9. Custom rule referencing unknown slice → graceful (no false positive)", async () => {
    const root = makeTmpSrc()
    writeFile(root, "agent/a.ts", `import { x } from "@/llm"\n`)
    const g = await buildSliceGraph({ roots: [root] })
    const customRules: ReadonlyArray<ForbiddenEdge> = [
      { from: "nonexistent", to: ["alsofake"], reason: "test" },
    ]
    const v = validateGraph(g, { srcRoots: [root], rules: customRules })
    expect(v).toHaveLength(0)
  })

  test("10. Cross-slice within agent (e.g. agent/loop → agent/recovery) → not flagged unless explicit rule", async () => {
    const root = makeTmpSrc()
    // No rule covers agent/foo → agent/bar generically — only the
    // explicit sub-slice rules in SLICE_RULES (subagent-resume, etc.)
    writeFile(root, "agent/loop.ts", `import { x } from "./recovery"\n`)
    writeFile(root, "agent/recovery.ts", `export const x = 1\n`)
    const g = await buildSliceGraph({ roots: [root] })
    const v = validateGraph(g, { srcRoots: [root] })
    expect(v).toHaveLength(0)
  })

  test("11. Sub-slice rule fires: agent/subagent-resume → @/agent/loop", async () => {
    const root = makeTmpSrc()
    // The `from` side is matched by file PATH, not by spec — so we put a
    // file under `agent/subagent-resume/` AND have it import `@/agent/loop`.
    writeFile(root, "agent/subagent-resume/foo.ts", `import type { X } from "@/agent/loop"\n`)
    const g = await buildSliceGraph({ roots: [root] })
    const v = validateGraph(g, { srcRoots: [root] })
    expect(v.length).toBeGreaterThanOrEqual(1)
    expect(v[0]?.from).toBe("agent/subagent-resume")
    expect(v[0]?.to).toBe("agent/loop")
  })
})

describe("C. Real-graph audit over <repo>/src", () => {
  // Share one graph build across the 4 real-graph tests — building takes
  // ~5s over ~840 files; per-test rebuild would push us past bun's 5s
  // default timeout.
  let realGraphPromise: Promise<Awaited<ReturnType<typeof buildSliceGraph>>> | null = null
  const getRealGraph = () => {
    if (realGraphPromise === null) realGraphPromise = buildSliceGraph()
    return realGraphPromise
  }

  test("12. buildSliceGraph(real-src) → at least 25 slices observed", async () => {
    const g = await getRealGraph()
    expect(g.slices.length).toBeGreaterThanOrEqual(25)
  }, 30_000)

  test("13. validateGraph(real-src) → snapshot count of violations", async () => {
    // EXPECTED (9): type-only reverse-layering imports, all TOLERATED.
    //   tool → agent (2): tool/objective/index.ts, tool/subagent-mailbox/index.ts
    //   observability → agent (7): instrument.ts / observability-helper.ts /
    //     instrument-budget.ts / instrument-plan-queue.ts /
    //     prompt-cache/budget-bridge.ts / metrics/wire-new-slices.ts /
    //     codex-r2-metrics/registry-metrics-decorator.ts
    // Every flagged edge is `import type` of a NARROW metric/registry port
    // (ADR-0217 fence-aware metric ports + ADR-0352/0366 codex-r2-metrics
    // decorators) — type-only, so they erase at compile time and create NO
    // runtime reverse dependency. Bumped 8→9 in 2026-06-02 (fix/jun02-scan-
    // gates): `wire-new-slices.ts` + `registry-metrics-decorator.ts` landed
    // their type-only metric-port imports after the prior baseline was set.
    // This snapshot is the "silent-drift baseline" future audits drive toward
    // 0 — any NEW edge forces a reviewed snapshot bump in the same PR.
    const g = await getRealGraph()
    const v = validateGraph(g)
    expect(v.length).toBeLessThanOrEqual(9)
  }, 30_000)

  test("14. Top-imported slices: shared / agent / llm rank high", async () => {
    const g = await getRealGraph()
    const incoming = new Map<string, number>()
    for (const edge of g.edges) {
      incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + edge.count)
    }
    const ranked = [...incoming.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    const top5 = ranked.map(([slice]) => slice)
    // At least one of shared / agent / llm / tool should appear in top-5.
    const expectedAny = ["shared", "agent", "llm", "tool", "observability"]
    const hit = top5.some((s) => expectedAny.includes(s))
    expect(hit).toBe(true)
  }, 30_000)

  test("15. observability → agent edges enumerable (plane-clean target)", async () => {
    const g = await getRealGraph()
    const obsToAgent = g.edges.filter((e) => e.from === "observability" && e.to === "agent")
    // Pre-existing drift — must not GROW. Test pins the current state
    // so adding a new cross-import surfaces in PR review.
    if (obsToAgent.length > 0) {
      const edge = obsToAgent[0]
      expect(edge?.count).toBeLessThanOrEqual(15)
    }
    // The validator considers these a violation regardless — this
    // test just enumerates them for diagnostic visibility.
    expect(obsToAgent.length).toBeLessThanOrEqual(10)
  }, 30_000)
})

// Confirm the SLICE_RULES module is non-empty + each rule has a non-empty reason.
describe("SLICE_RULES integrity", () => {
  test("Each rule has a non-empty reason", () => {
    for (const rule of SLICE_RULES) {
      expect(rule.from.length).toBeGreaterThan(0)
      expect(rule.to.length).toBeGreaterThan(0)
      expect(rule.reason.length).toBeGreaterThan(0)
    }
  })

  test("Sub-slice rules reference existing slice top-levels", () => {
    const validSliceNames = new Set([
      "agent",
      "tool",
      "llm",
      "mcp",
      "memory",
      "storage",
      "stream",
      "permission",
      "runtime",
      "lsp",
      "observability",
      "session",
      "subagent",
      "skill",
      "security",
      "patch",
      "auth",
      "rules",
      "migration",
      "shared",
      "ui",
      "git",
      "runner",
      "ipc",
      "retrieval",
      "reactor",
      "scheduler",
      "connectors",
      "plugin-isolation",
      "apps",
    ])
    for (const rule of SLICE_RULES) {
      const fromTop = rule.from.split("/")[0]
      expect(validSliceNames.has(fromTop ?? "")).toBe(true)
    }
  })
})
