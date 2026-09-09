import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  discoverInventory,
  discoverSuitePopulation,
  SUITE_FLOORS,
} from "../../../tools/dev/test-shard-discovery"

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
