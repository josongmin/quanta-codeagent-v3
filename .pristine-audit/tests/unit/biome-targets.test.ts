import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
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

describe("biome target selection", () => {
  test("excludes JS twins when sibling TypeScript is authoritative", () => {
    const root = mkdtempSync(join(tmpdir(), "biome-targets-"))
    write(root, "src/agent/loop.ts", "export const loop = 1\n")
    write(root, "src/agent/loop.js", "export const loop = 1\n")

    expect(isMirrorJsArtifact(root, "src/agent/loop.js")).toBe(true)
    expect(shouldIncludeBiomeTarget(root, "src/agent/loop.js")).toBe(false)
    expect(shouldIncludeBiomeTarget(root, "src/agent/loop.ts")).toBe(true)
  })

  test("keeps real JS authority files and excludes known noise paths", () => {
    const root = mkdtempSync(join(tmpdir(), "biome-targets-"))
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
})
