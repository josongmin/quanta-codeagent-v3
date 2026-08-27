/**
 * SSOT guard — "what does this .ts file export" must have exactly ONE answer.
 *
 * There were THREE implementations of that question:
 *   tools/feature-catalog/reachability.ts::parseSymbols   (regex)
 *   tools/arch-gen/scan-slices.ts::extractExports         (regex)
 *   tools/dev/merge-symbol-loss.ts::extractExportedSymbols (TypeScript AST)
 *
 * They disagreed, and in every sampled case the AST one was right. The two
 * regex readers share a specific, measured defect: they strip `/* … *\/` BEFORE
 * `//` line comments, so a LINE comment that happens to contain `/*`
 * (`resources/*`, `@/runner/assemble/*`) opens a fake block comment that eats
 * everything up to the next `*\/` — 12,016 characters and 237 export names in
 * `src/tool/index.ts` alone.
 *
 * Every fixture below is an adversarial input whose correct answer is obvious
 * by inspection; all three entry points must return it.
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Glob } from "bun"
import { extractExports } from "../../../tools/arch-gen/scan-slices"
import { extractExportedSymbols } from "../../../tools/dev/merge-symbol-loss"
import { parseSymbols } from "../../../tools/feature-catalog/reachability"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

/** The export SURFACE reachability exposes: own declarations + re-exposed names. */
const reachabilitySurface = (source: string): string[] =>
  [
    ...new Set([
      ...parseSymbols(source).ownExports,
      ...parseSymbols(source).reexports.map((r) => r.exposed),
    ]),
  ].sort()

const astSurface = (source: string): string[] => [...extractExportedSymbols(source)].sort()

const scanSlicesSurface = (source: string): string[] => [...extractExports(source)].sort()

interface Fixture {
  readonly name: string
  readonly source: string
  readonly expected: readonly string[]
}

const FIXTURES: readonly Fixture[] = [
  {
    // THE scan-slices defect, minimised: a LINE comment containing `/*`.
    name: "a line comment containing `/*` does not swallow the file",
    source: [
      "// the host adapts a live client over the `resources/*` + `prompts/*` methods.",
      "export const kept = 1",
      "/** a real doc comment */",
      "export const alsoKept = 2",
    ].join("\n"),
    expected: ["alsoKept", "kept"],
  },
  {
    // THE reachability defect: an export-shaped REGEX LITERAL is not an export.
    name: "an export-shaped regex literal is not an export",
    source: [
      "const DETECTORS = {",
      "  typed_config_resolver: /^export const resolveBenchRunConfig\\b/,",
      "  family_profiles: /^export const DATASET_FAMILY_PROFILES\\b/,",
      "}",
      "export const realOne = DETECTORS",
    ].join("\n"),
    expected: ["realOne"],
  },
  {
    // An export-shaped STRING is not an export either.
    name: "an export-shaped string literal is not an export",
    source: ['const tpl = "export const notReal = 1"', "export const real = tpl"].join("\n"),
    expected: ["real"],
  },
  {
    name: "generator and async-generator exports are picked up",
    source: [
      "export function* gen() {}",
      "export async function* asyncGen() {}",
      "export const plain = 1",
    ].join("\n"),
    expected: ["asyncGen", "gen", "plain"],
  },
  {
    name: "`export type { X } from` is a re-exported name",
    source: 'export type { Tooling } from "@/runner/assemble/tooling"',
    expected: ["Tooling"],
  },
  {
    name: "renames expose the OUTER name only",
    source: ["const k = 1", "export { k as l }", 'export { a as b } from "./x"'].join("\n"),
    expected: ["b", "l"],
  },
  {
    name: "`export * as ns from` contributes the namespace name",
    source: 'export * as ns from "./x"',
    expected: ["ns"],
  },
  {
    name: "`export * from` contributes no name",
    source: ['export * from "./x"', "export const only = 1"].join("\n"),
    expected: ["only"],
  },
]

describe("export extraction SSOT — all readers agree on adversarial input", () => {
  for (const fx of FIXTURES) {
    test(`AST: ${fx.name}`, () => {
      expect(astSurface(fx.source)).toEqual([...fx.expected])
    })
    test(`scan-slices: ${fx.name}`, () => {
      expect(scanSlicesSurface(fx.source)).toEqual([...fx.expected])
    })
    test(`reachability: ${fx.name}`, () => {
      expect(reachabilitySurface(fx.source)).toEqual([...fx.expected])
    })
  }
})

// ---------------------------------------------------------------------------
// Real-file regressions. These are the exact files the audit measured.
// ---------------------------------------------------------------------------

const readSrc = async (rel: string): Promise<string> => readFile(join(REPO_ROOT, rel), "utf8")

