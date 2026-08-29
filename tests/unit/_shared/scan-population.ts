import { expect } from "bun:test"
import { existsSync } from "node:fs"
import { join, relative, resolve } from "node:path"

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

/** Absolute paths git tracks under `root` that still exist on disk. Cached per
 *  root: the index does not change mid-run, and if it did, a stale cache can
 *  only UNDER-count, which fails closed. */
const trackedCache = new Map<string, ReadonlySet<string>>()

const trackedUnder = (root: string): ReadonlySet<string> => {
  const key = resolve(root)
  const hit = trackedCache.get(key)
  if (hit !== undefined) return hit
  const out = Bun.spawnSync(["git", "ls-files", "-z", "--", key], { cwd: key, stdout: "pipe" })
  if (out.exitCode !== 0) {
    throw new Error(
      `assertScanPopulation: \`git ls-files\` failed under ${key} — reach cannot be measured, ` +
        `so no verdict below it means anything`,
    )
  }
  const paths = new Set(
    new TextDecoder()
      .decode(out.stdout)
      .split("\0")
      .filter((p) => p !== "")
      .map((p) => join(key, p))
      .filter((p) => existsSync(p)),
  )
  trackedCache.set(key, paths)
  return paths
}

export interface ScanPopulationOptions {
  /** Floor on the count of TRACKED files the scan reached. Defaults to 1. */
  readonly min?: number
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
  /** Floor on `matched`. Required whenever `matched` is given. */
  readonly minMatched?: number
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
  opts: ScanPopulationOptions = {},
): void => {
  const collectable =
    opts.collectable ?? ((n: string) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
  const skip = new Set(["node_modules", "__tests__", ...(opts.skipDirs ?? [])])
  const abs = resolve(root)
  const tracked = trackedUnder(abs)

  const reachedFiles = files.map((f) => resolve(f)).filter((f) => tracked.has(f))
  expect(
    reachedFiles.length,
    `the scan of ${abs} reached ${reachedFiles.length} TRACKED files ` +
      `(it returned ${files.length} paths in total — untracked ones are not reach)`,
  ).toBeGreaterThanOrEqual(opts.min ?? 1)

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
    if (opts.minMatched === undefined) {
      throw new Error(
        "assertScanPopulation: `matched` was given without `minMatched` — a second " +
          "number that is never compared is not a second number",
      )
    }
    expect(
      opts.matched.length,
      `the guard's own matcher selected ${opts.matched.length} of ${reachedFiles.length} ` +
        `reached files — a matcher that rotted selects nothing while the walk stays full`,
    ).toBeGreaterThanOrEqual(opts.minMatched)
  }
}
