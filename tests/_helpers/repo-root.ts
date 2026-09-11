/**
 * Repository root resolution for tests that spawn a REAL entrypoint.
 *
 * WHY THIS EXISTS. Three subprocess suites carried the author's checkout path
 * as a literal:
 *
 *     const REPO_ROOT = "/Users/songmin/quanta-codeagent-v3"
 *
 * That is not a cosmetic wart. It is a test that passes on exactly one machine
 * and, on every other one, spawns `bun <path that does not exist>` — which Bun
 * reports as a normal non-zero exit with a message on stderr, i.e. the same
 * observable shape several of those cases assert as their PASS. A hosted Linux
 * runner, a second local checkout, a `git worktree` under `.claude/worktrees/`,
 * and the `.pristine-audit` extraction workflow are all different absolute
 * prefixes; none of them is the literal above.
 *
 * THE MARKER is the root `package.json` whose `name` is {@link REPO_PACKAGE_NAME},
 * walked upward from a starting directory (`import.meta.dir` of the caller, or
 * of this file). Deliberately NOT `.git`, for three measured reasons:
 *
 *   1. A `git worktree` checkout has `.git` as a FILE, not a directory, so a
 *      naive `existsSync(join(d, ".git"))` is already two different things.
 *   2. `git archive origin/main | tar -x` into `<repo>/.pristine-audit` — the
 *      repo's own baseline-audit recipe — produces a tree with NO `.git` at
 *      all. Walking up from a file inside it would sail past the mirror and
 *      return the OUTER checkout, which is the exact confusion the mirror was
 *      created to avoid. The `package.json` marker stops at the mirror, which
 *      is the correct answer.
 *   3. A `.git` walk cannot tell "this repository" from "some repository";
 *      the package name can.
 *
 * NOT a fixed number of `..` segments (`join(import.meta.dir, "..", "..")`,
 * the prevailing idiom in this tree): that encodes the caller's DEPTH, so
 * moving a test from `tests/unit/` to `tests/unit/kernel/` silently retargets
 * the root one level up and every path built from it still "resolves" — to the
 * wrong place. The marker walk is depth-independent.
 */

import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/** The `name` field of the repository's root `package.json` — the marker. */
export const REPO_PACKAGE_NAME = "quanta-codeagent"

const isRepoRoot = (dir: string): boolean => {
  const manifest = join(dir, "package.json")
  if (!existsSync(manifest)) return false
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"))
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { name?: unknown }).name === REPO_PACKAGE_NAME
    )
  } catch {
    // A `package.json` that does not parse is not this repository's root; keep
    // walking rather than throwing, so a stray malformed manifest in an
    // intermediate directory cannot mask the real root above it.
    return false
  }
}

/**
 * Walk upward from `startDir` to the directory holding the marker manifest.
 *
 * Throws — never returns a guess. A test that cannot locate its own checkout
 * must fail with that sentence rather than spawn a path that does not exist and
 * let the child's "file not found" be read as the behaviour under test.
 */
export const repoRootFrom = (startDir: string): string => {
  let cursor = resolve(startDir)
  const visited: string[] = []
  for (;;) {
    visited.push(cursor)
    if (isRepoRoot(cursor)) return cursor
    const parent = dirname(cursor)
    if (parent === cursor) {
      throw new Error(
        `repoRootFrom: no package.json with name "${REPO_PACKAGE_NAME}" found walking up from ` +
          `${resolve(startDir)} (visited ${visited.length} directories, up to ${cursor}). ` +
          `Tests that spawn a repository entrypoint cannot run outside a checkout.`,
      )
    }
    cursor = parent
  }
}

/**
 * This checkout's root, resolved from THIS file's location.
 *
 * Computed once at module load: the answer cannot change within a process, and
 * a per-call walk would re-`stat` on every spawn in a subprocess suite.
 */
export const REPO_ROOT: string = repoRootFrom(import.meta.dir)

/**
 * An absolute path to a repository-relative file, checked for existence.
 *
 * The existence check is the point. `join(root, rel)` of a MOVED entrypoint is
 * a perfectly well-formed string, and handing it to `Bun.spawn` reproduces the
 * hard-coded-path failure mode one layer down.
 */
export const repoFileFrom = (root: string, relativePath: string): string => {
  const absolute = join(root, relativePath)
  if (!existsSync(absolute)) {
    throw new Error(
      `repoFileFrom: ${relativePath} does not exist under repository root ${root} ` +
        `(resolved to ${absolute}). Spawning it would fail as an ordinary non-zero exit, ` +
        `which is indistinguishable from the behaviour these suites assert.`,
    )
  }
  return absolute
}

/** {@link repoFileFrom} against {@link REPO_ROOT}. */
export const repoFile = (relativePath: string): string => repoFileFrom(REPO_ROOT, relativePath)

/**
 * The exact argv the subprocess suites hand to `Bun.spawn`.
 *
 * Exposed as a function — rather than leaving each suite to build its own
 * `["bun", ENTRY, ...args]` — so the portability regression can assert on the
 * RESOLVED ARGV a foreign checkout produces, not merely on a root string. A
 * root that resolves correctly while the argv is assembled wrong is still a
 * broken spawn.
 */
export const bunEntryArgvFrom = (
  root: string,
  relativePath: string,
  args: readonly string[] = [],
): readonly string[] => ["bun", repoFileFrom(root, relativePath), ...args]

/** {@link bunEntryArgvFrom} against {@link REPO_ROOT}. */
export const bunEntryArgv = (
  relativePath: string,
  args: readonly string[] = [],
): readonly string[] => bunEntryArgvFrom(REPO_ROOT, relativePath, args)
