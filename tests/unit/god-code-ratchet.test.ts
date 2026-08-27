import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import allowlist from "../../tools/god-code/allowlist.json"
import {
  APPROACHING_MODULE_BAND,
  allowlistKeys,
  approachingBandBounds,
  approachingCohortMax,
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
  // Both grandfather lists are read through the TOTAL reader, not spread raw.
  // (They are also both empty today — the last grandfathered god-module,
  // src/lsp/adapters/base.ts, was split out — which TypeScript's JSON-import
  // inference narrows to `never[]`; `allowlistKeys` returns `readonly string[]`,
  // so the `.has(f)` membership tests below typecheck against string keys.)
  const allowModules = new Set(allowlistKeys(allowlist.modules, "modules"))
  const allowFunctions = new Set(allowlistKeys(allowlist.functions, "functions"))

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

  // Every DEGENERATE FORM of a grandfather list gets its own arm. A `Set.has`
  // membership test is silent about an entry that can never match, so a dead
  // entry reads like coverage in review while grandfathering nothing.
  test("a degenerate allowlist ENTRY is refused at the read (one arm per form)", () => {
    const rejected: readonly [string, unknown, "modules" | "functions"][] = [
      ["not an array", {}, "modules"],
      ["null instead of a list", null, "functions"],
      ["a non-string entry", [123], "modules"],
      ["an EMPTY-STRING entry (grandfathers nothing)", [""], "modules"],
      ["a whitespace-only entry", ["   "], "modules"],
      ["a whitespace-padded key (never matches)", [" src/a.ts"], "modules"],
      ["a duplicate grandfather (masks a swap)", ["src/a.ts", "src/a.ts"], "modules"],
      ["a function KEY in the module path list", ["src/a.ts::f"], "modules"],
      ["a bare path in the function key list", ["src/a.ts"], "functions"],
      ["a key with an empty file half", ["::f"], "functions"],
      ["a key with an empty name half", ["src/a.ts::"], "functions"],
    ]
    for (const [form, raw, kind] of rejected) {
      expect(() => allowlistKeys(raw, kind), form).toThrow(/god-code ratchet: allowlist\./)
    }
    // PAIRED CONTROL: the reader is not simply throwing on everything. Honest
    // lists of BOTH kinds pass through unchanged, including the empty list the
    // real allowlist holds today — an empty grandfather list is the ratchet's
    // GOAL state, not a degenerate one.
    expect(allowlistKeys([], "modules")).toEqual([])
    expect(allowlistKeys([], "functions")).toEqual([])
    expect(allowlistKeys(["src/a.ts", "src/b.ts"], "modules")).toEqual(["src/a.ts", "src/b.ts"])
    expect(allowlistKeys(["src/a.ts::f"], "functions")).toEqual(["src/a.ts::f"])
  })

  // `max` is the RATCHET VALUE and is deliberately NOT bounded above: it must be
  // free to move down, and a slack ceiling is a loose setting, not a degenerate
  // one. Only the shape that DISARMS the comparison is refused — `length > NaN`
  // is FALSE, so a non-numeric ceiling passes while measuring nothing.
  test("a degenerate cohort MAX is refused, but a slack one is NOT (the ratchet must move)", () => {
    for (const degenerate of [Number.NaN, "24", null, undefined, -1, 1.5, [24]]) {
      expect(() => approachingCohortMax(degenerate), String(degenerate)).toThrow(
        /max must be a non-negative integer/,
      )
    }
    // PAIRED CONTROL — the guard is NOT satisfiable by freezing `max`. A wildly
    // slack ceiling and a fully-tightened one are both ACCEPTED. If someone adds
    // an upper sanity bound here, this arm goes red on purpose.
    expect(approachingCohortMax(9999)).toBe(9999)
    expect(approachingCohortMax(0)).toBe(0)
    expect(approachingCohortMax(allowlist.approachingModuleCeiling.max)).toBe(
      allowlist.approachingModuleCeiling.max,
    )
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
    // NOTE, deliberate and not a hole: no argument (or an explicit `undefined`)
    // resolves to the CODE default, standard JS default-parameter semantics —
    // it does not throw. A `band` key missing from the JSON therefore falls back
    // to the honest hardcoded window rather than to a window of nothing, and is
    // caught loudly by the drift-guard test above, which compares the JSON's
    // `band` against APPROACHING_MODULE_BAND by value.
    expect(approachingBandBounds()).toEqual([900, 999])
    expect(approachingBandBounds(undefined)).toEqual([900, 999])
    // Every shape that used to disarm the ceiling now throws.
    for (const degenerate of [
      [],
      [900],
      [900, 999, 1200],
      [999, 900],
      [900, 900],
      [Number.NaN, Number.NaN],
      [900, Number.NaN],
      [Number.NaN, 999],
      [0, 1],
      [900.5, 999.5],
      [1200, 1500],
      [-100, 999],
      [900, Number.POSITIVE_INFINITY],
      ["900", "999"],
      [null, null],
      [900, undefined],
      {},
      null,
      "900,999",
    ]) {
      expect(() => approachingBandBounds(degenerate)).toThrow(/band must be a \[lo, hi\] pair/)
    }
    // ...and it was a REAL disarm, not a theoretical one. Compare the two
    // windows over the SAME corpus: the window the old defaulting read produced
    // from `"band": []` (lo=hi=0) selects NOTHING, while the honest window
    // selects a real cohort. That GAP is the disarm.
    //
    // The assertion this replaces was `lines >= 0 && lines <= 0` over the same
    // corpus, which is UNSATISFIABLE (`"".split("\n").length === 1`, so
    // `lines >= 1` always) and therefore returned `[]` for any corpus at all,
    // including an empty one. It could not fail. Each of the three stops below
    // is load-bearing: kill the walk, narrow the honest band to nothing, or let
    // the degenerate window start matching, and this goes red.
    const select = (lo: number, hi: number): readonly SourceFile[] =>
      files.filter((f) => {
        const lines = f.text.split("\n").length
        return lines >= lo && lines <= hi
      })
    expect(files.length).toBeGreaterThan(1000) // the corpus is real
    expect(select(...approachingBandBounds()).length).toBeGreaterThan(0) // honest band selects
    expect(select(0, 0)).toEqual([]) // the disarmed window selects nothing
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
    const max = approachingCohortMax(band.max)
    const approaching = files
      .map((f) => ({ file: f.path, lines: f.text.split("\n").length }))
      .filter((m) => m.lines >= lo && m.lines <= hi)
      .sort((a, b) => b.lines - a.lines)
    // Anti-vacuity: the walk must have actually read the tree.
    expect(files.length).toBeGreaterThan(1000)
    if (approaching.length > max) {
      throw new Error(
        `${approaching.length} modules are in the ${lo}-${hi} band (ceiling ${max}). ` +
          "Split one and LOWER the ceiling; never raise it. Closest to the hard gate:\n" +
          approaching
            .slice(0, 8)
            .map((m) => `  ${m.lines}  ${m.file}`)
            .join("\n"),
      )
    }
    expect(approaching.length).toBeLessThanOrEqual(max)
  })
})
