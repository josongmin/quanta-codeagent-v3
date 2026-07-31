/**
 * PURITY / FENCE guard for the `@/agent/converge` core (jul-3 architecture unification).
 *
 * The whole point of hoisting verify-gate out of `src/apps/terminal/**` is that the converge core is
 * SURFACE-NEUTRAL — reusable by the terminal brain AND the bench driver. That property is only real
 * if the core never reaches BACK into a surface (`@/apps/*`) or the bench slice (`@/runner/*`). This
 * test scans every module under `src/agent/converge/` and fails on such an import — a structural
 * ratchet so a future edit can't silently re-couple the core to a surface.
 *
 * Also pins: the core is PURE (no `process.*` / no top-level IO) and carries NO stale compiled `.js`
 * sibling (a `.js` next to a `.ts` shadows the source — the jul bug class).
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const CORE_DIR = join(import.meta.dir)

const coreFiles = (): string[] =>
  readdirSync(CORE_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))

/** Pure detector — reused by the red-on-injection self-test below. */
const forbiddenImports = (source: string): string[] => {
  const hits: string[] = []
  // @/apps/* (any surface) and @/runner/* (bench slice) are forbidden — the core must not depend on
  // a consumer. `@/stream`, `@/llm`, `@/agent/*` are allowed (the shared agent layer).
  for (const m of source.matchAll(/from\s+["'](@\/(apps|runner)\/[^"']*)["']/g)) {
    const spec = m[1]
    if (spec !== undefined) hits.push(spec)
  }
  return hits
}

describe("@/agent/converge — surface-neutral purity guard", () => {
  test("NO module imports @/apps/* or @/runner/* (the core must not reach a consumer)", () => {
    const offenders: Array<{ file: string; imports: string[] }> = []
    for (const f of coreFiles()) {
      const imports = forbiddenImports(readFileSync(join(CORE_DIR, f), "utf8"))
      if (imports.length > 0) offenders.push({ file: f, imports })
    }
    expect(offenders).toEqual([])
  })

  test("red-on-injection: the detector actually catches a forbidden import", () => {
    expect(forbiddenImports(`import { x } from "@/apps/terminal/brain-mode"`)).toEqual([
      "@/apps/terminal/brain-mode",
    ])
    expect(forbiddenImports(`import { y } from "@/runner/batch/eval/driver"`)).toEqual([
      "@/runner/batch/eval/driver",
    ])
    // allowed layers do NOT trip it
    expect(forbiddenImports(`import type { AgentEvent } from "@/stream"`)).toEqual([])
    expect(forbiddenImports(`import { z } from "@/agent/verify-guard"`)).toEqual([])
  })

  /** Strip block + line comments so a doc line like "no `process.*`" doesn't trip the code scan. */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

  test("PURE: no `process.*` in CODE and no stale compiled `.js` sibling in the core dir", () => {
    for (const f of coreFiles()) {
      const code = stripComments(readFileSync(join(CORE_DIR, f), "utf8"))
      expect(code.includes("process.")).toBe(false) // pure/leaf: no ambient env / IO in code
    }
    const jsSiblings = readdirSync(CORE_DIR).filter((f) => f.endsWith(".js"))
    expect(jsSiblings).toEqual([]) // a .js next to .ts shadows the source (the jul stale-build bug)
  })

  test("red-on-injection: stripComments keeps real code, drops doc mentions", () => {
    expect(stripComments("/* no process.* */ const x = 1").includes("process.")).toBe(false)
    expect(stripComments("const p = process.env.X").includes("process.")).toBe(true)
  })
})
