import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  collectBiomeTargets,
  isMirrorJsArtifact,
  shouldIncludeBiomeTarget,
} from "../../tools/dev/biome-targets"

const write = (root: string, rel: string, body = ""): void => {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, body, "utf8")
}

// Every fixture tree is registered here and removed in `afterAll`. A leaked
// `mkdtemp` root is not a private mess: this repo has a recorded incident where
// accumulated temp fixtures made `ls /tmp` slow enough to turn UNRELATED tests
// red. Four roots per run, once per suite invocation, adds up fast.
// (macOS: `tmpdir()` here is `/tmp`, a symlink whose real path is
// `/private/tmp`; `rmSync` follows the path it was handed either way.)
const fixtureRoots: string[] = []

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "biome-targets-"))
  fixtureRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true })
  fixtureRoots.length = 0
})

describe("biome target selection", () => {
  test("excludes JS twins when sibling TypeScript is authoritative", () => {
    const root = makeRoot()
    write(root, "src/agent/loop.ts", "export const loop = 1\n")
    write(root, "src/agent/loop.js", "export const loop = 1\n")

    expect(isMirrorJsArtifact(root, "src/agent/loop.js")).toBe(true)
    expect(shouldIncludeBiomeTarget(root, "src/agent/loop.js")).toBe(false)
    expect(shouldIncludeBiomeTarget(root, "src/agent/loop.ts")).toBe(true)
  })

  test("keeps real JS authority files and excludes known noise paths", () => {
    const root = makeRoot()
    write(root, "src/apps/cli/config-assemble.js", "export const x = 1\n")
    write(root, "tests/unit/foo.test.ts", "export {}\n")
    write(root, "tests/unit/foo.test.js", "export {}\n")
    write(root, "tests/smoke/fixtures/case.ts", "export {}\n")
    write(root, "src/types.d.ts", "export interface X {}\n")
    write(root, "src/agent/loop.ts.from-worktree", "export {}\n")
    write(root, "src/agent/cache.ts.my-backup.ts", "export {}\n")

    const targets = collectBiomeTargets(root)

    expect(targets).toContain("src/apps/cli/config-assemble.js")
    expect(targets).toContain("tests/unit/foo.test.ts")
    expect(targets).not.toContain("tests/unit/foo.test.js")
    expect(targets).not.toContain("tests/smoke/fixtures/case.ts")
    expect(targets).not.toContain("src/types.d.ts")
    expect(targets).not.toContain("src/agent/loop.ts.from-worktree")
    expect(targets).not.toContain("src/agent/cache.ts.my-backup.ts")
  })

  test("skips dot-directories, which hold gitignored COPIES of real modules", () => {
    const root = makeRoot()
    // Paired control: a NORMAL nested directory, so the dot-dir assertions below
    // cannot be satisfied by an enumerator that returns nothing.
    write(root, "src/agent/loop.ts", "export const loop = 1\n")
    write(root, "tests/unit/keep.test.ts", "export {}\n")
    // The real defect: `tools/dev/.scratch` is a gitignored 132MB copy of the
    // repo. Enumerating a dot-dir counts scratch duplicates as lint targets and
    // makes every debt ceiling machine-dependent.
    write(root, "src/.scratch/copy.ts", "export const loop = 1\n")
    write(root, "src/.scratch/nested/deep.ts", "export {}\n")
    write(root, "tests/.cache/stale.test.ts", "export {}\n")

    const targets = collectBiomeTargets(root)

    expect(targets).not.toContain("src/.scratch/copy.ts")
    expect(targets).not.toContain("src/.scratch/nested/deep.ts")
    expect(targets).not.toContain("tests/.cache/stale.test.ts")
    expect(targets.filter((t) => t.split("/").includes(".scratch"))).toEqual([])

    // Anti-vacuity + paired control: the ordinary tree is still enumerated.
    expect(targets).toContain("src/agent/loop.ts")
    expect(targets).toContain("tests/unit/keep.test.ts")
    expect(targets.length).toBeGreaterThan(0)
  })

  test("enumerates the default source roots, and only those", () => {
    const root = makeRoot()
    write(root, "src/agent/loop.ts", "export {}\n")
    write(root, "tests/unit/keep.test.ts", "export {}\n")
    write(root, "tools/dev/script.ts", "export {}\n")

    expect(collectBiomeTargets(root)).toEqual(["src/agent/loop.ts", "tests/unit/keep.test.ts"])
    // Pins that the root list is a PARAMETER, not the whole tree: `tools/` is
    // reachable, it is simply not in the default universe.
    expect(collectBiomeTargets(root, ["tools"])).toEqual(["tools/dev/script.ts"])
  })
})
