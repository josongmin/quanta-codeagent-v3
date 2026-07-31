/**
 * Tier-1 block completeness ratchet.
 *
 * WHY THIS EXISTS: `src/agent/tier1/index.ts` is the barrel that exports every
 * session-feature builder (`build*Block`). `src/agent/features.ts` is the
 * composer that calls each builder once at session start. A developer who adds
 * a new tier-1 builder to the barrel but forgets to wire it into the composer
 * silently ships a dead block — the tool is never registered, no CI fails.
 *
 * This ratchet closes that gap: it statically extracts all `build*Block`
 * identifiers exported from the barrel and asserts each one appears as a CALL
 * SITE (identifier followed by `(`) in `features.ts`. A new builder that is
 * barrel-exported but not called turns this RED at construction time.
 *
 * RED-ON-INJECTION: removing a call from features.ts while leaving the barrel
 * export flips this RED. Removing BOTH (deleting a feature entirely) is clean.
 *
 * Non-block exports (reflect, reviewer-subagent, types) are excluded by the
 * `build.*Block` regex — they are composition utilities, not session-feature
 * blocks, and are intentionally not called from the composer.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const REPO_ROOT = join(import.meta.dir, "../..")
const BARREL = join(REPO_ROOT, "src/agent/tier1/index.ts")
const COMPOSER = join(REPO_ROOT, "src/agent/features.ts")

/** Extract all `build*Block` names exported from the barrel. */
const extractBarrelBlocks = (): Set<string> => {
  const src = readFileSync(BARREL, "utf8")
  const re = /\b(build[A-Z][A-Za-z]*Block)\b/g
  const out = new Set<string>()
  for (let m = re.exec(src); m !== null; m = re.exec(src)) out.add(m[1] as string)
  return out
}

/** Check whether a `build*Block` name appears as a call site in features.ts.
 *  A call site is the identifier immediately followed by `(` (possibly with
 *  whitespace). Import declarations use the identifier WITHOUT a following `(`
 *  on the same token position, so this distinguishes call vs import. */
const isCalledInComposer = (name: string, src: string): boolean => {
  const re = new RegExp(`\\b${name}\\s*\\(`)
  return re.test(src)
}

describe("tier1 block completeness — every barrel-exported build*Block is called in features.ts", () => {
  const barrelBlocks = extractBarrelBlocks()
  const composerSrc = readFileSync(COMPOSER, "utf8")

  test("the barrel scan finds at least 30 build*Block exports (anti-vacuum)", () => {
    expect(barrelBlocks.size).toBeGreaterThanOrEqual(30)
  })

  test("every build*Block in the barrel has a call site in features.ts", () => {
    const missing: string[] = []
    for (const name of barrelBlocks) {
      if (!isCalledInComposer(name, composerSrc)) missing.push(name)
    }
    expect(missing).toEqual([])
  })

  test("RED-ON-INJECTION: buildBudgetBlock is both barrel-exported and called (sample pin)", () => {
    expect(barrelBlocks.has("buildBudgetBlock")).toBe(true)
    expect(isCalledInComposer("buildBudgetBlock", composerSrc)).toBe(true)
  })
})
