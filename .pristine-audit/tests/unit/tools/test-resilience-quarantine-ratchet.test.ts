/**
 * RATCHET — flake quarantine ledger (test-resilience ④).
 *
 * The ledger (`tools/test-resilience/quarantine.json`) lists tests KNOWN to flake
 * under the full parallel suite. It is a one-directional ceiling: flakiness must
 * trend DOWN as it is structurally fixed (LSP replay seam, child-process
 * isolation), never silently UP. This test makes the suite itself enforce that —
 * not just the opt-in `test:resilient:quarantine` CLI.
 *
 * It also guards data integrity (every entry must carry a resourceClass + a
 * non-trivial reason) so a quarantine can never be a bare "ignore this test".
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { QuarantineLedger } from "../../../tools/test-resilience/parse"

const LEDGER = JSON.parse(
  readFileSync(join(import.meta.dir, "../../../tools/test-resilience/quarantine.json"), "utf8"),
) as QuarantineLedger & { _comment?: string }

const VALID_CLASSES = new Set(["external-server", "timing", "repo-walk", "io"])

describe("flake quarantine ledger ratchet", () => {
  test("entry count never exceeds the one-directional ceiling", () => {
    expect(LEDGER.entries.length).toBeLessThanOrEqual(LEDGER.maxCount)
  })

  test("the ceiling itself stays bounded (no quietly-loosened ratchet)", () => {
    // If this needs raising, it is a RED FLAG — prefer fixing the flake. Kept
    // low on purpose so growth is a deliberate, reviewed act.
    expect(LEDGER.maxCount).toBeLessThanOrEqual(6)
  })

  test("every entry carries a real resourceClass + a substantive reason", () => {
    for (const e of LEDGER.entries) {
      expect(e.file).toMatch(/\.test\.[tj]s$/)
      expect(e.name.length).toBeGreaterThan(0)
      expect(VALID_CLASSES.has(e.resourceClass)).toBe(true)
      // a reason must justify the flake (root cause + ideally a fix path), not be a stub
      expect(e.reason.length).toBeGreaterThan(40)
    }
  })

  test("no duplicate (file, name) entries", () => {
    const keys = LEDGER.entries.map((e) => `${e.file}::${e.name}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
