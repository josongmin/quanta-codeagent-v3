/**
 * PMX-06 — THE VERIFICATION RAILS, as a real check.
 *
 * *"Use actual paths after implementation; no command may pass over an empty
 * test selection. Add anti-vacuum count assertions where directory selection is
 * used."*
 *
 * That rule earns its keep immediately: the ticket's own draft selection named
 * `src/apps/bench/promax`, a directory that contains ZERO `.test.ts` files (the
 * ProMax suite lives under `tests/unit/apps/bench/promax`). `bun test` over it
 * exits 0 having run nothing — a green rail that proves nothing. So the rail
 * declaration below names the paths that actually hold tests, and every
 * directory selection carries BOTH a count floor and a known-item floor.
 *
 * ⚠️ HERMETIC: this reads the filesystem to resolve the selections. It never
 * RUNS them (a rail that shelled out to `bun test` would recurse), and nothing
 * here can spend.
 */
import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  assertRailSelectionsNonEmpty,
  PROMAX_VERIFICATION_RAILS,
  resolveProMaxVerificationRails,
} from "@/apps/bench/promax/campaign"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
const RESOLVED = resolveProMaxVerificationRails(REPO)

describe("PMX-06 verification rails", () => {
  test("the declaration is non-empty and covers typecheck, lint and test", () => {
    expect(PROMAX_VERIFICATION_RAILS.length).toBeGreaterThan(5)
    const kinds = new Set(PROMAX_VERIFICATION_RAILS.map((r) => r.kind))
    expect([...kinds].sort()).toEqual(["lint", "test", "typecheck"])
  })

  test("every declared path EXISTS in the tree", () => {
    for (const rail of PROMAX_VERIFICATION_RAILS) {
      for (const path of rail.selection) {
        expect({ path, exists: existsSync(join(REPO, path)) }).toEqual({ path, exists: true })
      }
    }
  })

  test("NO test rail resolves to an empty selection (the anti-vacuum rule)", () => {
    const testRails = RESOLVED.filter((r) => r.rail.kind === "test")
    expect(testRails.length).toBeGreaterThan(0)
    for (const resolution of testRails) {
      expect({
        command: resolution.rail.command,
        files: resolution.resolvedTestFiles.length > 0,
      }).toEqual({ command: resolution.rail.command, files: true })
    }
    expect(() => assertRailSelectionsNonEmpty(RESOLVED)).not.toThrow()
  })

  test("every directory selection meets its COUNT floor and its KNOWN-ITEM floor", () => {
    for (const resolution of RESOLVED) {
      const { rail } = resolution
      expect({
        command: rail.command,
        enough: resolution.resolvedTestFiles.length >= rail.minTestFiles,
      }).toEqual({ command: rail.command, enough: true })
      for (const known of rail.mustInclude) {
        expect({
          command: rail.command,
          known,
          present: resolution.resolvedTestFiles.includes(known),
        }).toEqual({ command: rail.command, known, present: true })
      }
    }
  })

  test("the ProMax rail actually reaches THIS packet's tests (known-item floor)", () => {
    const promax = RESOLVED.find((r) => r.rail.selection.includes("tests/unit/apps/bench/promax"))
    expect(promax).toBeDefined()
    const files = promax?.resolvedTestFiles ?? []
    for (const known of [
      "tests/unit/apps/bench/promax/promax-campaign-gates.test.ts",
      "tests/unit/apps/bench/promax/promax-campaign-record.test.ts",
      "tests/unit/apps/bench/promax/promax-source-owner-audit.test.ts",
      "tests/unit/apps/bench/promax/promax-gold-sentinel.test.ts",
    ]) {
      expect({ known, present: files.includes(known) }).toEqual({ known, present: true })
    }
    expect(files.length).toBeGreaterThanOrEqual(30)
  })

  test("REFUSES an empty selection — proven on the REAL resolver", () => {
    // The realistic regression: someone points a rail at a directory that holds
    // no tests (exactly what `src/apps/bench/promax` is today).
    const decoy = resolveProMaxVerificationRails(REPO, [
      {
        command: "bun test src/apps/bench/promax",
        kind: "test",
        selection: ["src/apps/bench/promax"],
        minTestFiles: 1,
        mustInclude: [],
        why: "a decoy: this directory holds production code and no tests",
      },
    ])
    expect(decoy[0]?.resolvedTestFiles).toEqual([])
    let thrown: unknown = null
    try {
      assertRailSelectionsNonEmpty(decoy)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Error)
    expect(String(thrown)).toContain("src/apps/bench/promax")
    expect(String(thrown)).toMatch(/empty test selection/i)
  })

  test("REFUSES a selection that no longer meets its known-item floor", () => {
    const moved = resolveProMaxVerificationRails(REPO, [
      {
        command: "bun test tests/unit/apps/bench/promax",
        kind: "test",
        selection: ["tests/unit/apps/bench/promax"],
        minTestFiles: 1,
        mustInclude: ["tests/unit/apps/bench/promax/renamed-away.test.ts"],
        why: "a rail whose known item was renamed out from under it",
      },
    ])
    expect(() => assertRailSelectionsNonEmpty(moved)).toThrow(/renamed-away\.test\.ts/)
  })
})
