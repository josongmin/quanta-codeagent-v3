/**
 * Negative-proof battery for the slice-boundary guard gaps closed in the
 * `@/storage → @/tool` inversion fix (R1 audit). A guard you can't see FIRE is
 * worthless — every assertion here drives a SYNTHETIC violation through the
 * real policy and asserts it is flagged (red-on-injection), plus a clean
 * control that is NOT flagged (green-on-clean).
 *
 * Two engines are exercised:
 *   1. The AST slice-boundary deny-list (`isImportDeniedByConfig`) — the guard
 *      that now denies `@/storage → @/tool` (Part 2.1) and covers the new leaf
 *      slices `@/git` / `@/browser` / `@/scheduler` (Part 2.3).
 *   2. The slice-graph validator (`validateGraph` + `SLICE_RULES`) — the guard
 *      that now bars Layer-0/1 → Layer-2 up-imports (Part 2.2).
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSliceGraph } from "../../tools/slice-graph/build-graph"
import { SLICE_RULES, validateGraph } from "../../tools/slice-graph/validate"
import { getSliceBoundaryConfig } from "./_arch/slice-boundary-configs"
import { isImportDeniedByConfig } from "./_arch/slice-boundary-scanner"

const makeTmpSrc = (): string => mkdtempSync(join(tmpdir(), "up-import-proof-"))

const writeFile = (root: string, rel: string, content: string): void => {
  const full = join(root, rel)
  const dir = full.slice(0, full.lastIndexOf("/"))
  mkdirSync(dir, { recursive: true })
  writeFileSync(full, content, "utf8")
}

describe("Part 2.1 — storage deny-list now flags storage→tool (the escaped inversion)", () => {
  const storage = getSliceBoundaryConfig("storage")

  test("FIRES: `@/tool/git` VALUE import from @/storage is denied", () => {
    // This is the EXACT import `shadow-odb/default.ts` used to carry.
    expect(isImportDeniedByConfig("@/tool/git", storage)).toBe(true)
    expect(isImportDeniedByConfig("@/tool", storage)).toBe(true)
  })

  test("CLEAN: the relocated leaf `@/storage/git-runner` is NOT denied (self-slice)", () => {
    expect(isImportDeniedByConfig("@/storage/git-runner", storage)).toBe(false)
  })

  test("CLEAN: `@/shared` (true leaf) is NOT denied", () => {
    expect(isImportDeniedByConfig("@/shared", storage)).toBe(false)
  })
})

describe("Part 2.3 — new leaf slices have a live deny-list", () => {
  for (const slice of ["git", "browser", "scheduler"] as const) {
    const cfg = getSliceBoundaryConfig(slice)
    test(`@/${slice}: FIRES on a peer-library up/cross import (@/agent, @/tool)`, () => {
      expect(isImportDeniedByConfig("@/agent", cfg)).toBe(true)
      expect(isImportDeniedByConfig("@/tool", cfg)).toBe(true)
    })
    test(`@/${slice}: FIRES on a Layer-2 up-import (@/runner, @/host, @/ipc, @/apps)`, () => {
      expect(isImportDeniedByConfig("@/runner", cfg)).toBe(true)
      expect(isImportDeniedByConfig("@/host", cfg)).toBe(true)
      expect(isImportDeniedByConfig("@/ipc", cfg)).toBe(true)
      expect(isImportDeniedByConfig("@/apps", cfg)).toBe(true)
    })
    test(`@/${slice}: CLEAN on its only real dependency (@/shared)`, () => {
      expect(isImportDeniedByConfig("@/shared", cfg)).toBe(false)
    })
  }
})

describe("Part 2.2 — SLICE_RULES bars Layer-0/1 → Layer-2 up-imports (slice-graph)", () => {
  // Drive a synthetic VALUE up-import through the live build-graph + validator.
  for (const [from, to] of [
    ["memory", "@/runner"],
    ["agent", "@/host"],
    ["storage", "@/ipc"],
    ["llm", "@/apps"],
    ["git", "@/runner"],
    ["scheduler", "@/host"],
  ] as const) {
    test(`FIRES: ${from} → ${to} is flagged`, async () => {
      const root = makeTmpSrc()
      writeFile(root, `${from}/synthetic.ts`, `import { x } from "${to}"\nexport const y = x\n`)
      const g = await buildSliceGraph({ roots: [root] })
      const v = validateGraph(g, { srcRoots: [root] })
      const hit = v.find((vi) => vi.from === from && to === `@/${vi.to}`)
      expect(hit).toBeDefined()
    })
  }

  test("CLEAN: a DOWN import (agent → @/llm) is NOT flagged by the up-import rules", async () => {
    const root = makeTmpSrc()
    writeFile(root, "agent/ok.ts", `import { x } from "@/llm"\nexport const y = x\n`)
    const g = await buildSliceGraph({ roots: [root] })
    const v = validateGraph(g, { srcRoots: [root] })
    expect(v).toHaveLength(0)
  })

  test("the up-import rules are actually present in SLICE_RULES", () => {
    const layer2 = ["runner", "host", "ipc", "apps"]
    const hasRule = (from: string): boolean =>
      SLICE_RULES.some((r) => r.from === from && layer2.every((l) => r.to.includes(l)))
    for (const from of ["memory", "storage", "git", "browser", "scheduler", "tool", "llm"]) {
      expect(hasRule(from)).toBe(true)
    }
  })
})
