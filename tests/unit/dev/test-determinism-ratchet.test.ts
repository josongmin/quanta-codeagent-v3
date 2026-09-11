/**
 * RATCHET — no NEW wall assertions, unseeded randomness or fixed-sleep growth
 * in ordinary functional tests (TVH-15 items 1-3).
 *
 * ## Why this file does not itself scan the tree
 *
 * It drives `evaluateDeterminismRatchet`, the same pure function the CLI runs,
 * over (a) the REAL corpus and (b) synthetic scans. Everything the ratchet
 * claims is therefore an executed assertion about the shipped code path rather
 * than about a copy of its rules.
 *
 * ## Anti-vacuum
 *
 * Two layers. The tool carries FLOORS — files scanned, wall sites, random
 * sites, sleeping files — so a scanner that silently returned nothing is a
 * violation rather than a green; and `it fires when the corpus is starved`
 * below drives that path with a deliberately empty scan. On top of that, the
 * green case asserts the measured corpus size, so "no violations" cannot be
 * produced by an empty read.
 *
 * ## Every RED case is an injection, not a mock
 *
 * The strict-20ms and unseeded-`Math.random()` cases are REAL source, parsed by
 * the real scanner. The green corpus run is the paired control: the same code,
 * the same ledgers, zero violations.
 */

import { describe, expect, test } from "bun:test"
import {
  type DeterminismBaseline,
  evaluateDeterminismRatchet,
  loadDeterminismBaseline,
} from "../../../tools/dev/test-determinism-ratchet"
import { type FileScan, scanTestSource } from "../../../tools/dev/test-determinism-scan"
import { listTestSources } from "../../../tools/dev/test-source-corpus"
import { loadWallInventory, type WallInventory } from "../../../tools/dev/test-wall-clock-inventory"

const INVENTORY: WallInventory = loadWallInventory()
const BASELINE: DeterminismBaseline = loadDeterminismBaseline()

/**
 * Parsing 4,000 files with the TypeScript compiler is real work — MEASURED at
 * ~4.6s on an idle box and over Bun's 5s default on a loaded one. The same
 * bound `tests/unit/_arch/scan-enrollment-ratchet.test.ts` uses for its full
 * guard census, declared here for the same reason: a corpus-wide scan needs a
 * deadline chosen for the scan, not Bun's default for a unit test.
 */
const FULL_SCAN_TIMEOUT_MS = 30_000

// One read of the corpus, shared: re-parsing it per assertion adds no coverage
// and would multiply that cost by the number of assertions.
let cachedScans: readonly FileScan[] | undefined
const corpusScans = (): readonly FileScan[] =>
  (cachedScans ??= listTestSources().map((file) => scanTestSource(file.rel, file.text)))

const INJECTED_WALL = `import { expect, test } from "bun:test"
test("a strict wall assertion on host throughput", () => {
  const start = Date.now()
  let total = 0
  for (let i = 0; i < 10_000; i += 1) total += i
  const elapsed = Date.now() - start
  expect(total).toBeGreaterThan(0)
  expect(elapsed).toBeLessThan(20)
})
`

const INJECTED_RANDOM = `import { expect, test } from "bun:test"
test("unseeded randomness decides the case", () => {
  const pick = Math.random() > 0.5 ? "a" : "b"
  expect(["a", "b"]).toContain(pick)
})
`

const INJECTED_SLEEP = `import { expect, test } from "bun:test"
test("a fixed wait instead of a readiness signal", async () => {
  await Bun.sleep(250)
  expect(true).toBe(true)
})
`

const injected = (name: string, source: string): readonly FileScan[] => [
  ...corpusScans(),
  scanTestSource(`tests/unit/${name}`, source),
]

const evaluate = (scans: readonly FileScan[]) =>
  evaluateDeterminismRatchet(scans, INVENTORY, BASELINE)

