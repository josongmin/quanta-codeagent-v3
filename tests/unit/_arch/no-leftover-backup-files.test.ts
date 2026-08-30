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
import { join, resolve } from "node:path"

import { assertScanPopulation } from "../_shared/scan-population"

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
  return files
}

function isBackupArtifact(path: string): boolean {
  return FORBIDDEN_PATTERNS.some((re) => re.test(path))
}

describe("arch: no leftover backup/worktree files", () => {
  test("no tracked .bak/.orig/.my-backup/.from-worktree files exist under src/tests/tools", () => {
    const tracked = listTrackedFiles()

    // The offender list is `tracked ∩ present`, and `existsSync` NARROWS: a
    // working tree the run cannot see — a sparse checkout, a worktree whose files
    // are not materialised, a mis-anchored REPO_ROOT — empties the list and the
    // verdict reads "no backup artifacts". Measured: with the index intact and
    // the tree blanked, this file passed 2/0.
    //
    // Both halves used to be held to one number written here, at 7,804 of the
    // 8,776 real paths. That is a number this author picked and it tolerates
    // losing ~970 files, INCLUDING a whole subtree — a count stays high while a
    // directory disappears. The floor is now per-prefix, at the committed
    // measured reach, and it carries the claim a count cannot make: every
    // directory holding a tracked file must contribute one.
    const present = tracked.filter((p) => existsSync(resolve(REPO_ROOT, p)))
    for (const prefix of SCOPED_PREFIXES) {
      const root = join(REPO_ROOT, prefix)
      assertScanPopulation(
        present.filter((p) => p.startsWith(prefix)).map((p) => resolve(REPO_ROOT, p)),
        root,
        {
          id: `tests/unit/_arch/no-leftover-backup-files.test.ts#${prefix.replace(/\/$/, "")}`,
          collectable: () => true,
        },
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
