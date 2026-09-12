/**
 * Refresh tools/feature-catalog/baseline.json from real measurements.
 *
 * Runs the project's three quality gates and serializes their results into a
 * single deterministic JSON file consumed by the feature-catalog build to
 * synthesize the "검증 베이스라인" line in the rendered catalog.
 *
 * Gates:
 *   1. repo typecheck:all      → exit code + TS error-line count
 *   2. biome check authoritative targets → exit code + (best-effort) error count
 *   3. bun test (unit + integration, then per-tier for file/test counts)
 *
 * Zero new deps — only Bun built-ins. Pure parser is exported for unit
 * testing without spawning subprocesses (slow + flaky in CI).
 */
import { execFileSync } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { collectBiomeTargets } from "../dev/biome-targets"

// ────────────────────────────────────────────────────────────────────────────
// Pure parsers (unit-tested without spawning real subprocesses)
// ────────────────────────────────────────────────────────────────────────────

export interface TestSummary {
  pass: number
  fail: number
  skip: number
  expect_count: number
  files: number
}

/**
 * Extract Bun's test footer counters from arbitrary captured output.
 *
 * Bun emits, on its own lines near the end:
 *   ` 1952 pass`
 *   ` 0 fail`
 *   ` 2 skip`
 *   ` 5624 expect() calls`
 *   `Ran 1954 tests across 154 files. [26.27s]`
 *
 * Returns `null` if any of the five counters are missing — partial output
 * (truncated by timeout / crash) must not be silently coerced into a
 * "0 fail" baseline.
 */
export const parseBunTestOutput = (text: string): TestSummary | null => {
  const m = (re: RegExp): number | null => {
    const x = text.match(re)
    return x?.[1] !== undefined ? Number(x[1]) : null
  }
  const pass = m(/(\d+)\s+pass\b/)
  const fail = m(/(\d+)\s+fail\b/)
  const skip = m(/(\d+)\s+skip\b/)
  const expect_count = m(/(\d+)\s+expect\(\)/)
  const files = m(/across\s+(\d+)\s+files/)
  if (pass === null || fail === null || skip === null || expect_count === null || files === null) {
    return null
  }
  return { pass, fail, skip, expect_count, files }
}

/**
 * Count TS error lines surfaced by the repo's typecheck runner. The wrapped
 * `tsc` diagnostics still use the canonical
 * `path/file.ts(LINE,COL): error TSxxxx: …` shape, so we count exactly those
 * rows and ignore wrapper chatter / trailing summaries.
 */
export const countTscErrors = (text: string): number => {
  const re = /^[^\n]*\(\d+,\d+\):\s+error\s+TS\d+:/gm
  const matches = text.match(re)
  return matches?.length ?? 0
}

/**
 * Count Biome error rows in `biome check` output. Biome prints one
 * `path:line:col <category>` diagnostic line per error. As with tsc we use a
 * conservative pattern that only matches the diagnostic header rows.
 */
export const countBiomeErrors = (text: string): number => {
  const re = /^\s*×\s+/gm
  const matches = text.match(re)
  return matches?.length ?? 0
}

// ────────────────────────────────────────────────────────────────────────────
// Spawn helpers (impure — exercised by `bun tools/feature-catalog/refresh-baseline.ts`)
// ────────────────────────────────────────────────────────────────────────────

interface CmdResult {
  exit: number
  stdout: string
  stderr: string
}

export const TYPECHECK_BASELINE_CMD = ["bun", "run", "typecheck:all"] as const

const run = async (argv: string[], cwd: string): Promise<CmdResult> => {
  const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const exit = await proc.exited
  return { exit, stdout, stderr }
}

// ────────────────────────────────────────────────────────────────────────────
// Baseline shape — CANONICAL (see README / user spec).
// ────────────────────────────────────────────────────────────────────────────

interface TierCount {
  files: number
  tests: number
}

export interface Baseline {
  generated_at: string
  /** The commit measured. `null` when the tree is dirty or git is unavailable —
   *  the renderer treats that as STALE and asserts no verdict. */
  measured_at_commit: string | null
  tsc: { exit: number; errors: number }
  biome: { exit: number; errors: number }
  tests: {
    pass: number
    fail: number
    skip: number
    expect_count: number
    files: number
    by_tier: {
      unit: TierCount
      integration: TierCount
      contract: TierCount
    }
  }
  /**
   * The `fc` sub-ratchet block: `empty_stubs_max` plus the grandfathered
   * orphan-ADR and L3-reachability allowlists that `bun fc lint` compares against.
   *
   * This tool does not measure it, so it must be CARRIED. It used to build a fresh
   * object with no `fc` key and write it over the file, so one run would have
   * deleted the cap and all nineteen grandfathered ADR paths and turned a
   * tolerated backlog into a red gate. Nobody had run it, which is the only reason
   * the data survived.
   */
  fc?: unknown
}

