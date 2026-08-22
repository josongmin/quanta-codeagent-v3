import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Subagent node-cap parity drift contract (hellgate).
 *
 * The Sub-Agents panel node Map and the backend `TaskRegistry` are bounded by
 * the SAME cap (256), but by two INDEPENDENT literals in two packages:
 *   - backend  `src/subagent/registry.ts`               `DEFAULT_MAX_RETAINED = 256`
 *   - frontend `apps/web-frontend/src/ws/subagent-model.ts` `MAX_NODES = 256`
 *
 * They MUST stay equal: the backend LRU-evicts SETTLED records at its cap
 * SILENTLY (no removal frame on the wire), so the frontend self-bounds at the
 * SAME number to mirror the backend's retained working set. If the frontend cap
 * were LOWER it would drop nodes the backend still holds (panel shows fewer
 * agents than the CLI); if HIGHER it would retain phantom nodes the backend
 * already GC'd. A cross-package `import` is IMPOSSIBLE — the frontend is a
 * separate tsconfig/toolchain outside bun's `paths` and keeps copy-mirror
 * types (same convention as `web-frontend-protocol-drift-contract-hellgate`),
 * so nothing but this text-level guard couples the two literals.
 *
 * This test reads BOTH literals from their SOURCE TEXT and asserts equality.
 * NON-VACUOUS: flip either literal and this fails — the `expect(…).toBe(…)`
 * compares the two extracted numbers directly (and each `extractNumberConst`
 * throws if its literal vanishes/renames, so a silent zero-capture can't pass).
 */

const REPO_ROOT = join(import.meta.dir, "..", "..")

const BACKEND_REGISTRY_PATH = join(REPO_ROOT, "src/subagent/registry.ts")
const FRONTEND_MODEL_PATH = join(REPO_ROOT, "apps/web-frontend/src/ws/subagent-model.ts")

const readText = (path: string): string => readFileSync(path, "utf8")

/**
 * Extract the numeric literal assigned to a `const NAME = <int>` (optionally
 * `export const`, optionally typed). Throws if the const cannot be located so a
 * rename/removal fails LOUD instead of silently capturing nothing.
 */
const extractNumberConst = (source: string, constName: string): number => {
  const re = new RegExp(`\\b${constName}\\b[^=]*=\\s*(\\d+)`)
  const match = re.exec(source)
  if (match?.[1] === undefined) {
    throw new Error(`could not locate \`${constName} = <number>\``)
  }
  return Number.parseInt(match[1], 10)
}

describe("subagent cap parity: frontend MAX_NODES === backend DEFAULT_MAX_RETAINED", () => {
  test("both copy-mirror caps read from source text are equal", () => {
    const backendCap = extractNumberConst(readText(BACKEND_REGISTRY_PATH), "DEFAULT_MAX_RETAINED")
    const frontendCap = extractNumberConst(readText(FRONTEND_MODEL_PATH), "MAX_NODES")

    // Sanity: the extractor found a real, non-zero cap on each side (catches a
    // regex that captured nothing / a stray 0), so the equality below is not
    // vacuously 0 === 0.
    expect(backendCap).toBeGreaterThan(0)
    expect(frontendCap).toBeGreaterThan(0)

    // The contract: the two independent literals are the SAME number. Flip
    // either one and this assertion fails.
    expect(frontendCap).toBe(backendCap)
  })
})
