import { existsSync } from "node:fs"
import { relative, resolve } from "node:path"
import { expandTestFiles } from "./sandboxed-test"

/**
 * Authoritative suite roots for the shard runner. Discovery lives here so
 * inventory, policy, and the campaign runner consume one walk — never a
 * second glob.
 */
export const SUITE_ROOTS = {
  full: [
    "tests/unit",
    "tests/meta",
    "tests/adversarial",
    "tests/measurement",
    "tests/integration",
    "./src/",
    "./tools/",
  ],
  core: [
    "tests/unit",
    "tests/meta",
    "tests/adversarial",
    "tests/measurement",
    "./src/",
    "./tools/",
  ],
  unit: ["tests/unit"],
  integration: ["tests/integration"],
} as const

/**
 * One-directional floors on what each suite must DISCOVER.
 *
 * Measured from a real full run with headroom for churn. Raise when the
 * corpus grows; never lower to make a red go away.
 */
export const SUITE_FLOORS: Record<SuiteName, number> = {
  full: 3_600,
  core: 3_200,
  unit: 2_900,
  integration: 330,
}

export type SuiteName = keyof typeof SUITE_ROOTS

export const isSuiteName = (value: string): value is SuiteName => value in SUITE_ROOTS

/** Populations the full shard runner does not own. */
export const OUT_OF_BAND_ROOTS = {
  contract: { runner: "bun" as const, roots: ["tests/contract"] },
  pty: { runner: "bun" as const, roots: ["tests/e2e-pty"] },
  web: { runner: "vitest" as const, roots: ["apps/web-frontend"] },
} as const

export type OutOfBandName = keyof typeof OUT_OF_BAND_ROOTS

export interface ExclusionRecord {
  readonly path: string
  readonly reason: string
}

export interface DiscoveredPopulation {
  readonly name: string
  readonly runner: "bun" | "vitest" | "external"
  readonly roots: readonly string[]
  readonly files: readonly string[]
  readonly excluded: readonly ExclusionRecord[]
  readonly digestSha256: string
}

const digestFiles = (files: readonly string[]): string =>
  new Bun.CryptoHasher("sha256").update(files.join("\0")).digest("hex")

const toRepoRelative = (repoRoot: string, files: readonly string[]): readonly string[] =>
  [...files.map((file) => relative(repoRoot, file))].sort((left, right) =>
    left.localeCompare(right),
  )

const existingRoots = (repoRoot: string, roots: readonly string[]): readonly string[] =>
  roots.map((root) => resolve(repoRoot, root)).filter((dir) => existsSync(dir))

/**
 * How many filesystem enumerations have happened since the last reset.
 *
 * Incremented inside `discoverSuiteFiles`, which is the only walk, so the number
 * cannot drift from the behaviour it describes. `discoverInventory` resets it,
 * and a guard asserts it is 1 there — re-walking one suite makes it 2.
 */
let enumerations = 0
export const lastInventoryEnumerationCount = (): number => enumerations

/**
 * Discover the sorted test-file list the shard runner will actually execute.
 * Reuses `expandTestFiles` — do not reimplement glob here. Missing suite roots
 * fail the same way the campaign runner does (`statSync` inside expand).
 */
export const discoverSuiteFiles = (repoRoot: string, suite: SuiteName): readonly string[] => {
  // Counted HERE, at the only place an enumeration actually happens. It used to
  // be a literal `+= 1` beside the one call in `discoverInventory`, which made
  // `expect(lastInventoryEnumerationCount()).toBe(1)` an assertion that one
  // hard-coded line had executed once — re-walking a suite, or reverting the
  // projection entirely, left the guard green.
  enumerations += 1
  return expandTestFiles(SUITE_ROOTS[suite].map((root) => resolve(repoRoot, root)))
}

export const discoverSuitePopulation = (
  repoRoot: string,
  suite: SuiteName,
): DiscoveredPopulation => {
  const files = toRepoRelative(repoRoot, discoverSuiteFiles(repoRoot, suite))
  return {
    name: suite,
    runner: "bun",
    roots: SUITE_ROOTS[suite],
    files,
    excluded: [],
    digestSha256: digestFiles(files),
  }
}

export const discoverOutOfBandPopulation = (
  repoRoot: string,
  name: OutOfBandName,
): DiscoveredPopulation => {
  const spec = OUT_OF_BAND_ROOTS[name]
  const roots = existingRoots(repoRoot, spec.roots)
  const files = roots.length === 0 ? [] : toRepoRelative(repoRoot, expandTestFiles(roots))
  return {
    name,
    runner: spec.runner,
    roots: spec.roots,
    files,
    excluded: [],
    digestSha256: digestFiles(files),
  }
}

