/**
 * Architecture guard for `@/protocol` — config in `_arch/slice-boundary-configs.ts`.
 * Entrypoint that runs the per-slice boundary suite (paired 1:1 with the config;
 * enforced by tests/unit/slice-boundary-config-parity.test.ts).
 */

import { readFileSync } from "node:fs"
import { relative } from "node:path"
import { describe, expect, test } from "bun:test"
import { getSliceBoundaryConfig } from "./_arch/slice-boundary-configs"
import {
  extractTypeOnlyModuleRefs,
  listSliceTsFiles,
  registerSliceBoundarySuite,
  sliceDir,
} from "./_arch/slice-boundary-scanner"

registerSliceBoundarySuite(getSliceBoundaryConfig("protocol"))

/**
 * P0-B: leaf-slice barrel-avoidance guard (jul-18 종합 어딧 β).
 *
 * The generic per-slice deny-list (above) only scans RUNTIME imports —
 * `extractImports` deliberately skips `import type` (slice purity is a
 * runtime-dependency invariant). But the pure `protocol/session/*` leaf files
 * carry a self-declared discipline in `verb-surface.ts`: this leaf "must never
 * up-import". They only need `ImageBlock` / `Message`, which live in the pure
 * type leaf `src/llm/types.ts`. Importing them through the `@/llm` BARREL
 * (`src/llm/index.ts`, which re-exports adapters / factory / credential-helper)
 * is a type-only cross-barrel edge that risks a real runtime cycle the moment
 * the barrel grows a value-side re-export path.
 *
 * This guard scans TYPE-position module refs (which the deny-list ignores) and
 * forbids the `@/llm` BARREL specifically, while ALLOWING the pure subpath leaf
 * `@/llm/types` and the shared leaf `@/shared`. Byte-for-byte: `@/llm/types`
 * resolves via the existing `"@/llm/*"` tsconfig alias directly to
 * `src/llm/types.ts` (no barrel), so the ImageBlock / Message types are
 * identical — only the import PATH changes.
 */
const isLlmBarrelSpec = (spec: string): boolean => spec === "@/llm"

describe("@/protocol — leaf slice must not up-import the @/llm barrel (type-position)", () => {
  const dir = sliceDir("protocol")

  test("no protocol file type-imports the `@/llm` barrel (use `@/llm/types` leaf)", () => {
    const violations: string[] = []
    for (const f of listSliceTsFiles(dir, false)) {
      for (const { line, spec } of extractTypeOnlyModuleRefs(readFileSync(f, "utf8"))) {
        if (isLlmBarrelSpec(spec)) {
          violations.push(`${relative(dir, f)}:${line}  type-import "${spec}"`)
        }
      }
    }
    if (violations.length > 0) {
      throw new Error(
        "@/protocol leaf must not type-import the `@/llm` heavy barrel; import the pure " +
          `type leaf \`@/llm/types\` (or \`@/shared\`) instead:\n\n${violations.join("\n")}`,
      )
    }
  })

  // Predicate-level guard: proves the ban targets the BARREL exactly and does
  // NOT over-reach to the pure subpath leaf `@/llm/types` (the intended fix
  // path) or the shared leaf `@/shared`. If a refactor tightened the matcher to
  // a `@/llm` PREFIX, this locks the regression: the fix path would then be
  // (wrongly) forbidden too.
  test("barrel matcher targets `@/llm` exactly — leaf subpaths stay allowed", () => {
    expect(isLlmBarrelSpec("@/llm")).toBe(true)
    expect(isLlmBarrelSpec("@/llm/types")).toBe(false)
    expect(isLlmBarrelSpec("@/shared")).toBe(false)
    expect(isLlmBarrelSpec("@/llm/adapters/anthropic")).toBe(false)
  })
})
