/**
 * T13 SSOT ratchet (audit L9 H13 + L6 M1).
 *
 * Fences the two consolidations done in the May-31 bugbash so a future edit
 * cannot silently re-introduce a duplicate implementation:
 *
 *   1. Conflict parsing — ONE algorithm, owned by `@/git/conflict-parser`. The
 *      tool-layer module (`src/tool/git/conflict-parser/{parse,types}.ts`) must
 *      stay a pure forwarder.
 *   2. Provider credential metadata — ONE table, owned by
 *      `src/llm/provider-metadata.ts`.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Repo root anchored on this file, not the ambient cwd — `read` reads real
// source out of the checkout.
const root = join(import.meta.dir, "..", "..", "..")
const read = (p: string): string => readFileSync(join(root, p), "utf8")

describe("L9 H13 — conflict-parser single source of truth", () => {
  test("the tool-layer parse.ts is a pure forwarder (no second algorithm)", () => {
    const src = read("src/tool/git/conflict-parser/parse.ts")
    expect(src).toContain('from "@/git/conflict-parser"')
    // A forwarder declares no function body and runs no scan loop.
    expect(src).not.toMatch(/const\s+parseConflicts\s*=/)
    expect(src).not.toMatch(/\bfor\s*\(/)
    expect(src).not.toMatch(/\bwhile\s*\(/)
  })

  test("the tool-layer types.ts re-exports the canonical contract (no re-declaration)", () => {
    const src = read("src/tool/git/conflict-parser/types.ts")
    expect(src).toContain('from "@/git/conflict-parser"')
    expect(src).not.toMatch(/interface\s+ConflictBlock\b/)
    expect(src).not.toMatch(/class\s+ConflictParserInputError\b/)
  })

  test("exactly one module declares `export const parseConflicts`", () => {
    const owners = ["src/git/conflict-parser.ts", "src/tool/git/conflict-parser/parse.ts"].filter(
      (p) => /export\s+const\s+parseConflicts\s*=/.test(read(p)),
    )
    expect(owners).toEqual(["src/git/conflict-parser.ts"])
  })
})

describe("L6 M1 — provider credential metadata single source of truth", () => {
  test("only provider-metadata.ts declares PROVIDER_CREDENTIALS", () => {
    const candidates = [
      "src/llm/provider-metadata.ts",
      "src/llm/provider-router.ts",
      "src/llm/factory.ts",
    ].filter((p) => /(?:const|let)\s+PROVIDER_CREDENTIALS\b/.test(read(p)))
    expect(candidates).toEqual(["src/llm/provider-metadata.ts"])
  })

  test("provider-router consumes the metadata authority (does not re-derive it)", () => {
    const src = read("src/llm/provider-router.ts")
    expect(src).toMatch(/from "\.\/provider-metadata"/)
  })
})

describe("L6 M11 — truthy-env grammar single source of truth", () => {
  test("only provider-metadata.ts declares the {1,true,yes} truthy set", () => {
    // The literal set must live in exactly one module. Any surface that
    // re-spells `"1" / "true" / "yes"` has forked the grammar (audit L6 M11).
    const candidates = [
      "src/llm/provider-metadata.ts",
      "src/llm/provider-router.ts",
      "src/llm/providers/registry.ts",
    ].filter((p) => /["']1["']\s*(?:,|\)|\])/.test(read(p)) && /["']yes["']/.test(read(p)))
    expect(candidates).toEqual(["src/llm/provider-metadata.ts"])
  })

  test("registry consumes isTruthyEnv from the metadata authority (no local copy)", () => {
    const src = read("src/llm/providers/registry.ts")
    expect(src).toMatch(/from "\.\.\/provider-metadata"/)
    expect(src).toMatch(/\bisTruthyEnv\b/)
    // The old hand-rolled predicate is gone.
    expect(src).not.toMatch(/isFoundryUseTruthy/)
  })
})
