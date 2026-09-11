/**
 * `test:clean-js` deleted files it does not own.
 *
 * # The measurement
 *
 * The command was:
 *
 *     find tests tools -name '*.js' -delete && \
 *     find src -name '*.js' ! -path 'src/ui/auth-ui.js' -delete
 *
 * `find` with no prune descends into every dot-directory, and this workspace
 * carries an ignored `tools/dev/.scratch` of 4,437 files / 132 MiB. Measured by
 * injecting 300 `.js` files under it:
 *
 *     entries visited    unpruned 11,832   dir-pruned 5,623
 *     .js files matched  unpruned    300   dir-pruned     0
 *
 * The 300 were not merely walked, they were DELETED. So the cleanup step
 * destroys other tools' scratch state, and its cost scales with whatever ambient
 * ignored corpus happens to be on the box — 11,531 entries visited with the
 * scratch present, against 5,622 without.
 *
 * Pruning dot-DIRECTORIES (not dot-files, which could in principle be a real
 * stale artifact) leaves the result set byte-identical on the real tree, which
 * is the licence for the change.
 *
 * # The dead exclusion, recorded rather than quietly deleted
 *
 * `! -path 'src/ui/auth-ui.js'` and `PRESERVED_SOURCE_JS` in
 * `run-test-shards.ts` both protect `src/ui/auth-ui.js`. That file does not
 * exist: `src/ui/` holds `index.ts` and `ui-helpers.ts`, and the real module is
 * `src/apps/cli/auth-ui.ts`. Nothing is lost today because `src/` has no tracked
 * `.js` at all — which is exactly what the last test here pins, so the day one
 * appears, the stale path is a red test rather than a deleted file.
 */

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assertScanPopulation } from "../_shared/scan-population"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

const cleanJsCommand = (): string => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    readonly scripts: Readonly<Record<string, string>>
  }
  const command = pkg.scripts["test:clean-js"]
  if (command === undefined) throw new Error("package.json has no test:clean-js script")
  return command
}

/** Run the REAL command string against a scratch tree, so the guard cannot
 *  drift from what `bun run test:clean-js` actually executes. */
const runCleanJsIn = (root: string): number => {
  const proc = Bun.spawnSync(["sh", "-c", cleanJsCommand()], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  return proc.exitCode ?? 1
}

const scratchTree = (): string => {
  const root = mkdtempSync(join(tmpdir(), "quanta-clean-js-"))
  for (const dir of ["tests", "tools", "src", "tools/.scratch/deep", "src/.cache"]) {
    mkdirSync(join(root, dir), { recursive: true })
  }
  return root
}

describe("test:clean-js", () => {
  test("removes stale .js under the tracked roots", () => {
    const root = scratchTree()
    try {
      const stale = [
        join(root, "tests", "leftover.js"),
        join(root, "tools", "leftover.js"),
        join(root, "src", "leftover.js"),
      ]
      for (const file of stale) writeFileSync(file, "// stale\n")
      expect(runCleanJsIn(root)).toBe(0)
      for (const file of stale) {
        expect({ file, present: existsSync(file) }).toEqual({ file, present: false })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("does NOT delete .js inside ignored dot-directories", () => {
    // The defect: 300 injected `.js` files under the real workspace's ignored
    // `tools/dev/.scratch` were matched and deleted by the unpruned form.
    const root = scratchTree()
    try {
      const foreign = [
        join(root, "tools", ".scratch", "deep", "keep.js"),
        join(root, "src", ".cache", "keep.js"),
      ]
      for (const file of foreign) writeFileSync(file, "// someone else's\n")
      expect(runCleanJsIn(root)).toBe(0)
      for (const file of foreign) {
        expect({ file, present: existsSync(file) }).toEqual({ file, present: true })
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("is idempotent and exits 0 with nothing to remove", () => {
    // `-print0 | xargs -0 rm -f` runs `rm -f` once with no operands when there
    // is no match; that must not be a non-zero exit in a `&&` chain.
    const root = scratchTree()
    try {
      expect(runCleanJsIn(root)).toBe(0)
      expect(runCleanJsIn(root)).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("the command prunes dot-directories, and says so in one place", () => {
    // ANTI-VACUITY: pin the mechanism, because the two behavioural tests above
    // would also pass over a command that walked nothing at all.
    const command = cleanJsCommand()
    expect(command).toContain("-type d -name '.*'")
    expect(command).toContain("-prune")
    expect(command).toContain("tests tools")
    expect(command).toContain("find src")
  })

  test("src has no tracked .js, so the stale preserve path costs nothing YET", () => {
    // `! -path 'src/ui/auth-ui.js'` in package.json and `PRESERVED_SOURCE_JS` in
    // run-test-shards.ts both protect a file that does not exist — `src/ui/`
    // holds index.ts and ui-helpers.ts, and the real module is
    // `src/apps/cli/auth-ui.ts`. Harmless only while `src/` has no tracked `.js`.
    // When one appears, this goes red and the stale path gets fixed instead of
    // the file getting deleted.
    const tracked = Bun.spawnSync(["git", "ls-files", "src/**/*.js", "src/*.js"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    const listed = tracked.stdout
      .toString()
      .split("\n")
      .filter((line) => line.trim() !== "")
    expect(listed).toEqual([])

    // ANTI-VACUITY, through the SHARED mechanism rather than a hand-written
    // floor: `git ls-files` must be working here, or an empty `src/` result
    // proves nothing. The repo does track .js files, just not under src/, and
    // that reach is pinned in scan-reach-baseline.json so it cannot quietly
    // drop to zero.
    const anywhere = Bun.spawnSync(["git", "ls-files", "*.js"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    const trackedJs = anywhere.stdout
      .toString()
      .split("\n")
      .filter((line) => line.trim() !== "")
    assertScanPopulation(
      trackedJs.map((rel) => join(REPO_ROOT, rel)),
      REPO_ROOT,
      {
        collectable: (name) => name.endsWith(".js"),
        id: "tests/unit/dev/source-js-cleanup.test.ts#TRACKED_JS",
      },
    )

    expect(existsSync(join(REPO_ROOT, "src", "ui", "auth-ui.js"))).toBe(false)
    expect(existsSync(join(REPO_ROOT, "src", "apps", "cli", "auth-ui.ts"))).toBe(true)
  })
})
