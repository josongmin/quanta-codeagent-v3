/**
 * Architecture ratchet — no leftover backup / worktree-merge scratch files.
 *
 * An earlier architecture audit found a committed backup *directory*
 * (`src/tool/git/moved-code.my-backup/`) plus a cluster of `.bak` /
 * `.my-backup` / `.from-worktree` files that had been accidentally tracked
 * by git. These are scratch artifacts left over from local backups and
 * worktree-merge conflict resolution; once committed they (a) confuse
 * tooling (e.g. the feature-catalog reachability scan had to special-case
 * skipping `.my-backup` / `.from-worktree` paths) and (b) silently rot.
 *
 * This ratchet prevents the class from recurring: it scans the TRACKED set
 * (`git ls-files`, so only committed/indexed paths — never local scratch a
 * dev is mid-edit on) under `src/`, `tests/`, and `tools/` for any path
 * whose basename matches a known backup/scratch suffix and FAILS, listing
 * the offenders.
 *
 * Notes:
 *  - We intersect with on-disk existence. A tracked path that has already
 *    been `rm`'d in the working tree (deletion pending a commit) is NOT a
 *    recurrence — it is in-flight cleanup — so it is not flagged. A genuine
 *    recurrence (a freshly added backup file) is both tracked AND present.
 *  - `git ls-files` (not a filesystem walk) is deliberate: a developer may
 *    keep a local `foo.ts.bak` while debugging; that is fine and must not
 *    fail CI. Only TRACKED backup files are forbidden.
 *
 * Zero hostile-input surface (read-only). Deterministic across platforms.
 */

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dir, "../../..")

/** Directory prefixes that are in scope for the ratchet. */
const SCOPED_PREFIXES = ["src/", "tests/", "tools/"] as const

/**
 * Forbidden backup/scratch suffixes. Anchored to the end of the path so
 * `.my-backup` matches both a file (`x.my-backup`) and any file INSIDE a
 * `*.my-backup/` directory (git tracks files, not dirs, so the directory
 * form shows up as `dir.my-backup/child.ts`).
 */
const FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
  /\.bak$/,
  /\.orig$/,
  /\.my-backup$/,
  /\.my-backup\//, // file inside a `*.my-backup/` directory
  /\.from-worktree$/,
]

/**
 * The floor BOTH halves of the offender list are held to.
 *
 * Measured against 8,776 tracked paths under the scoped prefixes, so it leaves
 * ~970 of headroom: a developer mid-`git rm` (files gone from the tree, still in
 * the index) stays green, while a tree the run cannot actually see — a sparse
 * checkout, an unmaterialised worktree, a mis-anchored root — does not.
 */
const CORPUS_FLOOR = 7804

function listTrackedFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "--", ...SCOPED_PREFIXES], {
    cwd: REPO_ROOT,
  })
  if (out.exitCode !== 0) {
    throw new Error(
      `git ls-files failed (exit ${out.exitCode}): ${new TextDecoder().decode(out.stderr)}`,
    )
  }
  const files = new TextDecoder()
    .decode(out.stdout)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  // Anti-vacuity: `git ls-files` exits 0 with no output when nothing matches, so
  // the exit check above is not a floor. The verdict is "no backup artifacts",
  // which an empty listing satisfies for free — proven, 2/0 against an empty
  // mirror of the repo tree.
  if (files.length < CORPUS_FLOOR) {
    throw new Error(
      `git ls-files returned ${files.length} tracked path(s) under ${SCOPED_PREFIXES.join(", ")} ` +
        `— far below the real tree; the backup-artifact verdict would pass over nothing.`,
    )
  }
  return files
}

function isBackupArtifact(path: string): boolean {
  return FORBIDDEN_PATTERNS.some((re) => re.test(path))
}

describe("arch: no leftover backup/worktree files", () => {
  test("no tracked .bak/.orig/.my-backup/.from-worktree files exist under src/tests/tools", () => {
    const tracked = listTrackedFiles()

    // The offender list is `tracked ∩ present`, and only the first half has a
    // floor. `existsSync` NARROWS, so a working tree the run cannot see — a sparse
    // checkout, a worktree whose files are not materialised, a mis-anchored
    // REPO_ROOT — empties the list and the verdict reads "no backup artifacts".
    // Measured: with the index intact and the tree blanked, this file passed 2/0.
    // Flooring the intersection is what makes the two states differ.
    const present = tracked.filter((p) => existsSync(resolve(REPO_ROOT, p)))
    if (present.length < CORPUS_FLOOR) {
      throw new Error(
        `only ${present.length} of ${tracked.length} tracked path(s) exist on disk — the ` +
          `working tree this run can see is far below the real one, so an empty offender ` +
          `list would mean "nothing was looked at" rather than "nothing was found".`,
      )
    }

    const offenders = present.filter(isBackupArtifact)

    expect(
      offenders,
      offenders.length > 0
        ? `Tracked backup/scratch files found (remove them from git):\n  ${offenders.join("\n  ")}`
        : "",
    ).toEqual([])
  })

  test("the forbidden-suffix matcher behaves as documented", () => {
    expect(isBackupArtifact("src/foo/index.ts.bak")).toBe(true)
    expect(isBackupArtifact("src/foo/index.ts.orig")).toBe(true)
    expect(isBackupArtifact("src/foo/index.ts.my-backup")).toBe(true)
    expect(isBackupArtifact("src/foo/x.my-backup/child.ts")).toBe(true)
    expect(isBackupArtifact("src/foo/index.ts.from-worktree")).toBe(true)
    // legitimate files are not flagged
    expect(isBackupArtifact("src/foo/index.ts")).toBe(false)
    expect(isBackupArtifact("tests/unit/foo.test.ts")).toBe(false)
    expect(isBackupArtifact("tools/feature-catalog/cli.ts")).toBe(false)
  })
})
