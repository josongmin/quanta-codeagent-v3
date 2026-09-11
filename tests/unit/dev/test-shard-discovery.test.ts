import { describe, expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  discoverInventory,
  discoverSuitePopulation,
  SUITE_FLOORS,
} from "../../../tools/dev/test-shard-discovery"
import {
  checkTierPopulation,
  loadTierPopulationFloors,
} from "../../../tools/dev/test-tier-population"

const ROOT = resolve(import.meta.dir, "..", "..", "..")

describe("test-shard-discovery", () => {
  test("two walks of the same HEAD produce identical order and digest", () => {
    const first = discoverSuitePopulation(ROOT, "full")
    const second = discoverSuitePopulation(ROOT, "full")
    expect(first.files).toEqual(second.files)
    expect(first.digestSha256).toBe(second.digestSha256)
    expect(first.files.length).toBeGreaterThanOrEqual(SUITE_FLOORS.full)
    expect(new Set(first.files).size).toBe(first.files.length)
  })

  test("full population is disjoint from contract/pty/web out-of-band sets", () => {
    const inventory = discoverInventory(ROOT)
    const full = new Set(inventory.suites.full.files)
    for (const name of ["contract", "pty", "web"] as const) {
      const overlap = inventory.outOfBand[name].files.filter((file) => full.has(file))
      expect(overlap).toEqual([])
    }
    expect(inventory.outOfBand.eval.runner).toBe("external")
    expect(inventory.outOfBand.eval.files).toEqual([])
  })

  test("suite floors are enforced by inventory construction", () => {
    const inventory = discoverInventory(ROOT)
    expect(inventory.suites.full.files.length).toBeGreaterThanOrEqual(SUITE_FLOORS.full)
    expect(inventory.suites.core.files.length).toBeGreaterThanOrEqual(SUITE_FLOORS.core)
    expect(inventory.suites.unit.files.length).toBeGreaterThanOrEqual(SUITE_FLOORS.unit)
    expect(inventory.suites.integration.files.length).toBeGreaterThanOrEqual(
      SUITE_FLOORS.integration,
    )
  })
})

/**
 * TIER SELECTION FLOOR — a narrowed tier and a lost corpus are different
 * failures and must not share a message.
 *
 * The runner had one check: `SUITE_FLOORS[suite]` (3,600 for `full`) applied to
 * the list AFTER tier selection. Measured at 85a99bb6f, `prepush`, `pr` and
 * `full` all resolve to the same 3,932 files with the identical digest
 * d006b12164c37aec — which is why the conflation was invisible. The moment PR is
 * narrowed to exclude capability-gated tests, an INTENDED reduction below 3,600
 * would have been reported as "the corpus shrank under the runner", naming the
 * wrong cause and pointing at the wrong file.
 */
describe("tier population floor", () => {
  const floors = {
    schema: "quanta.test-tier-population.v1" as const,
    tiers: { pr: { minFiles: 100, reason: "fixture" } },
  }

  test("an intact universe with a narrowed tier reports SELECTION, not corpus loss", () => {
    const verdict = checkTierPopulation({
      tier: "pr",
      selected: 40,
      discovered: 3932,
      floors,
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.message).toContain("SELECTION shrink, not corpus loss")
    expect(verdict.message).toContain("3932")
    expect(verdict.message).not.toContain("corpus shrank under the runner")
  })

  test("a tier that selects nothing is named as an empty selection", () => {
    const verdict = checkTierPopulation({ tier: "pr", selected: 0, discovered: 3932, floors })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.message).toContain("selected zero")
  })

  test("an unlisted tier fails closed rather than defaulting", () => {
    const verdict = checkTierPopulation({
      tier: "some-new-tier",
      selected: 3932,
      discovered: 3932,
      floors,
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.message).toContain("no committed population floor")
  })

  test("selection cannot exceed discovery", () => {
    const verdict = checkTierPopulation({ tier: "pr", selected: 4000, discovered: 3932, floors })
    expect(verdict.ok).toBe(false)
  })

  test("a healthy tier passes and reports the floor it cleared", () => {
    const verdict = checkTierPopulation({ tier: "pr", selected: 3932, discovered: 3932, floors })
    expect(verdict).toEqual({ ok: true, floor: 100 })
  })

  test("the committed record covers every tier the runner can be asked for", () => {
    const committed = loadTierPopulationFloors()
    // ANTI-VACUITY: an emptied record must not make the coverage check vacuous.
    expect(Object.keys(committed.tiers).length).toBeGreaterThanOrEqual(4)
    for (const tier of ["prepush", "pr", "full", "nightly"]) {
      expect({ tier, present: tier in committed.tiers }).toEqual({ tier, present: true })
      expect(committed.tiers[tier]?.reason ?? "").not.toBe("")
    }
  })

  test("an emptied record is rejected at load time", () => {
    const path = join(tmpdir(), `tier-pop-${process.pid}-${Date.now()}.json`)
    try {
      writeFileSync(
        path,
        JSON.stringify({ schema: "quanta.test-tier-population.v1", tiers: {} }),
        "utf8",
      )
      expect(() => loadTierPopulationFloors(path)).toThrow(/no tiers declared/)
    } finally {
      rmSync(path, { force: true })
    }
  })
})