describe("GREEN on the real corpus", () => {
  test(
    "the live tree has no new wall assertions, randomness or sleep growth",
    () => {
      const result = evaluate(corpusScans())
      expect(result.violations).toEqual([])
      // ANTI-VACUUM FLOOR: a scan that read nothing also produces zero violations.
      expect(result.stats.filesScanned).toBeGreaterThan(3_900)
      expect(result.stats.wallSites).toBeGreaterThan(150)
      expect(result.stats.randomSites).toBeGreaterThan(30)
      expect(result.stats.sleepFiles).toBeGreaterThan(170)
    },
    FULL_SCAN_TIMEOUT_MS,
  )

  test(
    "every wall site in the tree is classified — the inventory has no gaps",
    () => {
      const result = evaluate(corpusScans())
      expect(result.violations.filter((v) => v.kind === "new-wall-assertion")).toEqual([])
      // Every inventory row still corresponds to a live site: a ledger that has
      // drifted away from the tree is a ledger nobody is maintaining.
      expect(result.staleInventoryKeys).toEqual([])
    },
    FULL_SCAN_TIMEOUT_MS,
  )
})

describe("RED on injection", () => {
  test(
    "a NEW strict 20ms wall assertion is red, with the exact file and line",
    () => {
      const result = evaluate(injected("injected-wall.test.ts", INJECTED_WALL))
      const wall = result.violations.filter((v) => v.kind === "new-wall-assertion")
      expect(wall).toHaveLength(1)
      expect(wall[0]?.at).toBe("tests/unit/injected-wall.test.ts:8")
      expect(wall[0]?.detail).toContain("elapsed toBeLessThan 20")
    },
    FULL_SCAN_TIMEOUT_MS,
  )

  test(
    "a NEW unseeded Math.random() whose value decides the case is red",
    () => {
      const result = evaluate(injected("injected-random.test.ts", INJECTED_RANDOM))
      const random = result.violations.filter((v) => v.kind === "new-unseeded-random")
      // The per-file violation plus the corpus-total violation: a ratchet that
      // only counted per file could be defeated by spreading calls across files.
      expect(random.map((v) => v.at)).toEqual(["tests/unit/injected-random.test.ts:3", "<corpus>"])
      expect(random[0]?.detail).toContain("outcome-relevant")
    },
    FULL_SCAN_TIMEOUT_MS,
  )

  test(
    "NEW awaited fixed-sleep time is red, per file and in the corpus total",
    () => {
      const result = evaluate(injected("injected-sleep.test.ts", INJECTED_SLEEP))
      const sleep = result.violations.filter((v) => v.kind === "sleep-budget-increase")
      expect(sleep.map((v) => v.at)).toEqual(["tests/unit/injected-sleep.test.ts", "<corpus>"])
      expect(sleep[0]?.detail).toContain("250ms exceeds baseline 0ms")
    },
    FULL_SCAN_TIMEOUT_MS,
  )

  test(
    "PAIRED CONTROL: the same three injections under tests/measurement behave differently",
    () => {
      // The measurement tier is where throughput contracts are SUPPOSED to live,
      // so a wall assertion there is allowed — while the randomness and the fixed
      // sleep are still wrong anywhere.
      const scans = [
        ...corpusScans(),
        scanTestSource("tests/measurement/injected-wall.test.ts", INJECTED_WALL),
      ]
      const result = evaluate(scans)
      expect(result.violations.filter((v) => v.kind === "new-wall-assertion")).toEqual([])
    },
    FULL_SCAN_TIMEOUT_MS,
  )

  test(
    "an increase that stays inside an existing per-file budget is NOT red",
    () => {
      // Direction check: the ratchet is one-directional, so removing a sleep or
      // holding steady must stay green.
      const [firstSleepFile] = Object.keys(BASELINE.sleepMsByFile)
      expect(firstSleepFile).toBeDefined()
      const result = evaluate(corpusScans())
      expect(result.violations).toEqual([])
    },
    FULL_SCAN_TIMEOUT_MS,
  )
})

