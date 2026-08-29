/**
 * Hellgate — cross-slice import cycle + slice-fence verification.
 *
 * `src/runner/knobs/` must not depend on `src/runner/batch/` (modulo type-only
 * imports) — with ONE sanctioned exception: the knob=schema unification makes
 * each per-knob file DERIVE its registry Knob from the schema SSOT via
 * `deriveKnob` (`@/runner/batch/eval/kernel/derive`). That ONE value import is the
 * SSOT derive primitive; every OTHER value import into `@/runner/batch` is still
 * banned. Each per-knob file under `src/runner/knobs/knobs/` must not depend on a
 * SIBLING knob file (slice isolation). The framework core
 * (registry/resolve/apply/validate/persist/presets/types) must form a DAG.
 *
 * We assert via filesystem inspection — read each file and verify forbidden
 * `import` patterns are absent. The set is narrow and explicit; new
 * dependencies must add a row here.
 */
import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const KNOBS_DIR = join(REPO_ROOT, "src", "runner", "knobs")
const PER_KNOB_DIR = join(KNOBS_DIR, "knobs")

const readSrc = (p: string) => readFile(p, "utf8")

/** The ONE sanctioned value import into `@/runner/batch` from the knob slice:
 *  the `deriveKnob` SSOT derive primitive (knob=schema unification). */
