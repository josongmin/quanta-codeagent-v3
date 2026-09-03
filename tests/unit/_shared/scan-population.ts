import { expect } from "bun:test"
import { appendFileSync, existsSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { readScanReachBaseline, type ScanReach } from "../../../tools/dev/scan-reach-baseline"

/**
 * A guard that examined NOTHING reports the same value as a clean repo: no
 * violations. Every scanning guard therefore has to say what it reached — and
 * the evidence it offers has to be evidence.
 *
 * THREE claims, because each of the first two was measured passing over a tree
 * that had lost the thing it was guarding:
 *
 *  1. REACH — the scan reached at least `min` TRACKED files.
 *  2. COVERAGE — every directory holding a tracked, collectable file
 *     contributed at least one, at any depth.
 *  3. PREDICATE — optionally, that the guard's own matcher still selects
 *     something (`matched` / `minMatched`).
 *
 * WHY TRACKED FILES AND NOT A WALK. A filesystem walk accepts untracked and
 * gitignored files as proof of reach. Measured on this repo: `tools/dev/.scratch`
 * is a gitignored twin of `src/` holding 4,394 `.ts` files. And measured on THIS
 * helper, in its previous walk-backed form: with every real source file deleted
 * and only a gitignored twin left standing, the floor passed. That is the exact
 * failure the floor exists to prevent, committed inside the instrument. So reach
 * is now the intersection of what the scan returned with what git tracks, and a
 * tracked path that no longer exists on disk is not reach either.
 *
 * WHY A COUNT IS NOT ENOUGH. Losing one subtree leaves the count high — measured
 * twice here, on the PEP fence and on `assertWalkFloor`. And a claim about
 * immediate children does not see a NESTED loss: dropping `src/agent/loop` left
 * a one-level floor green at 3,337 files against a floor of 500. So coverage is
 * recursive, and derived from the tracked set rather than from the walk under
 * test — deriving it from that walk would make a lost subtree vanish from both
 * sides of the comparison.
 */

/** Absolute tracked paths, cached once per Git worktree rather than once per
 * scan root. Slice-boundary tests cover 49 sibling roots; asking Git to parse
 * the same index 49 times is pure duplicate work. */
const repositoryTrackedCache = new Map<string, ReadonlySet<string>>()
const rootRepositoryCache = new Map<string, string>()

const gitRepositoryRoot = (root: string): string => {
  const cached = rootRepositoryCache.get(root)
  if (cached !== undefined) return cached
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const repository = new TextDecoder().decode(result.stdout).trim()
  if (result.exitCode !== 0 || !isAbsolute(repository)) {
    throw new Error(
      `assertScanPopulation: \`git rev-parse\` failed under ${root} — reach cannot be measured, ` +
        "so no verdict below it means anything",
    )
  }
  rootRepositoryCache.set(root, repository)
  return repository
}

const trackedRepositoryFiles = (repository: string): ReadonlySet<string> => {
  const cached = repositoryTrackedCache.get(repository)
  if (cached !== undefined) return cached
  // --full-name makes output relative to the repository root regardless of the
  // caller's scan directory. The old per-root command could emit a different
  // prefix shape and then cache a false empty intersection for the whole run.
  const result = Bun.spawnSync(["git", "ls-files", "--full-name", "-z"], {
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `assertScanPopulation: \`git ls-files\` failed under ${repository} — reach cannot be ` +
        "measured, so no verdict below it means anything",
    )
  }
  const tracked = new Set(
    new TextDecoder()
      .decode(result.stdout)
      .split("\0")
      .filter((path) => path !== "")
      .map((path) => join(repository, path))
      .filter((path) => existsSync(path)),
  )
  repositoryTrackedCache.set(repository, tracked)
  return tracked
}

const isWithin = (root: string, path: string): boolean => {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

const trackedUnder = (root: string): ReadonlySet<string> => {
  const key = resolve(root)
  const repository = gitRepositoryRoot(key)
  return new Set([...trackedRepositoryFiles(repository)].filter((path) => isWithin(key, path)))
}

export interface ScanPopulationOptions {
  /**
   * This scan's identity in `tools/dev/scan-reach-baseline.json`, which is where
   * its floor lives. An inline number would be a number the author picked; the
   * observed equilibrium for such a parameter in this repo is `1`. An id with no
   * pinned row FAILS rather than defaulting — a closed universe is the only
   * thing that stops a new guard shipping with no reach at all.
   */
  readonly id: string
  /** Does this filename count? Must match the caller's own filter, or a subtree
   *  of `.md` reads as lost. */
  readonly collectable?: (name: string) => boolean
  /** Directory names the caller's walk deliberately omits. */
  readonly skipDirs?: readonly string[]
  /** The walk does NOT recurse: the coverage claim becomes its non-recursive
   *  equivalent — every collectable file sitting directly in `root` appears. */
  readonly topLevelOnly?: boolean
  /**
   * The SECOND number. `files` proves the anchor; this proves the predicate.
   * A matcher that rotted after a refactor selects nothing while the walk stays
   * full, and a floor on the walk alone clears it.
   */
  readonly matched?: readonly string[]
  /**
   * TEST SEAM — point the floor at a different baseline file. Only the helper's
   * own hellgate uses it, so its fixtures do not have to be pinned in the real
   * baseline. A guard that set this would be reading floors nobody reviews, and
   * that is visible in a diff.
   */
  readonly baselinePath?: string
  /**
   * TEST SEAM — this call measures a temp fixture, not this repository, so its
   * reach is not recorded.
   *
   * MEASURED: a cold campaign, otherwise 20 of 21 green, was refused by
   * `bun run scan-reach` over the ids "fx" and "not-pinned" — the synthetic
   * fixtures in this helper's own hellgate, appended to the shared sink on
   * every full run. The message was "an enrolled scan with no ledger entry is
   * one nobody is accountable for", about scans that were never enrolled and
   * never should be.
   *
   * `baselinePath` is NOT the discriminator, though it looks like one:
   * `scan-reach-cli-hellgate` sets it in a child fixture whose whole premise is
   * that reach IS recorded before the assertion fails. Nor can the hellgate
   * redirect the sink through the environment — a chunk runs its files
   * concurrently in one process, so it would capture its peers' rows and drop
   * them from the real ledger.
   *
   * A guard that set this by mistake does not vanish quietly: its pinned floor
   * then has no reporter, which `scan-reach` refuses as "pinned but no guard
   * reported it".
   */
  readonly fixture?: boolean
}

/**
 * The measured reach, appended for `bun run scan-reach` to harvest. Recording is
 * opt-in so a normal test run neither writes nor depends on it.
 */
const record = (opts: ScanPopulationOptions, walked: number): void => {
  const sink = process.env.QUANTA_SCAN_REACH_RECORD
  if (sink === undefined || sink === "") return
  if (opts.fixture === true) return
  const line = { id: opts.id, walked, matched: opts.matched?.length }
  appendFileSync(sink, `${JSON.stringify(line)}\n`)
}

const floorFor = (id: string, path?: string): ScanReach => {
  const pinned = readScanReachBaseline(path).scans[id]
  if (pinned === undefined) {
    throw new Error(
      `assertScanPopulation: no reach floor pinned for "${id}". Add it to ` +
        `tools/dev/scan-reach-baseline.json (\`bun run scan-reach --tighten\` writes the ` +
        `measured value) — an unpinned scan is exactly the hole this floor exists to close.`,
    )
  }
  return pinned
}

const isSkippedName = (name: string, skip: ReadonlySet<string>): boolean =>
  skip.has(name) || name.startsWith(".")

/** Directories under `root` that hold a tracked collectable file but contributed
 *  nothing to the scan — recursive, and derived from the TRACKED set. */
const missingSubtrees = (
  root: string,
  tracked: ReadonlySet<string>,
  reached: ReadonlySet<string>,
  collectable: (name: string) => boolean,
  skip: ReadonlySet<string>,
): string[] => {
  const holders = new Set<string>()
  for (const abs of tracked) {
    const rel = relative(root, abs)
    const parts = rel.split("/")
    const name = parts[parts.length - 1] ?? ""
    if (!collectable(name)) continue
    if (parts.some((p, i) => i < parts.length - 1 && isSkippedName(p, skip))) continue
    for (let i = 1; i < parts.length; i++) holders.add(parts.slice(0, i).join("/"))
  }
  return [...holders].filter((dir) => !reached.has(dir)).sort()
}

export const assertScanPopulation = (
  files: readonly string[],
  root: string,
  opts: ScanPopulationOptions,
): void => {
  const collectable =
    opts.collectable ?? ((n: string) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
  const skip = new Set(["node_modules", "__tests__", ...(opts.skipDirs ?? [])])
  const requestedRoot = resolve(root)
  // macOS exposes /tmp as a symlink to /private/tmp while Git reports its
  // physical worktree root. Canonicalize the root once, then translate caller
  // paths relative to it; resolving every file separately would both repeat I/O
  // and accidentally follow file-level symlinks into a tracked target.
  const abs = realpathSync(requestedRoot)
  const canonicalUnderRoot = (path: string): string =>
    resolve(abs, relative(requestedRoot, resolve(path)))
  const tracked = trackedUnder(abs)

  // Reach is a SET of files the guard would actually collect.
  //
  // Three ways it used to be padded, each measured: the same tracked path handed
  // in five times counted five times (14 real files met a floor of 70); a file
  // the guard's own `collectable` rejects counted anyway, so a `.md` beside the
  // `.ts` the scan is about filled the floor; and a path under a `skipDirs`
  // subtree counted even though the walker never descends there. A floor met by
  // files the verdict does not consume measures a population the guard does not
  // read.
  // The skip policy applied to REACH is what the CALLER declared, plus
  // `node_modules` — never the coverage-side default. `__tests__` is in that
  // default and NOT every walker honours it: `memory-fence-no-llm-import`
  // recurses into `src/memory/__tests__` and reads all four files there, so
  // filtering them out of reach discarded four files the guard genuinely
  // enumerated. On the coverage side the default is lenient (it excuses a
  // subtree from being demanded); on the reach side the same set is strict, and
  // a lenient default cannot be reused as a strict one.
  const reachSkip = new Set(["node_modules", ...(opts.skipDirs ?? [])])
  const skippedByPolicy = (abs_: string): boolean =>
    relative(abs, abs_)
      .split("/")
      .slice(0, -1)
      .some((seg) => reachSkip.has(seg))
  const reachedFiles = [
    ...new Set(
      files
        .map(canonicalUnderRoot)
        .filter((f) => tracked.has(f))
        .filter((f) => collectable(f.slice(f.lastIndexOf("/") + 1)))
        .filter((f) => !skippedByPolicy(f)),
    ),
  ]
  record(opts, reachedFiles.length)
  const pinned = floorFor(opts.id, opts.baselinePath)
  expect(
    reachedFiles.length,
    `the scan of ${abs} reached ${reachedFiles.length} TRACKED files ` +
      `(it returned ${files.length} paths in total — untracked ones are not reach). ` +
      `Floor for "${opts.id}" is ${pinned.walked}, from tools/dev/scan-reach-baseline.json`,
  ).toBeGreaterThanOrEqual(pinned.walked)

  if (opts.topLevelOnly === true) {
    const reachedNames = new Set(reachedFiles.map((f) => relative(abs, f)))
    const onDisk = [...tracked]
      .map((f) => relative(abs, f))
      .filter((rel) => !rel.includes("/") && collectable(rel))
    expect(
      onDisk.filter((name) => !reachedNames.has(name)),
      `these files are tracked directly in ${abs} but the scan did not enumerate them`,
    ).toEqual([])
  } else {
    const reachedDirs = new Set<string>()
    for (const f of reachedFiles) {
      const parts = relative(abs, f).split("/")
      for (let i = 1; i < parts.length; i++) reachedDirs.add(parts.slice(0, i).join("/"))
    }
    expect(
      missingSubtrees(abs, tracked, reachedDirs, collectable, skip),
      `these subtrees of ${abs} hold tracked collectable files but the scan enumerated none of them`,
    ).toEqual([])
  }

  if (opts.matched !== undefined) {
    if (pinned.matched === undefined) {
      throw new Error(
        `assertScanPopulation: "${opts.id}" reported a matched set but pins no matched ` +
          `floor — a second number that is never compared is not a second number`,
      )
    }
    // The matched set must be drawn from what was REACHED, and counted once
    // each. Comparing lengths alone accepted any five strings — five copies of
    // one name, or names of files the scan never returned — so a predicate proof
    // could be met without the predicate selecting anything real.
    const reachedSet = new Set(reachedFiles)
    const matchedAbs = [...new Set(opts.matched.map(canonicalUnderRoot))]
    const strangers = matchedAbs.filter((m) => !reachedSet.has(m))
    expect(
      strangers,
      `the matched set for "${opts.id}" names ${strangers.length} path(s) the scan never ` +
        `reached — a second number drawn from outside the first is not a second number`,
    ).toEqual([])
    expect(
      matchedAbs.length,
      `the matcher for "${opts.id}" selected ${matchedAbs.length} of ${reachedFiles.length} ` +
        `reached files (distinct, and drawn from the reached set) — a matcher that rotted ` +
        `selects nothing while the walk stays full`,
    ).toBeGreaterThanOrEqual(pinned.matched)
  } else if (pinned.matched !== undefined) {
    throw new Error(
      `assertScanPopulation: "${opts.id}" pins a matched floor of ${pinned.matched} but the ` +
        `guard passed no matched set — the pinned number would never be checked`,
    )
  }
}

/**
 * The other way a scan-derived verdict can be sound: it FAILS CLOSED.
 *
 * Some enumerations need no reach floor, because an empty walk does not make the
 * verdict green — it makes it red. `countTestFilesUnder` in
 * `gated-test-scope-ratchet` is the live case: it counts the files a gate
 * positional selects, so a walk that reached nothing scores EVERY token at zero
 * and the assertion consuming it reports every token as selecting nothing.
 *
 * That is a real exemption and it was, briefly, an unchecked one — recorded in a
 * comment, verified by nobody. An exemption nothing tests is the escape hatch
 * every remaining migration reaches for, and this campaign exists because of
 * exemptions like that. So the claim is EXECUTED: run the verdict over an empty
 * enumeration and require it to throw.
 *
 * `verdictOverEmpty` must be the real consumer with an empty list, not a
 * restatement of it. A thunk that throws for its own reasons proves nothing, so
 * the paired control belongs beside every use: the same consumer over the REAL
 * enumeration must pass.
 */
export const assertFailsClosedOnEmpty = (label: string, verdictOverEmpty: () => void): void => {
  let threw = false
  try {
    verdictOverEmpty()
  } catch {
    threw = true
  }
  expect(
    threw,
    `${label}: the verdict PASSED over an EMPTY enumeration. It does not fail closed, so the ` +
      `scan needs a reach floor — see tools/dev/scan-enrollment-debt.json`,
  ).toBe(true)
}