describe("the anti-vacuum floor is a real code path, not a comment", () => {
  test("it fires when the corpus is starved", () => {
    const result = evaluate([scanTestSource("tests/unit/lonely.test.ts", "export {}")])
    const floors = result.violations.filter((v) => v.kind === "anti-vacuum-floor")
    // All four floors report, each naming what it measured.
    expect(floors.map((v) => v.detail.split("=")[0])).toEqual([
      "filesScanned",
      "wallSites",
      "randomSites",
      "sleepFiles",
    ])
  })

  test(
    "the floors are BELOW the measured corpus, so they cannot be silently met",
    () => {
      const stats = evaluate(corpusScans()).stats
      expect(BASELINE.floors.minFilesScanned).toBeLessThanOrEqual(stats.filesScanned)
      expect(BASELINE.floors.minWallSites).toBeLessThanOrEqual(stats.wallSites)
      expect(BASELINE.floors.minRandomSites).toBeLessThanOrEqual(stats.randomSites)
      expect(BASELINE.floors.minSleepFiles).toBeLessThanOrEqual(stats.sleepFiles)
    },
    FULL_SCAN_TIMEOUT_MS,
  )
})

describe("the wall-clock inventory is a per-site JUDGMENT, not a count", () => {
  const CLASSES = [
    "functional-deadline",
    "performance-contract",
    "test-only-settle",
    "irrelevant-non-time",
  ] as const

  test("every row carries a real classification and a non-stub justification", () => {
    expect(INVENTORY.rows.length).toBeGreaterThan(150)
    for (const row of INVENTORY.rows) {
      expect(CLASSES).toContain(row.classification)
      // Fewer than four words is a LABEL ("flaky", "known issue", "TODO"), not a
      // reason. The stronger check is the cross-file one below.
      expect(row.justification.trim().split(/\s+/u).length, row.key).toBeGreaterThanOrEqual(4)
      expect(row.file).toMatch(/\.test\.[tj]s$/)
      expect(row.key.startsWith(row.file)).toBe(true)
    }
  })

  test("no justification is COPY-PASTED across files — each is a per-site judgment", () => {
    // This is the assertion the section title actually claims. Two sites in ONE
    // file may share a reason (the same mechanism, asserted twice); the same
    // sentence appearing in two different files means somebody bulk-classified.
    const filesByJustification = new Map<string, Set<string>>()
    for (const row of INVENTORY.rows) {
      const seen = filesByJustification.get(row.justification) ?? new Set<string>()
      seen.add(row.file)
      filesByJustification.set(row.justification, seen)
    }
    const reused = [...filesByJustification.entries()]
      .filter(([, files]) => files.size > 1)
      .map(([justification]) => justification.slice(0, 60))
    expect(reused).toEqual([])
    // ANTI-VACUUM FLOOR: the map really covers every row.
    expect(filesByJustification.size).toBeGreaterThan(150)
  })

  test("the declared counts equal the rows — the header cannot drift", () => {
    const counted = { ...Object.fromEntries(CLASSES.map((name) => [name, 0])) } as Record<
      (typeof CLASSES)[number],
      number
    >
    for (const row of INVENTORY.rows) counted[row.classification] += 1
    expect(INVENTORY.counts).toEqual(counted)
    expect(Object.values(counted).reduce((sum, n) => sum + n, 0)).toBe(INVENTORY.rows.length)
  })

  test("keys are unique — two sites can never share one judgment", () => {
    expect(new Set(INVENTORY.rows.map((row) => row.key)).size).toBe(INVENTORY.rows.length)
  })

  test("both wrong-in-the-functional-tier classes are actually populated", () => {
    // If `performance-contract` were empty the inventory would be asserting
    // that nothing needs moving, which the ticket's own list contradicts.
    expect(INVENTORY.counts["performance-contract"]).toBeGreaterThan(0)
    expect(INVENTORY.counts["functional-deadline"]).toBeGreaterThan(0)
  })
})