const DERIVE_IMPORT = "@/runner/batch/eval/kernel/derive"
/** A value import into `@/runner/batch` that is NOT the sanctioned derive SSOT. */
const forbiddenBatchValueImport = (txt: string): boolean =>
  txt
    .split("\n")
    .filter((l) => /^import\s+(?!type\b)[^"']*from\s+["']@\/runner\/batch/.test(l))
    .some((l) => !l.includes(DERIVE_IMPORT))

describe("hellgate / cross-slice — runner/knobs DOES NOT import runner/batch (value-level)", () => {
  test("framework core files have no value-level batch import", async () => {
    const cores = [
      "types.ts",
      "registry.ts",
      "resolve.ts",
      "apply.ts",
      "validate.ts",
      "persist.ts",
      "presets.ts",
      "index.ts",
    ]
    for (const f of cores) {
      const txt = await readSrc(join(KNOBS_DIR, f))
      // type-only imports look like `import type { ... } from "@/runner/batch/..."`
      // — we permit those; ban value imports.
      const valueImport = /^import\s+(?!type\b)[^"']*from\s+["']@\/runner\/batch/m
      expect(valueImport.test(txt)).toBe(false)
    }
  })

  test("per-knob files have no value-level batch import EXCEPT the deriveKnob SSOT", async () => {
    const files = await readdir(PER_KNOB_DIR)
    // The verdict is a LOOP BODY, and an empty listing runs it zero times: the
    // test then passes having asserted nothing, which reads exactly like "no
    // per-knob file imports batch at value level". The floor is derived from the
    // real corpus (68 modules today), not a token `> 0`, so a walk that reaches
    // a fraction of the tree fails here instead of reporting clean.
    const modules = files.filter((f) => f.endsWith(".ts"))
    expect(
      modules.length,
      `only ${modules.length} per-knob module(s) were listed — the ban below would ` +
        `pass over a listing that never happened`,
    ).toBeGreaterThanOrEqual(60)
    for (const f of modules) {
      const txt = await readSrc(join(PER_KNOB_DIR, f))
      // The ONLY permitted runner/batch value import is the `deriveKnob` SSOT
      // (knob=schema unification); any other batch value import is still banned.
      expect(forbiddenBatchValueImport(txt)).toBe(false)
    }
  })
})

describe("hellgate / cross-slice — per-knob files do NOT import each other", () => {
  test("each per-knob file imports no other per-knob file under src/runner/knobs/knobs/", async () => {
    const files = await readdir(PER_KNOB_DIR)
    const knobFiles = files.filter((f) => f.endsWith(".ts") && f !== "index.ts")
    for (const f of knobFiles) {
      const txt = await readSrc(join(PER_KNOB_DIR, f))
      // Match any value or type import that points into the SAME directory.
      const siblingImport = /from\s+["']\.\/(?!\.\.\/)/g
      const matches = txt.match(siblingImport)
      // Allow imports of ../registry, ../types — those start with "../", not "./"
      expect(matches).toBeNull()
    }
  })

  test("the barrel registers all knobs centrally + side-effect-imports only NON-schema knobs", async () => {
    // Post knob=schema unification: schema-backed bench knobs register CENTRALLY
    // via `registerBenchKnobs()` (derived from `ALL_BENCH_SCHEMAS`), so the barrel
    // no longer hand-imports each one. The only `import "./<knob>"` side-effects
    // left are the NON-schema, self-registering cross-surface knobs. The drift
    // guard that "no knob is silently missing" now lives in knobs-import-bundle.
    const txt = await readSrc(join(PER_KNOB_DIR, "index.ts"))
    // Central registration is wired.
    expect(txt).toContain("registerBenchKnobs")
    const sideImports = txt.match(/import\s+["']\.\/[^"']+["']/g) ?? []
    const files = await readdir(PER_KNOB_DIR)
    const knobFileCount = files.filter((f) => f.endsWith(".ts") && f !== "index.ts").length
    // Strictly FEWER side-effect imports than knob files (the schema-backed ones
    // are registered centrally, not hand-imported) — and at least one remains
    // (the non-schema self-registering knobs).
    expect(sideImports.length).toBeGreaterThan(0)
    expect(sideImports.length).toBeLessThan(knobFileCount)
    // Every side-effect-imported file exists and is itself a self-registering
    // (NON-schema) knob — i.e. it still calls `registerKnob` (NOT thin-derived).
    for (const imp of sideImports) {
      const rel = (imp.match(/import\s+["']\.\/([^"']+)["']/) as RegExpMatchArray)[1]
      const knobTxt = await readSrc(join(PER_KNOB_DIR, `${rel}.ts`))
      expect(knobTxt).toContain("registerKnob")
    }
  })
})

describe("hellgate / cross-slice — knob framework DAG within the slice", () => {
  test("registry.ts depends ONLY on ./types", async () => {
    const txt = await readSrc(join(KNOBS_DIR, "registry.ts"))
    const imports = txt.match(/from\s+["']([^"']+)["']/g) ?? []
    for (const m of imports) {
      // type-only and value imports both should reference only "./types".
      expect(m).toMatch(/from\s+["']\.\/types["']/)
    }
  })

  test("apply.ts depends on ./types + @/agent only", async () => {
    const txt = await readSrc(join(KNOBS_DIR, "apply.ts"))
    const imports = txt.match(/from\s+["']([^"']+)["']/g) ?? []
    for (const m of imports) {
      expect(m).toMatch(/from\s+["'](\.\/types|@\/agent)["']/)
    }
  })

  test("validate.ts depends ONLY on ./types", async () => {
    const txt = await readSrc(join(KNOBS_DIR, "validate.ts"))
    const imports = txt.match(/from\s+["']([^"']+)["']/g) ?? []
    for (const m of imports) {
      expect(m).toMatch(/from\s+["']\.\/types["']/)
    }
  })

  test("resolve.ts depends on ./types + ./presets + ./validate only", async () => {
    const txt = await readSrc(join(KNOBS_DIR, "resolve.ts"))
    const imports = txt.match(/from\s+["']([^"']+)["']/g) ?? []
    for (const m of imports) {
      expect(m).toMatch(/from\s+["'](\.\/types|\.\/presets|\.\/validate)["']/)
    }
  })
})

describe("hellgate / cross-slice — index.ts barrel surface stability", () => {
  test("public barrel exports the documented surface", async () => {
    const txt = await readSrc(join(KNOBS_DIR, "index.ts"))
    const required = [
      "applyKnobs",
      "readKnobConfig",
      "writeKnobConfig",
      "KNOB_PRESETS",
      "__resetRegistry",
      "allKnobs",
      "knobsForSurface",
      "registerKnob",
      "resolveKnobs",
      "asAnyKnob",
      "KnobConflictError",
      "KnobMissingRequiredError",
      "KnobParseError",
      "validateKnobs",
    ]
    for (const sym of required) {
      expect(txt).toContain(sym)
    }
  })
})

describe("hellgate / cross-slice — issue-hint type-only fence", () => {
  test("issue-hint.ts imports no @/runner/batch value EXCEPT the deriveKnob SSOT", async () => {
    const txt = await readSrc(join(PER_KNOB_DIR, "issue-hint.ts"))
    // The thin issue-hint knob derives from the schema SSOT via `deriveKnob`
    // (the one sanctioned batch value import); any OTHER batch value import is
    // still banned (no driver/loop value dependency leaking into the slice).
    expect(forbiddenBatchValueImport(txt)).toBe(false)
  })
})
