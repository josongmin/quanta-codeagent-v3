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
 * Discover the sorted test-file list the shard runner will actually execute.
 * Reuses `expandTestFiles` — do not reimplement glob here. Missing suite roots
 * fail the same way the campaign runner does (`statSync` inside expand).
 */
export const discoverSuiteFiles = (repoRoot: string, suite: SuiteName): readonly string[] =>
  expandTestFiles(SUITE_ROOTS[suite].map((root) => resolve(repoRoot, root)))

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

export const discoverInventory = (repoRoot: string): DiscoveryInventory => {
  const suites = {
    full: discoverSuitePopulation(repoRoot, "full"),
    core: discoverSuitePopulation(repoRoot, "core"),
    unit: discoverSuitePopulation(repoRoot, "unit"),
    integration: discoverSuitePopulation(repoRoot, "integration"),
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
