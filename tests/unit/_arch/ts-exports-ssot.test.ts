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
import ts from "typescript"
import { extractExports } from "../../../tools/arch-gen/scan-slices"
import { extractExportedSymbols } from "../../../tools/dev/merge-symbol-loss"
import { parseSymbols } from "../../../tools/feature-catalog/reachability"
import { assertScanPopulation } from "../_shared/scan-population"

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

const discoverTsExportsConsumers = async (): Promise<readonly string[]> => {
  const found: string[] = []
  // The PATTERN is relative and the ROOT is explicit. A repo-rooted pattern
  // (`"tools/**/*.ts"`) only matches when the suite is launched from the repo
  // root, and a derivation that silently matches nothing would make both loops
  // below pass while measuring nothing — the exact shape this file exists to
  // police, and what the repo-path-anchor ratchet caught here.
  const toolsRoot = join(REPO_ROOT, "tools")
  const raw: string[] = []
  for await (const name of new Glob("**/*.ts").scan({ cwd: toolsRoot })) {
    const rel = `tools/${name}`
    raw.push(join(toolsRoot, name))
    if (rel === SSOT_MODULE || rel.includes("/.scratch/") || rel.includes("node_modules")) continue
    // Matches `from "../shared/ts-exports"` at any relative depth, which is how
    // all three consumers reach it; `import type` and re-export forms included.
    if (/from\s+"[^"]*\/shared\/ts-exports"/.test(await readSrc(rel))) found.push(rel)
  }
  assertScanPopulation(raw, toolsRoot, {
    id: "tests/unit/_arch/ts-exports-ssot.test.ts#TOOLS",
    matched: found.map((file) => join(REPO_ROOT, file)),
  })
  return found.sort()
}

let tsExportsConsumerCache: Promise<readonly string[]> | undefined
const tsExportsConsumers = (): Promise<readonly string[]> =>
  (tsExportsConsumerCache ??= discoverTsExportsConsumers())

/* ── AST readers used by the structural arms ─────────────────────────────── */

/**
 * Every regex in `source` whose PATTERN mentions `export`, read from the AST so
 * the spelling of the regex is irrelevant.
 *
 * WHY AST. The previous detector was the shape literal `/\/\^?export\\?s/`,
 * which is a hand-written list of one spelling wearing the costume of a rule.
 * Measured 2026-08-28 against five ways to write the same private export reader:
 * it CAUGHT `/^export\s+(?:const|function)/` and MISSED `/^\s*export\s+/`,
 * `/\bexport\s+const\b/`, `/^ *export +(const|let)/` and
 * `new RegExp("^export\\s+")`. One in five. Reading `RegularExpressionLiteral`
 * nodes and `RegExp(...)` arguments catches all five and does not care how the
 * character class is spelled.
 *
 * THE ONE EXEMPTION, and why it is not a shape list: a regex that mentions BOTH
 * `export` and `from` is reading a module SPECIFIER (`export … from "x"`), not
 * an export NAME. `tools/feature-catalog/reachability.ts` legitimately carries
 * exactly one such regex for the IMPORT side, which is a different question
 * from "what does this file export" and is not the SSOT's job.
 *
 * WHAT THIS STILL CANNOT SEE, stated plainly rather than implied away: a
 * reimplementation that uses no regex at all — `source.split("\n").filter((l) =>
 * l.startsWith("export "))` — is INVISIBLE to this arm. That gap is uncovered.
 * The binding arm below is what makes such a consumer fail, and only if it also
 * stops importing the SSOT.
 */
