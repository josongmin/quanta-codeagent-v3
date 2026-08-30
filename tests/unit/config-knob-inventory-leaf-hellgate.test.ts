/**
 * CONFIG-LEAF FENCE ratchet — src/config/knob-inventory MUST NOT import @/runner.
 *
 * The knob-inventory layer (the hand-maintained `BENCH` literal + its
 * `KnobInventoryEntry` types) is a LEAF: the assemble/runner layer DERIVES from
 * config (runner→config is a FORWARD edge), never the reverse. A previous step
 * cut the inventory over to DERIVE from `KnobSchema`s that lived in config/ and
 * imported the live `@/runner/knobs/knobs/*` `parse` functions — a config→runner
 * BACK-edge (fence violation) that also duplicated parse declarations. The
 * schemas now live in the runner kernel (src/runner/batch/eval/kernel/schemas,
 * same slice as the live knobs ⇒ no fence, no dup) and the inventory is a
 * hand-maintained literal again, proven-equivalent by the derive-parity tests.
 *
 * RULE (exact, count 0): NO file under src/config/knob-inventory/ may import
 * from `@/runner` (any sub-path). Scans ACTUAL import statements (not comments),
 * so it is red-on-injection: drop a real `import … from "@/runner/…"` into any
 * inventory file and this fails. Comment mentions of `@/runner` (the layering
 * notes) do NOT trip it.
 */

import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { assertScanPopulation } from "./_shared/scan-population"

const INVENTORY_DIR = join(import.meta.dir, "..", "..", "src", "config", "knob-inventory")
const KNOB_SCHEMA_DIR = join(import.meta.dir, "..", "..", "src", "config", "knob-schema")

/** Recursively collect every .ts file under a directory. */
const collectTsFiles = (dir: string): string[] => {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) {
      out.push(...collectTsFiles(abs))
    } else if (name.endsWith(".ts")) {
      out.push(abs)
    }
  }
  return out
}

/**
 * Pure detector — returns the offending (file, importLine) pairs. Reused by the
 * red-on-injection self-test. Matches only real ES `import`/`export … from`
 * statements (and dynamic `import("…")`) whose specifier starts with `@/runner`;
 * a `@/runner` mention inside a `//`/`/* *​/` comment or a string literal that is
 * not an import specifier does NOT match.
 */
const findLayerImports = (
  files: ReadonlyArray<{ path: string; source: string }>,
  prefix: string,
): Array<{ path: string; line: string }> => {
  const hits: Array<{ path: string; line: string }> = []
  // import ... from "<prefix>..."  |  export ... from "<prefix>..."  |  import("<prefix>...")
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const fromRe = new RegExp(`(?:^|\\s)(?:import|export)\\b[^\\n]*\\bfrom\\s*["']${esc}(?:\\/|["'])`)
  const dynRe = new RegExp(`\\bimport\\s*\\(\\s*["']${esc}(?:\\/|["'])`)
  for (const { path, source } of files) {
    for (const rawLine of source.split("\n")) {
      const line = rawLine.trim()
      if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue
      if (fromRe.test(rawLine) || dynRe.test(rawLine)) {
        hits.push({ path, line })
      }
    }
  }
  return hits
}

/** Back-compat alias — the original `@/runner`-only detector. */
const findRunnerImports = (
  files: ReadonlyArray<{ path: string; source: string }>,
): Array<{ path: string; line: string }> => findLayerImports(files, "@/runner")

describe("config/knob-inventory stays a leaf (no @/runner back-edge)", () => {
  const files = collectTsFiles(INVENTORY_DIR).map((path) => ({
    path,
    source: readFileSync(path, "utf8"),
  }))

  test("scans a non-trivial set of inventory files", () => {
    assertScanPopulation(
      files.map((file) => file.path),
      INVENTORY_DIR,
      { id: "tests/unit/config-knob-inventory-leaf-hellgate.test.ts#INVENTORY" },
    )
    // Guards against the detector silently scanning zero files (a moved/renamed dir).
    expect(files.length).toBeGreaterThan(3)
  })

  test("NO inventory file imports from @/runner (count 0)", () => {
    const hits = findRunnerImports(files)
    expect(hits).toEqual([])
  })

  test("red-on-injection: detector catches a real @/runner import", () => {
    const injected = [
      {
        path: "<injected>/bench.ts",
        source: [
          "// layering note: the assemble layer (@/runner) DERIVES from this — comment only",
          'import { lspKnob } from "@/runner/knobs/knobs/lsp"',
          "export const X = lspKnob",
        ].join("\n"),
      },
    ]
    const hits = findRunnerImports(injected)
    expect(hits.length).toBe(1)
    expect(hits[0]?.line).toContain('"@/runner/knobs/knobs/lsp"')
  })

  test("does NOT trip on a comment-only @/runner mention", () => {
    const benign = [
      {
        path: "<benign>/notes.ts",
        source: [
          " * Precedence on collision: @/runner/knobs (richest) wins.",
          "// would become an AgentConfig-mutating @/runner/knobs Knob",
          'import type { KnobInventoryEntry } from "./types"',
        ].join("\n"),
      },
    ]
    expect(findRunnerImports(benign)).toEqual([])
  })
})

describe("config/knob-schema stays a TRUE leaf (no @/runner, no @/agent back-edge)", () => {
  // The schema SSOT (contracts + schemas + derive-inventory) was relocated INTO
  // the config leaf so the inventory can DERIVE from it without a config→runner
  // back-edge. For that to hold, the knob-schema dir must itself be a leaf: it
  // may import @/config (forward/sibling) but NOT @/runner or @/agent (the
  // assemble/runtime layers that derive FROM it). This guards the relocation.
  const files = collectTsFiles(KNOB_SCHEMA_DIR).map((path) => ({
    path,
    source: readFileSync(path, "utf8"),
  }))

  test("scans a non-trivial set of knob-schema files", () => {
    assertScanPopulation(
      files.map((file) => file.path),
      KNOB_SCHEMA_DIR,
      { id: "tests/unit/config-knob-inventory-leaf-hellgate.test.ts#SCHEMA" },
    )
    // Guards against the detector silently scanning zero files (a moved/renamed dir).
    expect(files.length).toBeGreaterThan(3)
  })

  test("NO knob-schema file imports from @/runner (count 0)", () => {
    expect(findLayerImports(files, "@/runner")).toEqual([])
  })

  test("NO knob-schema file imports from @/agent (count 0)", () => {
    expect(findLayerImports(files, "@/agent")).toEqual([])
  })

  test("red-on-injection: detector catches a real @/agent import", () => {
    const injected = [
      {
        path: "<injected>/schemas/bench-gap-1.ts",
        source: [
          "// note: deriveKnob (the runner half) consumes @/agent — comment only",
          'import type { AgentConfig } from "@/agent"',
          "export const X = 1",
        ].join("\n"),
      },
    ]
    const hits = findLayerImports(injected, "@/agent")
    expect(hits.length).toBe(1)
    expect(hits[0]?.line).toContain('"@/agent"')
  })
})