/**
 * The commit the measurement describes, or `null` when it describes nothing
 * citable.
 *
 * A dirty tree returns `null` on purpose: the measurement would be of the working
 * tree while the recorded provenance would name the commit, and that gap is how
 * the catalog footer came to assert two toolchain failures the tree did not have.
 */
const measuredCommit = (repoRoot: string): string | null => {
  try {
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    if (dirty !== "") return null
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

/** Read the existing file for the blocks this refresher does NOT measure. */
const readPriorBaseline = async (path: string): Promise<{ fc?: unknown }> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as { fc?: unknown }
  } catch {
    return {}
  }
}

/** The measurements this tool actually takes — everything else must be carried. */
export type BaselineMeasurements = Omit<Baseline, "fc">

/**
 * Merge fresh measurements over the prior file, CARRYING every block this tool
 * does not measure.
 *
 * Pure and exported so the carry is provable without running the forty-minute
 * suite `main()` needs. Proven loss without it: the prior `fc` block holds
 * `empty_stubs_max` and nineteen grandfathered orphan-ADR paths that `bun fc lint`
 * compares against, and the un-merged write dropped all of it.
 */
export const composeBaseline = (
  prior: { fc?: unknown },
  measured: BaselineMeasurements,
): Baseline => ({
  ...measured,
  ...(prior.fc !== undefined ? { fc: prior.fc } : {}),
})

/** Serialize with stable key order + indent 2 for diff-friendly snapshots. */
const stringify = (b: Baseline): string => `${JSON.stringify(b, null, 2)}\n`

const isMain = (): boolean => {
  const argv1 = process.argv[1]
  if (argv1 === undefined) return false
  const here = fileURLToPath(import.meta.url)
  return here === argv1
}

const main = async (): Promise<number> => {
  const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
  const biomeBin = join(repoRoot, "node_modules/.bin/biome")

  process.stderr.write("[baseline] bun run typecheck:all …\n")
  const tsc = await run([...TYPECHECK_BASELINE_CMD], repoRoot)
  const tscErrors = countTscErrors(`${tsc.stdout}\n${tsc.stderr}`)

  process.stderr.write("[baseline] biome check …\n")
  const biomeTargets = collectBiomeTargets(repoRoot)
  const biome = await run([biomeBin, "check", ...biomeTargets], repoRoot)
  const biomeErrors = countBiomeErrors(`${biome.stdout}\n${biome.stderr}`)

  process.stderr.write("[baseline] bun test (unit + integration) …\n")
  const tests = await run(["bun", "test", "tests/unit", "tests/integration"], repoRoot)
  const summary = parseBunTestOutput(`${tests.stdout}\n${tests.stderr}`)
  if (summary === null) {
    process.stderr.write("[baseline] FATAL: could not parse bun test output\n")
    return 1
  }

  // best-effort per-tier file/test counts. `bun test` does not surface a
  // per-directory split in its summary, so we leave tests=0 and files=0
  // here — the catalog renderer can compute file counts from the FS if it
  // wants finer detail.
  const prior = await readPriorBaseline(join(repoRoot, "tools/feature-catalog/baseline.json"))
  const baseline = composeBaseline(prior, {
    generated_at: new Date().toISOString(),
    measured_at_commit: measuredCommit(repoRoot),
    tsc: { exit: tsc.exit, errors: tscErrors },
    biome: { exit: biome.exit, errors: biomeErrors },
    tests: {
      pass: summary.pass,
      fail: summary.fail,
      skip: summary.skip,
      expect_count: summary.expect_count,
      files: summary.files,
      by_tier: {
        unit: { files: 0, tests: 0 },
        integration: { files: 0, tests: 0 },
        contract: { files: 0, tests: 0 },
      },
    },
  })

  const outPath = join(repoRoot, "tools/feature-catalog/baseline.json")
  await writeFile(outPath, stringify(baseline), "utf8")

  process.stdout.write(
    `[baseline] wrote ${outPath}\n` +
      `  tsc:   exit=${tsc.exit} errors=${tscErrors}\n` +
      `  biome: exit=${biome.exit} errors=${biomeErrors}\n` +
      `  tests: ${summary.pass} pass / ${summary.fail} fail / ${summary.skip} skip` +
      ` / ${summary.expect_count} expect() across ${summary.files} files\n`,
  )
  return 0
}

if (isMain()) {
  const code = await main()
  process.exit(code)
}