const exportNameRegexes = (source: string): string[] => {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const consider = (pattern: string, rendered: string): void => {
    if (!/export/.test(pattern)) return
    if (/from/.test(pattern)) return // specifier reader, not an export-name reader
    hits.push(rendered)
  }
  const visit = (n: ts.Node): void => {
    if (ts.isRegularExpressionLiteral(n)) consider(n.text, n.text)
    if (
      (ts.isNewExpression(n) || ts.isCallExpression(n)) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "RegExp"
    ) {
      const arg = n.arguments?.[0]
      if (arg && ts.isStringLiteralLike(arg))
        consider(arg.text, `RegExp(${JSON.stringify(arg.text)})`)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hits
}

/**
 * The VALUE names `source` binds from the SSOT module — types excluded.
 *
 * Type-only bindings are excluded deliberately: a consumer that keeps
 * `import type { ModuleExports } from "../shared/ts-exports"` while rolling its
 * own reader still contains the string `ts-exports`, which is precisely how the
 * old assertion managed to be unfalsifiable. Binding a FUNCTION is the thing
 * that cannot be faked by a leftover import line.
 */
const valueNamesOf = (
  elements: readonly (ts.ImportSpecifier | ts.ExportSpecifier)[],
): readonly string[] =>
  elements.filter((el) => !el.isTypeOnly).map((el) => (el.propertyName ?? el.name).text)

const bindsSsot = (spec: ts.Expression | undefined): boolean =>
  spec !== undefined && ts.isStringLiteral(spec) && /\/shared\/ts-exports$/.test(spec.text)

/** The clause of one statement, IF that statement binds from the SSOT module. */
const ssotClauseNames = (st: ts.Statement): readonly string[] => {
  if (ts.isImportDeclaration(st)) {
    const clause = st.importClause
    if (!bindsSsot(st.moduleSpecifier) || !clause || clause.isTypeOnly) return []
    const bindings = clause.namedBindings
    return bindings && ts.isNamedImports(bindings) ? valueNamesOf(bindings.elements) : []
  }
  if (!ts.isExportDeclaration(st)) return []
  const clause = st.exportClause
  if (!bindsSsot(st.moduleSpecifier) || st.isTypeOnly || !clause || !ts.isNamedExports(clause)) {
    return []
  }
  return valueNamesOf(clause.elements)
}

const ssotValueBindings = (source: string): string[] => {
  const sf = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true)
  return [...new Set(sf.statements.flatMap((st) => ssotClauseNames(st)))]
}

/** The SSOT's own exported VALUES, derived from the SSOT source — never listed. */
const ssotValueExports = (source: string): Set<string> => {
  const sf = ts.createSourceFile("ts-exports.ts", source, ts.ScriptTarget.Latest, true)
  const names = new Set<string>()
  const exported = (n: ts.Node): boolean =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && exported(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) names.add(d.name.text)
      }
    }
    if (ts.isFunctionDeclaration(st) && exported(st) && st.name) names.add(st.name.text)
  }
  return names
}

