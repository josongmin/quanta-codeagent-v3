/**
 * Ratchet (jul-13 prompt design-system) — the agent's seniority-qualified ROLE
 * word is single-sourced in `prompt-graph/shared.ts` and MUST NOT be re-inlined
 * anywhere else. This is the governance tier: it makes the principal/senior
 * drift (main prompt said "principal", the repro-gen / localize sub-agents said
 * "senior", with no single owner) UN-REPRESENTABLE going forward — a new prompt
 * that hard-codes "staff software engineer" instead of `ROLE.*` fails CI here.
 *
 * The guard is CLASS-based, not literal: it forbids ANY `<seniority> … engineer`
 * phrase outside the SSOT, so a fourth spelling of the same idea is caught, not
 * just today's three. Tone phrases without a seniority prefix (persona.ts's
 * "pragmatic software engineer") are intentionally NOT matched.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assertScanPopulation } from "../../../tests/unit/_shared/scan-population"

// `<seniority> [<up-to-2 words>] engineer` — requires a seniority prefix so
// role tokens are caught while bare "software engineer" tone phrases are not.
const SENIORITY_ROLE =
  /\b(principal|senior|staff|lead|distinguished|junior)\s+(\w+\s+){0,2}engineer\b/i

const SRC_DIR = join(import.meta.dir, "../..") // src/
const SHARED_REL = "agent/prompt-graph/shared.ts"
const SCAN = "**/*.{ts,tsx}"
// Exclude test files + the double-underscore DIR convention (`__tests__`,
// `__mocks__`, …) — but NOT an arbitrary `__foo.ts` prod file, which must stay
// in scope so a prompt can't evade the ratchet by an underscore-prefixed name.
const isTest = (p: string) => /\.(test|spec)\.[a-z]+$/.test(p) || /\/__\w+__\//.test(p)

describe("role-drift ratchet — seniority ROLE word is single-sourced in shared.ts", () => {
  test("ANTI-VACUITY: the glob reaches a real, populated `src/` tree", () => {
    // The file already pins that the SSOT is non-empty. That is the other half:
    // an SSOT full of role words still reports zero offenders if the scan that
    // looks for them enumerated nothing.
    assertScanPopulation(
      [...new Bun.Glob(SCAN).scanSync(SRC_DIR)]
        .filter((rel) => !isTest(rel))
        .map((rel) => join(SRC_DIR, rel)),
      SRC_DIR,
      { min: 500, collectable: (n) => /\.(ts|tsx)$/.test(n) && !/\.(test|spec)\./.test(n) },
    )
  })

  test("no file outside shared.ts inlines a `<seniority> … engineer` role phrase", () => {
    const offenders: string[] = []
    for (const rel of new Bun.Glob(SCAN).scanSync(SRC_DIR)) {
      if (rel === SHARED_REL || isTest(rel)) continue
      if (SENIORITY_ROLE.test(readFileSync(join(SRC_DIR, rel), "utf8"))) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  test("anti-vacuous: shared.ts DOES hold the role words (SSOT is non-empty)", () => {
    const shared = readFileSync(join(SRC_DIR, SHARED_REL), "utf8")
    // If the ROLE map were emptied/renamed, the offenders test above could pass
    // vacuously — pin that the SSOT actually carries the phrases it owns.
    expect(shared).toContain("principal software engineer")
    expect(shared).toContain("senior software engineer")
    expect(shared).toContain("senior Python engineer")
  })

  test("red-on-injection: the guard matches a seniority role and spares tone phrases", () => {
    // Positive control — a new inlined role must trip the regex.
    expect(SENIORITY_ROLE.test("You are a staff software engineer doing X.")).toBe(true)
    expect(SENIORITY_ROLE.test("You are a senior Python engineer writing Y.")).toBe(true)
    // Negative control — a bare tone phrase (persona register) must NOT trip it,
    // else the ratchet would false-flag legitimate non-role prose.
    expect(SENIORITY_ROLE.test("Persona: deeply pragmatic software engineer.")).toBe(false)
  })
})
