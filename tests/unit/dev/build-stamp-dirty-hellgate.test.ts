/**
 * Hellgate — the build stamp's dirty bit, and the ORDER it must be captured in.
 *
 * `tools/bin/build-cli.ts` shipped asserting the stamp is captured "BEFORE anything
 * else can touch the tree", and that capturing after `install-quanta-cli.sh`'s
 * `package.json` bump "would make every single build read `dirty`, which is worse
 * than no stamp because it is a stamp that always lies in the same direction". The
 * script bumps `package.json` and THEN calls `bun run build`, so that is exactly
 * what it did: every `bun run install:cli` binary was stamped `-dirty` and the bit
 * carried no information.
 *
 * Nothing could catch it. `build-cli.ts` compiles on import, so no test could touch
 * its logic, and the ordering lived in a shell script no test read.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  dirtyFromPorcelain,
  parsePresetDirty,
  resolveDirtyBit,
} from "../../../tools/dev/build-stamp-dirty"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

describe("the dirty bit", () => {
  test("only the two exact tokens the stamp writes are honoured as a preset", () => {
    expect(parsePresetDirty("0")).toBe("0")
    expect(parsePresetDirty("1")).toBe("1")
    // Anything else MEASURES instead of being coerced. `yes` pinning the bit to
    // clean would be a stamp that lies in one direction.
    for (const raw of [undefined, "", "yes", "true", "on", "off", "2", " 1", "1 ", "01"]) {
      expect(parsePresetDirty(raw), `${JSON.stringify(raw)} must not be honoured`).toBeUndefined()
    }
  })

  test("a clean tracked tree is 0 and any tracked modification is 1", () => {
    expect(dirtyFromPorcelain("")).toBe("0")
    expect(dirtyFromPorcelain("\n")).toBe("0")
    expect(dirtyFromPorcelain(" M package.json")).toBe("1")
    expect(dirtyFromPorcelain(" M a\n M b")).toBe("1")
  })

  /**
   * A FAILED probe is not a clean tree.
   *
   * `build-cli.ts`'s `git()` helper collapses a non-zero exit to `""`, so the first
   * version of this could not tell the two apart. Proven by execution with a shim
   * whose `git status` exits 128 (an `index.lock` collision — a hazard this repo
   * hits with concurrent sessions) against a genuinely modified tree: the build
   * printed `dirty=0`, a confident CLEAN stamp on a dirty tree. That is the same
   * one-directional lie `parsePresetDirty` refuses `yes` to prevent.
   */
  test("a failed probe fails safe to dirty, never to clean", () => {
    expect(dirtyFromPorcelain(null)).toBe("1")
    expect(resolveDirtyBit(undefined, () => null)).toBe("1")
    // An honoured preset still wins — the caller knows more than the probe.
    expect(resolveDirtyBit("0", () => null)).toBe("0")
    // …but an UNHONOURED preset must not rescue a failed probe into clean.
    expect(resolveDirtyBit("yes", () => null)).toBe("1")
  })

  test("an honoured preset wins over the measurement, and is not merely merged", () => {
    let measured = 0
    const porcelain = (): string => {
      measured += 1
      return " M package.json"
    }
    // The install-script case: the tree IS modified by the bump, and the caller
    // recorded that it was clean beforehand.
    expect(resolveDirtyBit("0", porcelain)).toBe("0")
    expect(measured, "an honoured preset must not even run the probe").toBe(0)
    // And the reverse, so the preset is not a one-way override.
    expect(resolveDirtyBit("1", () => "")).toBe("1")
  })

  test("an unhonoured preset falls through to the measurement", () => {
    expect(resolveDirtyBit("yes", () => "")).toBe("0")
    expect(resolveDirtyBit("yes", () => " M x")).toBe("1")
    expect(resolveDirtyBit(undefined, () => " M x")).toBe("1")
  })
})

describe("build-cli.ts measures the tracked tree only", () => {
  const buildCli = (): string => readFileSync(join(REPO_ROOT, "tools/bin/build-cli.ts"), "utf8")

  /**
   * With untracked files counted, a git WORKTREE's `node_modules` symlink reads as
   * drift — `.gitignore`'s `node_modules/` has a trailing slash and matches
   * directories only, so `git check-ignore node_modules` does not match it — and a
   * clean tracked tree stamped `-dirty`. Measured in this worktree before the fix.
   */
  test("the porcelain probe excludes untracked files", () => {
    const src = buildCli()
    expect(src).toContain('"--untracked-files=no"')
    expect(src).not.toMatch(/git\("status", "--porcelain"\)/)
  })

  /** The probe must go through the helper that reports FAILURE, not the one that
   *  collapses it to an empty string. */
  test("the dirty probe distinguishes a failed git from a clean tree", () => {
    const src = buildCli()
    expect(src).toContain('gitOrNull("status"')
    expect(src, "the collapsing helper must not feed the dirty bit").not.toMatch(
      /resolveDirtyBit\([^)]*\bgit\("status"/s,
    )
  })

  test("the dirty decision is delegated, not re-implemented inline", () => {
    expect(buildCli()).toContain("resolveDirtyBit(")
  })
})

describe("install-quanta-cli.sh captures the state BEFORE it bumps", () => {
  const script = (): string =>
    readFileSync(join(REPO_ROOT, "tools/bin/install-quanta-cli.sh"), "utf8")

  /**
   * The ordering assertion, as line positions rather than prose. The bump CANNOT
   * move after the build — the binary bundles `pkg.version`, so a later bump would
   * ship the old number — which is why the capture has to come first instead.
   */
  test("the export precedes both the package.json write and the build", () => {
    const src = script()
    const exportAt = src.indexOf("export QUANTA_BUILD_DIRTY")
    const bumpAt = src.indexOf("pkg.version =")
    const buildAt = src.indexOf("bun run build")
    expect(exportAt, "install-quanta-cli.sh no longer exports QUANTA_BUILD_DIRTY").toBeGreaterThan(
      -1,
    )
    expect(bumpAt, "the version bump is gone — re-anchor this guard").toBeGreaterThan(-1)
    expect(buildAt, "the build call is gone — re-anchor this guard").toBeGreaterThan(-1)
    expect(
      exportAt,
      "the dirty state is captured AFTER the bump — every build reads dirty",
    ).toBeLessThan(bumpAt)
    expect(exportAt).toBeLessThan(buildAt)
    // And the capture must itself exclude untracked files, or it records the same
    // false positive it exists to avoid.
    const captureBlock = src.slice(0, exportAt + 400)
    expect(captureBlock).toContain("--untracked-files=no")
    // …and it must check the EXIT STATUS. `2>/dev/null` plus an empty-string test
    // made a failing probe stamp the binary clean on a dirty tree.
    expect(captureBlock, "the shell capture must branch on git's exit status").toMatch(
      /if\s+dirty_out=\$\(git/,
    )
  })

  test("the bump still precedes the build — the binary bundles pkg.version", () => {
    const src = script()
    expect(src.indexOf("pkg.version =")).toBeLessThan(src.indexOf("bun run build"))
  })
})