describe("export extraction SSOT — measured real-file regressions", () => {
  test("src/tool/index.ts: scan-slices sees every export the AST sees", async () => {
    const source = await readSrc("src/tool/index.ts")
    const ast = astSurface(source)
    // The fake block comment used to delete 237 of these.
    expect(ast.length).toBeGreaterThan(400)
    expect(scanSlicesSurface(source)).toEqual(ast)
  })

  test("src/apps/cli/internal.ts: a `/*`-bearing line comment does not hide `Tooling`", async () => {
    const source = await readSrc("src/apps/cli/internal.ts")
    expect(reachabilitySurface(source)).toContain("Tooling")
    expect(astSurface(source)).toContain("Tooling")
  })

  test("src/apps/bench/promax/campaign/owner-audit.ts: regex literals are not exports", async () => {
    const source = await readSrc("src/apps/bench/promax/campaign/owner-audit.ts")
    const surface = reachabilitySurface(source)
    // These names appear ONLY inside `/^export const …\b/` regex literals here.
    for (const hallucinated of [
      "resolveBenchRunConfig",
      "DATASET_FAMILY_PROFILES",
      "buildProMaxOfficialGradeReceipt",
    ]) {
      expect(surface).not.toContain(hallucinated)
    }
  })

  test("src/llm/adapters/anthropic.ts: `export function*` is seen", async () => {
    const source = await readSrc("src/llm/adapters/anthropic.ts")
    expect(reachabilitySurface(source)).toContain("mapRawEvent")
  })
})

// ---------------------------------------------------------------------------
// Structural: there must be ONE implementation, not three.
// ---------------------------------------------------------------------------

/**
 * The consumer population is DERIVED, never hand-listed.
 *
 * It used to be the literal `["tools/arch-gen/scan-slices.ts",
 * "tools/feature-catalog/reachability.ts"]`, written at a moment when a THIRD
 * consumer — `tools/dev/merge-symbol-loss.ts` — was rewired onto the SSOT in
 * the very same commit. It was policed by neither arm. A hand-written
 * population nobody re-derives is the defect this campaign has now hit five
 * times, so the list is computed from the import graph: every `.ts` under
 * `tools/` that imports the SSOT module is a consumer, and a NEW consumer is
 * policed the moment it is written, with nothing to remember to add.
 */
const SSOT_MODULE = "tools/shared/ts-exports.ts"

const tsExportsConsumers = async (): Promise<readonly string[]> => {
  const found: string[] = []
  // The PATTERN is relative and the ROOT is explicit. A repo-rooted pattern
  // (`"tools/**/*.ts"`) only matches when the suite is launched from the repo
  // root, and a derivation that silently matches nothing would make both loops
  // below pass while measuring nothing — the exact shape this file exists to
  // police, and what the repo-path-anchor ratchet caught here.
  const toolsRoot = join(REPO_ROOT, "tools")
  for await (const name of new Glob("**/*.ts").scan({ cwd: toolsRoot })) {
    const rel = `tools/${name}`
    if (rel === SSOT_MODULE || rel.includes("/.scratch/") || rel.includes("node_modules")) continue
    // Matches `from "../shared/ts-exports"` at any relative depth, which is how
    // all three consumers reach it; `import type` and re-export forms included.
    if (/from\s+"[^"]*\/shared\/ts-exports"/.test(await readSrc(rel))) found.push(rel)
  }
  return found.sort()
}

describe("export extraction SSOT — one implementation only", () => {
  // ANTI-VACUITY FLOOR — not the population, a check that the derivation did not
  // collapse. If the glob breaks or the import shape changes, `consumers` goes
  // empty and every `for` loop below passes while measuring nothing. These three
  // are known to import the SSOT today; losing one is a real event that should
  // fail loudly rather than silently shrink what is policed.
  test("the derived consumer set is non-empty and covers every known consumer", async () => {
    const consumers = await tsExportsConsumers()
    expect(consumers).toContain("tools/arch-gen/scan-slices.ts")
    expect(consumers).toContain("tools/feature-catalog/reachability.ts")
    // The consumer the hand-written list missed.
    expect(consumers).toContain("tools/dev/merge-symbol-loss.ts")
    expect(consumers.length).toBeGreaterThanOrEqual(3)
  })

  test("no consumer carries its own export regex", async () => {
    const offenders: string[] = []
    for (const rel of await tsExportsConsumers()) {
      const source = await readSrc(rel)
      // A private export-name regex is exactly what drifted. The SSOT module is
      // the only place allowed to decide what an export is.
      if (/\/\^?export\\?s/.test(source)) offenders.push(`${rel}: own export regex`)
    }
    expect(offenders.join("\n")).toBe("")
  })

  test("reachability reads exports from the RAW source, never the stripped copy", async () => {
    // `stripComments` still exists for the IMPORT side, and it still carries the
    // block-comment-before-line-comment defect. Feeding it into the export
    // reader would re-open exactly the hole this SSOT closed, so pin the call
    // shape: the parser gets `raw`.
    const source = await readSrc("tools/feature-catalog/reachability.ts")
    expect(source).toContain("parseModuleExports(raw)")
    expect(source).not.toContain("parseModuleExports(s)")
  })

  test("every consumer reaches the SSOT by import, not by reimplementation", async () => {
    for (const rel of await tsExportsConsumers()) {
      const source = await readSrc(rel)
      expect(source).toContain("ts-exports")
    }
  })
})
