import { describe, expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  discoverInventory,
  discoverSuitePopulation,
  lastInventoryEnumerationCount,
  projectSuitePopulation,
  SUITE_FLOORS,
  SUITE_ROOTS,
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

  test("every field the record promises is actually validated at load", () => {
    // Three mutation survivors: removing the `minFiles`, the `reason` and the
    // schema checks each left the suite green. The docstring calls this "a
    // reviewable data file with a reason per tier"; nothing enforced it, so
    // `minFiles: 0` or `reason: ""` would load clean and the floor would be a
    // number nobody picked.
    const cases: readonly {
      readonly why: string
      readonly body: unknown
      readonly match: RegExp
    }[] = [
      {
        why: "a zero floor is not a floor",
        body: {
          schema: "quanta.test-tier-population.v1",
          tiers: { pr: { minFiles: 0, reason: "x" } },
        },
        match: /non-positive minFiles/,
      },
      {
        why: "a negative floor",
        body: {
          schema: "quanta.test-tier-population.v1",
          tiers: { pr: { minFiles: -1, reason: "x" } },
        },
        match: /non-positive minFiles/,
      },
      {
        why: "a non-integer floor",
        body: {
          schema: "quanta.test-tier-population.v1",
          tiers: { pr: { minFiles: 1.5, reason: "x" } },
        },
        match: /non-positive minFiles/,
      },
      {
        why: "an empty reason is not a reason",
        body: {
          schema: "quanta.test-tier-population.v1",
          tiers: { pr: { minFiles: 10, reason: "  " } },
        },
        match: /no reason/,
      },
      {
        why: "a foreign schema must not be read as this one",
        body: {
          schema: "quanta.test-tier-population.v0",
          tiers: { pr: { minFiles: 10, reason: "x" } },
        },
        match: /unknown tier population schema/,
      },
      {
        why: "tiers must be an object, not an array",
        body: { schema: "quanta.test-tier-population.v1", tiers: [] },
        match: /must be an object/,
      },
    ]

    // ANTI-VACUITY: the corpus must be non-trivial, and the VALID shape must
    // still load — otherwise "everything throws" satisfies every case above.
    expect(cases.length).toBeGreaterThanOrEqual(6)
    const valid = join(tmpdir(), `tier-pop-valid-${process.pid}-${Date.now()}.json`)
    try {
      writeFileSync(
        valid,
        JSON.stringify({
          schema: "quanta.test-tier-population.v1",
          tiers: { pr: { minFiles: 10, reason: "a real reason" } },
        }),
        "utf8",
      )
      expect(loadTierPopulationFloors(valid).tiers.pr?.minFiles).toBe(10)
    } finally {
      rmSync(valid, { force: true })
    }

    for (const row of cases) {
      const path = join(tmpdir(), `tier-pop-${process.pid}-${Date.now()}-${Math.random()}.json`)
      try {
        writeFileSync(path, JSON.stringify(row.body), "utf8")
        expect(() => loadTierPopulationFloors(path), row.why).toThrow(row.match)
      } finally {
        rmSync(path, { force: true })
      }
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

/**
 * ONE filesystem enumeration per inventory.
 *
 * `discoverInventory` called `discoverSuitePopulation` four times over roots
 * that overlap almost entirely — measured on this tree, `core ∪ integration ==
 * full`, `unit ⊆ core`, `integration ⊆ full` — so the same directories were
 * walked again and again, and the inventory is itself built more than once per
 * campaign by discovery, policy enrollment and the matrix rails.
 *
 * ABBA against the previous implementation on this HEAD, 12 interleaved samples
 * each on a loaded host: median 124ms → 45ms, with all eight populations
 * byte-identical.
 *
 * The projection is only sound because suite membership is DEFINED by root, so
 * the parity arm below is not decoration — it is the whole licence for the
 * change, and it runs against the real tree rather than a fixture.
 */
describe("inventory projection", () => {
  test("one snapshot, and every suite matches the walk it replaced", () => {
    const inventory = discoverInventory(ROOT)
    expect(lastInventoryEnumerationCount()).toBe(1)

    for (const suite of Object.keys(SUITE_ROOTS) as (keyof typeof SUITE_ROOTS)[]) {
      const walked = discoverSuitePopulation(ROOT, suite)
      const projected = inventory.suites[suite]
      expect({ suite, files: projected.files }).toEqual({ suite, files: walked.files })
      expect({ suite, digest: projected.digestSha256 }).toEqual({
        suite,
        digest: walked.digestSha256,
      })
    }

    // ANTI-VACUITY: a projection over an empty snapshot matches an empty walk.
    expect(inventory.suites.full.files.length).toBeGreaterThanOrEqual(SUITE_FLOORS.full)
    expect(inventory.suites.integration.files.length).toBeGreaterThanOrEqual(
      SUITE_FLOORS.integration,
    )
  })

  test("the suite relations the projection relies on still hold", () => {
    const inventory = discoverInventory(ROOT)
    const set = (name: keyof typeof SUITE_ROOTS): Set<string> =>
      new Set(inventory.suites[name].files)
    const full = set("full")
    const core = set("core")
    const unit = set("unit")
    const integration = set("integration")
    expect([...core].filter((f) => !full.has(f))).toEqual([])
    expect([...unit].filter((f) => !core.has(f))).toEqual([])
    expect([...integration].filter((f) => !full.has(f))).toEqual([])
    expect(new Set([...core, ...integration]).size).toBe(full.size)
  })

  test("a root claims its own subtree and not a prefix-sharing sibling", () => {
    // `tests/unit` must not absorb `tests/unit-helpers/...`, and `./src/` must
    // normalise to the same thing as `src`.
    const files = [
      "tests/unit/a.test.ts",
      "tests/unit-helpers/b.test.ts",
      "src/c.test.ts",
      "tools/d.test.ts",
    ]
    expect(projectSuitePopulation(files, "unit").files).toEqual(["tests/unit/a.test.ts"])
    expect(projectSuitePopulation(files, "core").files).toEqual([
      "tests/unit/a.test.ts",
      "src/c.test.ts",
      "tools/d.test.ts",
    ])
  })
})
