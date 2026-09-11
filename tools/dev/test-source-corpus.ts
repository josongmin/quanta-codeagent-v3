/**
 * `tools/dev/test-source-corpus` — ONE definition of "ordinary test source", so
 * the inventory, the ratchet and their tests can never disagree about what was
 * scanned.
 *
 * The corpus is `tests/**` plus the co-located `src/**\/*.test.ts` files. Two
 * exclusions, both load-bearing:
 *
 *   - `tests/smoke/fixtures/**` is deliberately-broken source (it is INPUT to a
 *     runner test, not a test), and `tsconfig.json` already excludes it.
 *   - `tools/dev/.scratch/**` is a vendored pristine checkout used by fixture
 *     copiers; scanning it would double-count the whole repository.
 *
 * A file that vanishes between the listing and the read is SKIPPED rather than
 * fatal: concurrent suites write and delete `tests/.tmp/*.test.ts` fixtures
 * while a scan is running, and a scanner that dies on someone else's temp file
 * is a scanner nobody can run during a campaign.
 */

import { readFileSync } from "node:fs"
import { join, relative } from "node:path"

export const REPO_ROOT = join(import.meta.dir, "..", "..")

export interface TestSourceFile {
  /** Repo-relative path — the key every ledger in this lane uses. */
  readonly rel: string
  readonly abs: string
  readonly text: string
}

const EXCLUDED_SEGMENTS: readonly string[] = [
  "node_modules/",
  "tests/smoke/fixtures/",
  "tests/.tmp/",
  "tools/dev/.scratch/",
  ".pristine-audit/",
]

export const isOrdinaryTestSource = (rel: string): boolean =>
  rel.endsWith(".test.ts") && !EXCLUDED_SEGMENTS.some((segment) => rel.includes(segment))

/**
 * Files whose wall-clock assertions are ALLOWED to be new.
 *
 * `tests/measurement/**` is the designated tier for throughput contracts (it
 * gets warmup, samples and a load band). Everything else is the ordinary
 * functional tier, where a new host-throughput judgment is the defect this
 * ratchet exists to stop.
 */
export const MEASUREMENT_TIER_PREFIX = "tests/measurement/"

export const isMeasurementTier = (rel: string): boolean => rel.startsWith(MEASUREMENT_TIER_PREFIX)

const listRelativePaths = (root: string): readonly string[] => {
  const result = Bun.spawnSync(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  if (result.exitCode !== 0) {
    throw new Error(`[test-source-corpus] git ls-files failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().split("\0").filter(Boolean)
}

export const listTestSources = (root: string = REPO_ROOT): readonly TestSourceFile[] => {
  const out: TestSourceFile[] = []
  for (const rel of listRelativePaths(root)) {
    if (!isOrdinaryTestSource(rel)) continue
    const abs = join(root, rel)
    let text: string
    try {
      text = readFileSync(abs, "utf8")
    } catch {
      continue // a concurrent suite deleted its fixture between listing and read
    }
    out.push({ rel, abs, text })
  }
  return out.sort((left, right) => left.rel.localeCompare(right.rel))
}

/** Read an arbitrary directory tree as a corpus — used by red-on-injection
 *  fixtures, which live outside the repository. */
export const listTestSourcesUnder = (root: string): readonly TestSourceFile[] => {
  const out: TestSourceFile[] = []
  const glob = new Bun.Glob("**/*.test.ts")
  for (const rel of glob.scanSync({ cwd: root, onlyFiles: true })) {
    const abs = join(root, rel)
    try {
      out.push({ rel: relative(root, abs), abs, text: readFileSync(abs, "utf8") })
    } catch {}
  }
  return out.sort((left, right) => left.rel.localeCompare(right.rel))
}
