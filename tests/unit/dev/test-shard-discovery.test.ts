import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import {
  discoverInventory,
  discoverSuiteFiles,
  discoverSuitePopulation,
  lastInventoryEnumerationCount,
  projectSuitePopulation,
  SUITE_FLOORS,
  SUITE_ROOTS,
} from "../../../tools/dev/test-shard-discovery"
import {
  selectShardManifest,
  tierSelectionFromPolicy,
} from "../../../tools/dev/test-shard-selection"
import {
  CORPUS_LOSS_KINDS,
  checkTierPopulation,
  loadTierPopulationFloors,
  SUITE_SCOPE,
  TIER_POPULATION_PATH,
  type TierPopulationFile,
} from "../../../tools/dev/test-tier-population"

const ROOT = resolve(import.meta.dir, "..", "..", "..")

const POLICY_OVERRIDES = join(ROOT, "tools", "dev", "test-policy-overrides.json")

/** A parsed JSON object, edited by path in red-on-injection copies. */
type JsonObject = { [key: string]: unknown }

const parentAt = (root: JsonObject, path: readonly string[]): JsonObject => {
  let node: unknown = root
  for (const key of path.slice(0, -1)) node = (node as JsonObject)[key]
  return node as JsonObject
}
const leaf = (path: readonly string[]): string => path[path.length - 1] ?? ""
const at = (root: JsonObject, path: readonly string[]): unknown => parentAt(root, path)[leaf(path)]
const put = (root: JsonObject, path: readonly string[], value: unknown): void => {
  parentAt(root, path)[leaf(path)] = value
}
const drop = (root: JsonObject, path: readonly string[]): void => {
  delete parentAt(root, path)[leaf(path)]
}
const bump = (root: JsonObject, path: readonly string[], by: number): void =>
  put(root, path, (at(root, path) as number) + by)

