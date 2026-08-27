import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import allowlist from "../../tools/god-code/allowlist.json"
import {
  APPROACHING_MODULE_BAND,
  approachingBandBounds,
  detectGodFunctions,
  detectGodModules,
  GOD_FUNCTION_MAX_LINES,
  GOD_MODULE_MAX_LINES,
  type SourceFile,
} from "../../tools/god-code/detect"

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
  const currentFunctions = new Set(
    detectGodFunctions(files, GOD_FUNCTION_MAX_LINES).map((f) => f.key),
  )
  // `new Set<string>(...)`: the `modules` allowlist is now empty (the last
  // grandfathered god-module — src/lsp/adapters/base.ts — was split out), which
  // TypeScript's JSON-import inference narrows to `never[]`; widen so the
  // `.has(f)` membership test below still typechecks against string keys.
  const allowModules = new Set<string>(allowlist.modules)
  const allowFunctions = new Set<string>(allowlist.functions)

  test("thresholds match the frozen allowlist (config drift guard)", () => {
    expect(allowlist.godModuleMaxLines).toBe(GOD_MODULE_MAX_LINES)
    expect(allowlist.godFunctionMaxLines).toBe(GOD_FUNCTION_MAX_LINES)
    // The cohort band is detector CONFIG like the two thresholds above, so it
    // gets the same code twin + drift guard. (`max` is deliberately NOT pinned:
    // it is the ratchet value and must be able to move down.)
    expect(allowlist.approachingModuleCeiling.band).toEqual([...APPROACHING_MODULE_BAND])
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

  test("allowlist entries are UNIQUE (a duplicate grandfather would silently double-count / mask a swap)", () => {
    const dupes = (arr: readonly string[]): string[] =>
      [...new Set(arr.filter((v, i) => arr.indexOf(v) !== i))].sort()
    expect(dupes(allowlist.functions)).toEqual([])
    expect(dupes(allowlist.modules)).toEqual([])
  })

  // The cohort test below reads its band out of the very artifact it polices.
  // The old reader defaulted a missing bound to 0 (`band[0] ?? 0`), so setting
  // `"band": []` gave lo=hi=0, matched no file, and the ceiling PASSED while
  // measuring nothing — mutation-proven: 7 pass / 0 fail with an empty band.
  // The bounds now come from code and a degenerate band is refused, not
  // silently collapsed to an empty window.
  test("a degenerate cohort band FAILS CLOSED instead of silently emptying the cohort", () => {
    // Paired control: the honest band is accepted and is what the JSON mirrors.
    expect(approachingBandBounds([...APPROACHING_MODULE_BAND])).toEqual([900, 999])
    expect(approachingBandBounds(allowlist.approachingModuleCeiling.band)).toEqual([900, 999])
    // Every shape that used to disarm the ceiling now throws.
    for (const degenerate of [[], [900], [900, 999, 1200], [999, 900], [900, 900]]) {
      expect(() => approachingBandBounds(degenerate)).toThrow(/band must be a \[lo, hi\] pair/)
    }
    // ...and it was a REAL disarm: under the old defaulting read, an empty band
    // selected zero of the >1000 files walked below.
    const vacuous = files.filter((f) => {
      const lines = f.text.split("\n").length
      return lines >= 0 && lines <= 0
    })
    expect(vacuous).toEqual([])
  })

  // aug-23 audit — COHORT ceiling. The 1000-line gate above caps an INDIVIDUAL
  // module, but nothing capped the population walking up to it: a file may grow
  // to 999 freely, so every split this campaign lands is undone by the next
  // feature. Measured over one day of commits the 900-999 band went 30 -> 27
  // with six members ADVANCING (`runtime-factory` 989->999,
  // `bootstrap-session` 988->999, `objective/store` 876->905 as a new entrant).
  // Splitting without this is a treadmill.
  //
  // One-directional, same contract as the allowlist: a new entrant fails the
  // build — split one and LOWER the number. It never gets raised.
  test("the 900-999 approaching cohort does not grow", () => {
    const band = allowlist.approachingModuleCeiling
    // JSON import widens the tuple to `number[]`; read the bounds through the
    // fail-closed reader in detect.ts rather than defaulting them to 0, which
    // would turn a malformed band into a cohort of nothing that always passes.
    const [lo, hi] = approachingBandBounds(band.band)
    const approaching = files
      .map((f) => ({ file: f.path, lines: f.text.split("\n").length }))
      .filter((m) => m.lines >= lo && m.lines <= hi)
      .sort((a, b) => b.lines - a.lines)
    // Anti-vacuity: the walk must have actually read the tree.
    expect(files.length).toBeGreaterThan(1000)
    if (approaching.length > band.max) {
      throw new Error(
        `${approaching.length} modules are in the ${lo}-${hi} band (ceiling ${band.max}). ` +
          "Split one and LOWER the ceiling; never raise it. Closest to the hard gate:\n" +
          approaching
            .slice(0, 8)
            .map((m) => `  ${m.lines}  ${m.file}`)
            .join("\n"),
      )
    }
    expect(approaching.length).toBeLessThanOrEqual(band.max)
  })
})