export const assertPopulationExact = (population: DiscoveredPopulation): void => {
  if (new Set(population.files).size !== population.files.length) {
    throw new Error(`[discovery] ${population.name} is not unique`)
  }
  const sorted = [...population.files].sort((left, right) => left.localeCompare(right))
  if (sorted.some((file, index) => file !== population.files[index])) {
    throw new Error(`[discovery] ${population.name} is not sorted`)
  }
}

export const assertSuiteFloor = (population: DiscoveredPopulation, suite: SuiteName): void => {
  const floor = SUITE_FLOORS[suite]
  if (population.files.length < floor) {
    throw new Error(
      `[discovery] suite=${suite} discovered ${population.files.length} files, below floor ${floor}`,
    )
  }
}

export interface DiscoveryInventory {
  readonly schema: "quanta.verification-inventory.v1"
  readonly suites: Record<SuiteName, DiscoveredPopulation>
  readonly outOfBand: Record<OutOfBandName | "eval", DiscoveredPopulation>
}

/**
 * Does `file` live under one of `roots`?
 *
 * Both sides are made repo-relative and slash-normalised first, because
 * `SUITE_ROOTS` mixes the two spellings the repo already uses (`tests/unit` and
 * `./src/`). A root matches its own directory and everything below it, never a
 * sibling that merely shares a prefix (`tests/unit` must not claim
 * `tests/unit-helpers/x.test.ts`).
 */
const normalizeRoot = (root: string): string => root.replace(/^\.\//u, "").replace(/\/+$/u, "")

const underAnyRoot = (file: string, roots: readonly string[]): boolean =>
  roots.some((root) => {
    const prefix = normalizeRoot(root)
    return prefix === "" || file === prefix || file.startsWith(`${prefix}/`)
  })

/**
 * Project one suite out of a snapshot already in hand.
 *
 * `discoverInventory` used to call `discoverSuitePopulation` four times, and the
 * four suites overlap heavily — `core ∪ integration == full`, `unit ⊆ core` —
 * so the same directories were walked repeatedly. Measured at this HEAD: one
 * `full` walk is ~50ms and the four-walk inventory is ~150ms, and the inventory
 * is itself constructed more than once per campaign by discovery, policy
 * enrollment and the matrix rails.
 *
 * The projection is only sound because suite membership is defined BY root, so
 * it must produce byte-identical output to the walk it replaces;
 * `tests/unit/dev/test-shard-discovery.test.ts` compares both, per suite, on the
 * real tree.
 */
export const projectSuitePopulation = (
  files: readonly string[],
  suite: SuiteName,
): DiscoveredPopulation => {
  const roots = SUITE_ROOTS[suite]
  const selected = files.filter((file) => underAnyRoot(file, roots))
  return {
    name: suite,
    runner: "bun",
    roots,
    files: selected,
    excluded: [],
    digestSha256: digestFiles(selected),
  }
}

export const discoverInventory = (repoRoot: string): DiscoveryInventory => {
  // ONE enumeration. `full` is the superset of every other suite root, so every
  // suite below is a filter over this list rather than another walk.
  enumerations = 0
  const everything = toRepoRelative(repoRoot, discoverSuiteFiles(repoRoot, "full"))
  const suites = {
    full: projectSuitePopulation(everything, "full"),
    core: projectSuitePopulation(everything, "core"),
    unit: projectSuitePopulation(everything, "unit"),
    integration: projectSuitePopulation(everything, "integration"),
  }
  for (const suite of Object.keys(SUITE_ROOTS) as SuiteName[]) {
    assertPopulationExact(suites[suite])
    assertSuiteFloor(suites[suite], suite)
  }
  return {
    schema: "quanta.verification-inventory.v1",
    suites,
    outOfBand: {
      contract: discoverOutOfBandPopulation(repoRoot, "contract"),
      pty: discoverOutOfBandPopulation(repoRoot, "pty"),
      web: discoverOutOfBandPopulation(repoRoot, "web"),
      eval: {
        name: "eval",
        runner: "external",
        roots: ["src/apps/bench"],
        files: [],
        excluded: [
          {
            path: "src/apps/bench",
            reason: "live eval / paid provider; not a bun test population",
          },
        ],
        digestSha256: digestFiles([]),
      },
    },
  }
}
