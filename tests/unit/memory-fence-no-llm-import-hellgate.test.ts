/**
 * Slice S9 Part A — `@/memory` slice fence: no `@/llm` imports.
 *
 * The Phase2 LLM port is structurally typed (`Phase2Summarizer`) so the
 * `@/memory` slice can be exercised end-to-end without importing the
 * `@/llm` slice. A previous "REMOVE-ME (verify biome fence)" stub
 * (`import { assembleFromEvents as _verify } from "@/llm"`) lived in
 * `src/memory/consolidate/phase2-llm.ts:31` and was confirmed orphaned
 * (no consumers); deleting it is Slice S9 Part A.
 *
 * Static guards:
 *   - No `.ts` file under `src/memory/` contains `from "@/llm"`.
 *   - No `.ts` file under `src/memory/` contains `from "@llm"` either.
 *   - The biome `noRestrictedImports` rule for `src/memory/**` covers
 *     `@/llm` (regression guard).
 *   - `phase2-llm.ts` no longer contains the `_useVerify` dead alias.
 */

import { describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

// Repo-anchored on this file, not the ambient cwd — this fence walks real
// source in the checkout.
const REPO_ROOT = join(import.meta.dir, "..", "..")
const MEMORY_ROOT = join(REPO_ROOT, "src", "memory")

async function* walkTs(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      yield* walkTs(p)
    } else if (e.isFile() && p.endsWith(".ts")) {
      yield p
    }
  }
}

describe("memory-fence-no-llm-import-hellgate — static scan", () => {
  test("no .ts file under src/memory/ imports from @/llm", async () => {
    const offenders: { path: string; line: number; text: string }[] = []
    for await (const file of walkTs(MEMORY_ROOT)) {
      const content = await readFile(file, "utf8")
      const lines = content.split("\n")
      lines.forEach((line, i) => {
        // Match: import ... from "@/llm" OR import ... from "@/llm/anything"
        if (/\bfrom\s+["']@\/llm(\/[^"']*)?["']/.test(line)) {
          offenders.push({ path: file, line: i + 1, text: line.trim() })
        }
      })
    }
    expect(offenders).toEqual([])
  })

  test("no .ts file under src/memory/ uses the bare alias `@llm` (catch typos)", async () => {
    const offenders: string[] = []
    for await (const file of walkTs(MEMORY_ROOT)) {
      const content = await readFile(file, "utf8")
      if (/\bfrom\s+["']@llm["']/.test(content)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  test("phase2-llm.ts no longer contains the orphan _useVerify alias", async () => {
    const file = join(MEMORY_ROOT, "consolidate", "phase2-llm.ts")
    const content = await readFile(file, "utf8")
    expect(content).not.toContain("_useVerify")
    expect(content).not.toContain("_verify")
    expect(content).not.toContain("REMOVE-ME (verify biome fence)")
  })

  test("phase2-llm.ts still exports the structurally-typed Phase2 port API", async () => {
    const file = join(MEMORY_ROOT, "consolidate", "phase2-llm.ts")
    const content = await readFile(file, "utf8")
    // The whole point of the slice fence is that `LlmPhase2Port` works
    // WITHOUT importing @/llm. Deleting the dead stub MUST NOT regress
    // the public surface — keep this assertion to catch over-zealous cleanup.
    expect(content).toContain("export class LlmPhase2Port")
    expect(content).toContain("Phase2Summarizer")
  })

  test("biome.json `noRestrictedImports` for src/memory/** still bans @/llm", async () => {
    const biome = await readFile(join(REPO_ROOT, "biome.json"), "utf8")
    // Find the override block whose `includes` covers src/memory and whose
    // noRestrictedImports paths includes "@/llm".
    expect(biome).toContain('"@/llm"')
    expect(biome).toMatch(/@\/memory.*@\/llm|@\/llm.*Slice isolation/s)
  })
})