/** A v2 record in memory. `checkTierPopulation` does not re-derive; the loader does. */
const fixtureFloors = (
  tiers: Readonly<Record<string, number>>,
  narrow: Readonly<Record<"core" | "unit" | "integration", number>> = {
    core: 1,
    unit: 1,
    integration: 1,
  },
): TierPopulationFile => ({
  schema: "quanta.test-tier-population.v2",
  tiers: Object.fromEntries(
    Object.entries(tiers).map(([t, minFiles]) => [t, { minFiles, reason: "fixture" }]),
  ),
  suites: {
    measuredAt: "fixture",
    universeSelected: Object.fromEntries(Object.keys(tiers).map((t) => [t, 0])),
    floors: {
      core: Object.fromEntries(
        Object.keys(tiers).map((t) => [
          t,
          { selected: 0, minFiles: narrow.core, reason: "fixture" },
        ]),
      ),
      unit: Object.fromEntries(
        Object.keys(tiers).map((t) => [
          t,
          { selected: 0, minFiles: narrow.unit, reason: "fixture" },
        ]),
      ),
      integration: Object.fromEntries(
        Object.keys(tiers).map((t) => [
          t,
          { selected: 0, minFiles: narrow.integration, reason: "fixture" },
        ]),
      ),
    },
  },
})

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
  const floors = fixtureFloors({ pr: 100 })

  test("an intact universe with a narrowed tier reports SELECTION, not corpus loss", () => {
    const verdict = checkTierPopulation({
      tier: "pr",
      suite: "full",
      selected: 40,
      discovered: 3932,
      suiteFloor: 1,
      floors,
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.message).toContain("SELECTION shrink, not corpus loss")
    expect(verdict.message).toContain("3932")
    expect(verdict.message).not.toContain("corpus shrank under the runner")
  })

  test("a tier that selects nothing is named as an empty selection", () => {
    const verdict = checkTierPopulation({
      tier: "pr",
      suite: "full",
      selected: 0,
      discovered: 3932,
      suiteFloor: 1,
      floors,
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.message).toContain("selected zero")
  })

  test("an unlisted tier fails closed rather than defaulting", () => {
    const verdict = checkTierPopulation({
      tier: "some-new-tier",
      suite: "full",
      selected: 3932,
      discovered: 3932,
      suiteFloor: 1,
      floors,
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.message).toContain("no committed population floor")
  })

  test("selection cannot exceed discovery", () => {
    const verdict = checkTierPopulation({
      tier: "pr",
      suite: "full",
      selected: 4000,
      discovered: 3932,
      suiteFloor: 1,
      floors,
    })
    expect(verdict.ok).toBe(false)
  })

  test("a healthy tier passes and reports the floor it cleared", () => {
    const verdict = checkTierPopulation({
      tier: "pr",
      suite: "full",
      selected: 3932,
      discovered: 3932,
      suiteFloor: 1,
      floors,
    })
    expect(verdict).toEqual({ ok: true, floor: 100 })
  })

  /**
   * ★ Every suite × tier the runner can be asked for clears ITS OWN floor.
   *
   * The tier floors are measured over the universe and were applied to every
   * suite, so all TWELVE narrow suite × tier pairs refused: `bun run test:unit`,
   * `test:unit:ci` and `test:integration` could never run, while `AGENT_CORE.md`
   * and `AGENTS.md` present them as the canonical commands. A previous attempt
   * only changed the refusal MESSAGE, and printed a claim about the corpus it
   * never checked.
   *
   * Live: real discovery, the runner's own tier selection
   * (`tierSelectionFromPolicy`, extracted so this arm cannot drift from it), and
   * the committed record.
   */
  test("LIVE — all sixteen suite × tier pairs select through the runner's path", () => {
    const committed = loadTierPopulationFloors()
    const tiers = Object.keys(committed.tiers)
    expect(tiers.sort()).toEqual(["full", "nightly", "pr", "prepush"])
    const outcomes: string[] = []
    for (const suite of Object.keys(SUITE_ROOTS) as (keyof typeof SUITE_ROOTS)[]) {
      const discovered = discoverSuiteFiles(ROOT, suite)
      for (const tier of tiers) {
        try {
          selectShardManifest({
            suite,
            tier,
            discovered,
            idOf: (file) => relative(ROOT, file),
            suiteFloor: SUITE_FLOORS[suite],
            tierFloors: committed,
            selectForTier: (ids, t) => tierSelectionFromPolicy(ids, t, POLICY_OVERRIDES),
          })
          outcomes.push(`${suite}:${tier} ok`)
        } catch (error) {
          outcomes.push(`${suite}:${tier} ${(error as Error).message.slice(0, 120)}`)
        }
      }
    }
    expect(outcomes.filter((line) => !line.endsWith(" ok"))).toEqual([])
    expect(outcomes).toHaveLength(16)
  }, 60_000)

  test("each suite is judged by ITS floor, and the scope is total over SuiteName", () => {
    // SUITE_SCOPE is keyed by SuiteName, so a new suite is a type error; this
    // pins the runtime set too.
    expect(Object.keys(SUITE_SCOPE).sort()).toEqual(Object.keys(SUITE_ROOTS).sort())
    const floors = fixtureFloors({ pr: 80 }, { core: 60, unit: 30, integration: 20 })
    const at = (suite: keyof typeof SUITE_ROOTS, selected: number, discovered: number) =>
      checkTierPopulation({ tier: "pr", suite, selected, discovered, suiteFloor: 1, floors })

    // A narrow suite reads its OWN floor: 40 clears unit's 30 and fails the universe's 80.
    expect(at("unit", 40, 40).ok).toBe(true)
    expect(at("full", 40, 40).ok).toBe(false)

    // Nothing narrowed and below the floor is CORPUS loss, for every suite —
    // named for which kind of suite it is.
    for (const [suite, count] of [
      ["full", 70],
      ["core", 50],
      ["unit", 20],
      ["integration", 10],
    ] as const) {
      const verdict = at(suite, count, count)
      if (verdict.ok) throw new Error(`${suite} unexpectedly passed`)
      expect({ suite, kind: verdict.kind }).toEqual({
        suite,
        kind: suite === "full" ? "universe-below-tier-floor" : "suite-below-its-tier-floor",
      })
      expect(CORPUS_LOSS_KINDS.has(verdict.kind)).toBe(true)
    }

    // A NARROWED narrow suite is a selection shrink, not corpus loss.
    const narrowed = at("core", 50, 90)
    if (narrowed.ok) throw new Error("unreachable")
    expect(narrowed.kind).toBe("narrowed")
    expect(CORPUS_LOSS_KINDS.has(narrowed.kind)).toBe(false)
  })

  test("the suite floor is checked HERE, not trusted from the caller", () => {
    // It used to print "the suite's own pre-selection floor was cleared" for any
    // caller — a check it never made.
    const verdict = checkTierPopulation({
      tier: "pr",
      suite: "integration",
      selected: 100,
      discovered: 100,
      suiteFloor: 330,
      floors: fixtureFloors({ pr: 80 }, { core: 60, unit: 30, integration: 20 }),
    })
    if (verdict.ok) throw new Error("unreachable")
    expect(verdict.kind).toBe("suite-corpus-lost")
  })

  test("a narrow floor cannot be lowered by editing one number", () => {
    const committed = readFileSync(TIER_POPULATION_PATH, "utf8")
    const dir = mkdtempSync(join(tmpdir(), "tier-pop-"))
    /** Load a copy of the committed record with one JSON edit applied. */
    const attempt = (edit: (root: JsonObject) => void): string => {
      const record = JSON.parse(committed) as JsonObject
      edit(record)
      const path = join(dir, "record.json")
      writeFileSync(path, JSON.stringify(record))
      try {
        loadTierPopulationFloors(path)
        return "loaded"
      } catch (error) {
        return (error as Error).message
      }
    }
    try {
      // PAIRED CONTROL — the committed record loads.
      expect(attempt(() => {})).toBe("loaded")
      expect(
        attempt((r) => bump(r, ["suites", "floors", "unit", "full", "minFiles"], -1)),
      ).toContain("share rule derives")
      expect(attempt((r) => drop(r, ["suites", "floors", "integration"]))).toContain(
        "suites.floors must be exactly",
      )
      expect(attempt((r) => drop(r, ["suites", "floors", "core", "nightly"]))).toContain(
        "suites.floors.core must be exactly",
      )
      expect(
        attempt((r) => put(r, ["suites", "floors", "full"], at(r, ["suites", "floors", "core"]))),
      ).toContain("suites.floors must be exactly")
      expect(attempt((r) => put(r, ["suites", "universeSelected", "pr"], 3_800))).toContain(
        "universeSelected.pr",
      )
      // Lowering a measured count AND recomputing its floor to match still fails:
      // the partition no longer adds up to what the universe selected.
      expect(
        attempt((r) => {
          const selected = (at(r, ["suites", "floors", "core", "pr", "selected"]) as number) - 100
          const universe = at(r, ["suites", "universeSelected", "pr"]) as number
          const universeFloor = at(r, ["tiers", "pr", "minFiles"]) as number
          put(r, ["suites", "floors", "core", "pr", "selected"], selected)
          put(
            r,
            ["suites", "floors", "core", "pr", "minFiles"],
            selected - Math.floor(((universe - universeFloor) * selected) / universe),
          )
        }),
      ).toContain("the measurements disagree")
      expect(attempt((r) => drop(r, ["suites"]))).toContain("`suites` is missing")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
          schema: "quanta.test-tier-population.v2",
          tiers: { pr: { minFiles: 0, reason: "x" } },
        },
        match: /non-positive minFiles/,
      },
      {
        why: "a negative floor",
        body: {
          schema: "quanta.test-tier-population.v2",
          tiers: { pr: { minFiles: -1, reason: "x" } },
        },
        match: /non-positive minFiles/,
      },
      {
        why: "a non-integer floor",
        body: {
          schema: "quanta.test-tier-population.v2",
          tiers: { pr: { minFiles: 1.5, reason: "x" } },
        },
        match: /non-positive minFiles/,
      },
      {
        why: "an empty reason is not a reason",
        body: {
          schema: "quanta.test-tier-population.v2",
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
        body: { schema: "quanta.test-tier-population.v2", tiers: [] },
        match: /must be an object/,
      },
    ]

    // ANTI-VACUITY: the corpus must be non-trivial, and the VALID shape must
    // still load — otherwise "everything throws" satisfies every case above.
    expect(cases.length).toBeGreaterThanOrEqual(6)
    // The valid shape is the COMMITTED record: a v2 file must carry derived
    // narrow-suite floors, so a hand-written minimal body is no longer valid.
    expect(loadTierPopulationFloors(TIER_POPULATION_PATH).tiers.pr?.minFiles).toBeGreaterThan(0)

    // Index, not `Math.random()`: uniqueness within this loop is what is
    // needed, and the determinism ratchet correctly refuses unseeded randomness
    // that decides anything about a run — including a filename that ends up in
    // a failure message.
    for (const [index, row] of cases.entries()) {
      const path = join(tmpdir(), `tier-pop-${process.pid}-${Date.now()}-${index}.json`)
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
        JSON.stringify({ schema: "quanta.test-tier-population.v2", tiers: {} }),
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
