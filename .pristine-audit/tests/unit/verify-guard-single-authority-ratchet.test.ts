/**
 * ★ RATCHET (jun-28 SSOT) — bench `verifyGuard` has a SINGLE authority.
 *
 * After the knob-consumption consolidation, the ONLY place the bench driver
 * sets `verifyGuard` (and the sibling guard fields) is `reconcileBenchGuards`.
 * The previous bug class — the driver hardcoding `verifyGuard` in one place
 * while the `must-pass` apply-binding set it in another, with a fragile merge
 * order that silently dropped `exactCommands` — is structurally closed only as
 * long as no SECOND setter reappears in the driver.
 *
 * This grep-ratchet (god-code-ratchet pattern) asserts every CODE occurrence of
 * `verifyGuard` in the AgentConfig-assembly module lives inside the
 * `reconcileBenchGuards` function. Comments are ignored. Robust to line-number
 * drift (bounds are scanned, not hardcoded). If a new bench verifyGuard setter is
 * added elsewhere, this goes RED — forcing it back through the single authority.
 *
 * jul-02 god-file split: `reconcileBenchGuards` (and its `verifyGuard` writes)
 * were extracted, PURE code motion, from `src/runner/batch/eval/driver.ts` into
 * `./driver/config-build.ts` (the AgentConfig-assembly slice). Point the ratchet
 * at the module that now owns the authority; the invariant is unchanged.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const DRIVER = join(import.meta.dir, "../../src/runner/batch/eval/driver/config-build.ts")

const isCommentLine = (line: string): boolean => {
  const t = line.trim()
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*/")
}

describe("RATCHET — bench verifyGuard single authority (reconcileBenchGuards)", () => {
  const lines = readFileSync(DRIVER, "utf8").split("\n")

  // Dynamic bounds of `const reconcileBenchGuards = ( ... )` — start at its
  // declaration, end at the first column-0 `}` after it (the function close).
  const start = lines.findIndex((l) => l.includes("const reconcileBenchGuards = ("))
  test("reconcileBenchGuards exists", () => {
    expect(start).toBeGreaterThanOrEqual(0)
  })
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "}") {
      end = i
      break
    }
  }

  test("every CODE `verifyGuard` in driver.ts is inside reconcileBenchGuards", () => {
    const offenders: Array<{ line: number; text: string }> = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ""
      if (!line.includes("verifyGuard")) continue
      if (isCommentLine(line)) continue // doc/inline comments are fine
      if (i >= start && i <= end) continue // inside the single authority
      offenders.push({ line: i + 1, text: line.trim() })
    }
    expect(offenders).toEqual([])
  })
})
