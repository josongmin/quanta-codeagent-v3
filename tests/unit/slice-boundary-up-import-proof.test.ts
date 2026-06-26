/**
 * Negative-proof battery for the slice-boundary guard gaps closed in the
 * `@/storage → @/tool` inversion fix (R1 audit). A guard you can't see FIRE is
 * worthless — every assertion here drives a SYNTHETIC violation through the
 * real policy and asserts it is flagged (red-on-injection), plus a clean
 * control that is NOT flagged (green-on-clean).
 *
 * Engines exercised:
 *   1. The AST slice-boundary deny-list (`isImportDeniedByConfig`) — denies
 *      `@/storage → @/tool` (Part 2.1) and covers the leaf slices `@/git` /
 *      `@/browser` / `@/scheduler` / `@/stream` / `@/reactor` (Part 2.3).
 *   2. The slice-graph validator (`validateGraph` + `SLICE_RULES`) — bars
 *      Layer-0/1 → Layer-2 up-imports (Part 2.2).
 *   3. The surface-isolation TYPE-position detector (`extractTypeOnlyModuleRefs`
 *      + `isSurfaceSpec`) — catches `apps/**` refs in `import type` / `import("x").T`
 *      position, the form that hid the `@/agent → apps/cli` inversion (Part 2.4).
 *   4. The `surfaceIsolationOnly` Layer-2 configs `@/host` / `@/sdk` / `@/kernel`
 *      (Part 2.5) and the type-only-LOCKED `@/reactor → @/agent` edge (Part 2.6).
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSliceGraph } from "../../tools/slice-graph/build-graph"
import { SLICE_RULES, validateGraph } from "../../tools/slice-graph/validate"
import { getSliceBoundaryConfig } from "./_arch/slice-boundary-configs"
import {
  extractTypeOnlyModuleRefs,
  isImportDeniedByConfig,
  isSurfaceSpec,
} from "./_arch/slice-boundary-scanner"

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
  for (const slice of ["git", "browser", "scheduler", "stream", "reactor"] as const) {
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

describe("Part 2.4 — surface isolation now catches TYPE-position apps/** refs", () => {
  // The `@/agent` → `apps/cli` surface-port inversion hid for months because it
  // used the inline `import("../../apps/cli/…").Port` TYPE syntax, which the
  // value-import scanner (`extractImports`) deliberately skips. These drive the
  // exact escaped form through the NEW detector + the SHARED surface predicate.

  test('FIRES: inline `import("…/apps/cli/…").Port` type ref is detected + flagged', () => {
    // Byte-for-byte the form `wire-slots-compose.ts` carried before the hoist.
    const src = `export interface C {
      textInbox?: { readonly sink: import("../../apps/cli/text-inbox").TextInbox }
    }`
    const refs = extractTypeOnlyModuleRefs(src)
    const specs = refs.map((r) => r.spec)
    expect(specs).toContain("../../apps/cli/text-inbox")
    expect(refs.some((r) => isSurfaceSpec(r.spec))).toBe(true)
  })

  test('FIRES: `import type { X } from "@/apps/web-daemon/…"` is detected + flagged', () => {
    const src = `import type { Foo } from "@/apps/web-daemon/server"\nexport type Bar = Foo`
    const refs = extractTypeOnlyModuleRefs(src)
    expect(refs.some((r) => r.spec === "@/apps/web-daemon/server" && isSurfaceSpec(r.spec))).toBe(
      true,
    )
  })

  test('FIRES: `export type … from "…/apps/…"` re-export is detected + flagged', () => {
    const src = `export type { Port } from "../../apps/cli/edit-plan-cmd"`
    const refs = extractTypeOnlyModuleRefs(src)
    expect(refs.some((r) => isSurfaceSpec(r.spec))).toBe(true)
  })

  test('CLEAN: a legit core type ref (`import type … from "@/llm"`) is NOT a surface ref', () => {
    const src = `import type { Message } from "@/llm"\nexport type M = Message`
    const refs = extractTypeOnlyModuleRefs(src)
    // The ref IS extracted (it's a type-only import)…
    expect(refs.some((r) => r.spec === "@/llm")).toBe(true)
    // …but it is NOT a surface ref, so the guard does not flag it.
    expect(refs.some((r) => isSurfaceSpec(r.spec))).toBe(false)
  })

  test("CLEAN: the hoisted `@/agent/surface-ports` ref (the FIX) is NOT a surface ref", () => {
    // What `wire-slots-compose.ts` carries AFTER the hoist — must stay clean.
    const src = `export interface C {
      textInbox?: { readonly sink: import("../surface-ports").TextInbox }
    }`
    const refs = extractTypeOnlyModuleRefs(src)
    expect(refs.some((r) => isSurfaceSpec(r.spec))).toBe(false)
  })
})

describe("Part 2.5 — host/sdk/kernel configs exist and are surface-isolation-only", () => {
  for (const slice of ["host", "sdk", "kernel"] as const) {
    test(`${slice} config is registered with surfaceIsolationOnly`, () => {
      const cfg = getSliceBoundaryConfig(slice)
      expect(cfg.slice).toBe(slice)
      expect(cfg.surfaceIsolationOnly).toBe(true)
    })
  }
})

describe("Part 2.6 — the reactor→agent edge is LOCKED to type-only", () => {
  const reactor = getSliceBoundaryConfig("reactor")

  test("FIRES: a VALUE import of @/agent from @/reactor is denied (the lock)", () => {
    // `agent-outcome-adapter.ts` carries `import type { AgentOutcome }` — the AST
    // scanner skips type-only, so the suite is green. But a VALUE import of
    // @/agent (a runtime coupling) must be denied so the edge cannot silently
    // widen. The reactor deny-list includes @/agent for exactly this.
    expect(isImportDeniedByConfig("@/agent", reactor)).toBe(true)
  })

  test("CLEAN: @/shared (its real runtime dep) is NOT denied", () => {
    expect(isImportDeniedByConfig("@/shared", reactor)).toBe(false)
  })
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
