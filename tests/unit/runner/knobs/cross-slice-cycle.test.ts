/**
 * Hellgate — cross-slice import cycle + slice-fence verification.
 *
 * `src/runner/knobs/` must not depend on `src/runner/batch/` (modulo
 * type-only imports). Each per-knob file under `src/runner/knobs/knobs/`
 * must not depend on a SIBLING knob file (slice isolation). The framework
 * core (registry/resolve/apply/validate/persist/presets/types) must form a
 * DAG within the slice.
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

  test("per-knob files have no value-level batch import", async () => {
    const files = await readdir(PER_KNOB_DIR)
    for (const f of files) {
      if (!f.endsWith(".ts")) continue
      const txt = await readSrc(join(PER_KNOB_DIR, f))
      const valueImport = /^import\s+(?!type\b)[^"']*from\s+["']@\/runner\/batch/m
      expect(valueImport.test(txt)).toBe(false)
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

  test("the side-effect barrel imports every per-knob file but no other", async () => {
    const txt = await readSrc(join(PER_KNOB_DIR, "index.ts"))
    // 13 imports of "./<knob>" (12 bench/agent knobs + ADR-0429 advisor).
    const sideImports = txt.match(/import\s+["']\.\/[^"']+["']/g) ?? []
    expect(sideImports.length).toBe(13)
    // No `from "../"` (would break the barrel contract).
    expect(/from\s+["']\.\.\//.test(txt)).toBe(false)
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
  test("issue-hint.ts uses type-only imports for @/runner/batch (if any)", async () => {
    const txt = await readSrc(join(PER_KNOB_DIR, "issue-hint.ts"))
    const valueBatchImport = /^import\s+(?!type\b)[^"']*from\s+["']@\/runner\/batch/m
    expect(valueBatchImport.test(txt)).toBe(false)
  })
})
