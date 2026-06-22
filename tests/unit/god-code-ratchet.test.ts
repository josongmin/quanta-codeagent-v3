import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import {
  detectGodFunctions,
  detectGodModules,
  GOD_FUNCTION_MAX_LINES,
  GOD_MODULE_MAX_LINES,
  type SourceFile,
} from "../../tools/god-code/detect"
import allowlist from "../../tools/god-code/allowlist.json"

// SE-metric ratchet: keep god-code from GROWING. A god-MODULE (file > 1000 lines)
// or god-FUNCTION (body > 150 lines) that is NOT grandfathered in allowlist.json
// fails the build — split it. And an allowlist entry that no longer violates must
// be REMOVED (the ratchet only goes down). God-function COMPLEXITY is separately
// gated by biome (noExcessiveCognitiveComplexity=15); this covers SIZE.

const REPO = join(import.meta.dir, "..", "..")

const walkSrc = (dir: string): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walkSrc(p))
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) out.push(p)
  }
  return out
}

const sourceFiles = (): readonly SourceFile[] =>
  walkSrc(join(REPO, "src")).map((abs) => ({
    path: abs.slice(REPO.length + 1), // repo-relative, stable across machines
    text: readFileSync(abs, "utf8"),
  }))

describe("god-code ratchet (SE size metric)", () => {
  const files = sourceFiles()
  const currentModules = new Set(detectGodModules(files, GOD_MODULE_MAX_LINES).map((m) => m.file))
  const currentFunctions = new Set(detectGodFunctions(files, GOD_FUNCTION_MAX_LINES).map((f) => f.key))
  const allowModules = new Set(allowlist.modules)
  const allowFunctions = new Set(allowlist.functions)

  test("thresholds match the frozen allowlist (config drift guard)", () => {
    expect(allowlist.godModuleMaxLines).toBe(GOD_MODULE_MAX_LINES)
    expect(allowlist.godFunctionMaxLines).toBe(GOD_FUNCTION_MAX_LINES)
  })

  test(`NO NEW god-MODULE (>${GOD_MODULE_MAX_LINES} lines) — split it, do not allowlist`, () => {
    const fresh = [...currentModules].filter((f) => !allowModules.has(f)).sort()
    expect(fresh).toEqual([])
  })

  test(`NO NEW god-FUNCTION (body >${GOD_FUNCTION_MAX_LINES} lines) — split it, do not allowlist`, () => {
    const fresh = [...currentFunctions].filter((k) => !allowFunctions.has(k)).sort()
    expect(fresh).toEqual([])
  })

  test("allowlist has NO STALE module (ratchet only goes DOWN — remove fixed entries)", () => {
    const stale = [...allowModules].filter((f) => !currentModules.has(f)).sort()
    expect(stale).toEqual([])
  })

  test("allowlist has NO STALE function (ratchet only goes DOWN — remove fixed entries)", () => {
    const stale = [...allowFunctions].filter((k) => !currentFunctions.has(k)).sort()
    expect(stale).toEqual([])
  })
})