describe("export extraction SSOT — one implementation only", () => {
  // ANTI-VACUITY FLOOR — not the population, a check that the derivation did not
  // collapse. If the glob breaks or the import shape changes, `consumers` goes
  // empty and every `for` loop below passes while measuring nothing. These three
  // are known to import the SSOT today; losing one is a real event that should
  // fail loudly rather than silently shrink what is policed.
  //
  // Each loop arm below ALSO carries its own floor. This sibling test is not
  // enough: it fails on its own while the loops stay green having asserted
  // nothing, so a reader sees "1 fail" and three passes over an empty set.
  // Measured 2026-08-28 by forcing the derivation to `[]` — both loop arms below
  // reported `1 pass`, one of them with zero expect() calls.
  test("the derived consumer set is non-empty and covers every known consumer", async () => {
    const consumers = await tsExportsConsumers()
    expect(consumers).toContain("tools/arch-gen/scan-slices.ts")
    expect(consumers).toContain("tools/feature-catalog/reachability.ts")
    // The consumer the hand-written list missed.
    expect(consumers).toContain("tools/dev/merge-symbol-loss.ts")
    expect(consumers.length).toBeGreaterThanOrEqual(3)
  })

  test("no consumer carries its own export-name regex", async () => {
    const consumers = await tsExportsConsumers()
    expect(consumers.length).toBeGreaterThanOrEqual(3) // OWN floor — see above.
    const offenders: string[] = []
    for (const rel of consumers) {
      // A private export-name regex is exactly what drifted. The SSOT module is
      // the only place allowed to decide what an export is.
      for (const hit of exportNameRegexes(await readSrc(rel))) offenders.push(`${rel}: ${hit}`)
    }
    expect(offenders.join("\n")).toBe("")
  })

  test("PAIRED CONTROL: the detector catches every spelling of a private export regex", () => {
    // The five spellings measured against the old shape literal, which caught
    // the first and missed the rest. All five must be seen.
    const spellings = [
      String.raw`const R = /^export\s+(?:const|function)/`,
      String.raw`const R = /^\s*export\s+/`,
      String.raw`const R = /\bexport\s+const\b/`,
      "const R = /^ *export +(const|let)/", // no escapes here, so no String.raw
      String.raw`const R = new RegExp("^export\\s+")`,
    ]
    const missed = spellings.filter((src) => exportNameRegexes(src).length === 0)
    expect(missed).toEqual([])
  })

  test("PAIRED CONTROL: the detector does NOT fire on a module-specifier regex", () => {
    // Without this, the arm above would still pass if the detector flagged every
    // regex in existence — and it would red the one legitimate import-side
    // scanner in `reachability.ts`.
    const specifierReader = String.raw`const R = /(?:import\s[\s\S]*?from\s+|export\s[\s\S]*?from\s+)["']([^"']+)["']/g`
    expect(exportNameRegexes(specifierReader)).toEqual([])
    expect(exportNameRegexes("const R = /^\\s*$/")).toEqual([])
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

  test("every consumer BINDS a reader function from the SSOT, not merely its path", async () => {
    // WHAT THIS REPLACED. The arm used to be `expect(source).toContain("ts-exports")`
    // over a population selected by `/from\s+"[^"]*\/shared\/ts-exports"/`. Every
    // member necessarily contained the substring, so the assertion restated its
    // own selection predicate and NO edit to any consumer could redden it.
    //
    // The falsifiable question is which SYMBOL the consumer binds: a consumer
    // that keeps a type-only import (or an unused path) while reimplementing the
    // reader is still a member of the population, but binds no reader function
    // and fails here.
    const readers = ssotValueExports(await readSrc(SSOT_MODULE))
    expect(readers.size).toBeGreaterThan(0) // the SSOT itself must export values
    const consumers = await tsExportsConsumers()
    expect(consumers.length).toBeGreaterThanOrEqual(3) // OWN floor — see above.
    const detached: string[] = []
    for (const rel of consumers) {
      const bound = ssotValueBindings(await readSrc(rel))
      if (!bound.some((name) => readers.has(name))) {
        detached.push(
          `${rel}: binds ${JSON.stringify(bound)} from the SSOT, none of which is a reader ` +
            `(${[...readers].sort().join(", ")}) — it reaches the module by path only`,
        )
      }
    }
    expect(detached.join("\n")).toBe("")
  })

  test("PAIRED CONTROL: a type-only consumer is REPORTED as not binding a reader", () => {
    // The exact shape the old tautology waved through: the path is still there,
    // the reader is not.
    const readers = new Set(["parseModuleExports", "extractExportedSymbols"])
    const typeOnly = 'import type { ModuleExports } from "../shared/ts-exports"'
    expect(ssotValueBindings(typeOnly).some((n) => readers.has(n))).toBe(false)
    // ...and the honest shapes are still accepted, so this is not a blanket red.
    const real = 'import { extractExportedSymbols } from "../shared/ts-exports"'
    expect(ssotValueBindings(real).some((n) => readers.has(n))).toBe(true)
    const reexport = 'export { parseModuleExports } from "../shared/ts-exports"'
    expect(ssotValueBindings(reexport).some((n) => readers.has(n))).toBe(true)
  })
})
