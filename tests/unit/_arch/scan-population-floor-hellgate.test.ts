/**
 * The floor is itself a guard, so it gets the treatment it exists to impose:
 * each claim is shown RED under an injection that removes exactly the thing the
 * claim protects, against a paired control that stays green.
 *
 * The fixtures are REAL git repositories, because the contract is about what git
 * tracks. A fixture that faked the tracked set would be testing a mock of the
 * one thing that went wrong.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertScanPopulation } from "../_shared/scan-population"

const made: string[] = []
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A repo with `alpha/mod.ts` + `beta/mod.ts` tracked, `docs/note.md` tracked,
 *  and an IGNORED twin holding many `.ts` files. */
const build = (): string => {
  const repo = mkdtempSync(join(tmpdir(), "scan-pop-"))
  made.push(repo)
  const run = (...args: string[]): void => {
    const r = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" })
    if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed in fixture`)
  }
  run("init", "-q")
  run("config", "user.email", "t@t.t")
  run("config", "user.name", "t")
  mkdirSync(join(repo, "src"), { recursive: true })
  for (const sub of ["alpha", "beta"]) {
    mkdirSync(join(repo, "src", sub), { recursive: true })
    writeFileSync(join(repo, "src", sub, "mod.ts"), "export const x = 1\n")
  }
  mkdirSync(join(repo, "src", "docs"), { recursive: true })
  writeFileSync(join(repo, "src", "docs", "note.md"), "# no source here\n")
  mkdirSync(join(repo, "src", "twin"), { recursive: true })
  for (let i = 0; i < 50; i++) {
    writeFileSync(join(repo, "src", "twin", `m${i}.ts`), `export const b${i} = ${i}\n`)
  }
  writeFileSync(join(repo, ".gitignore"), "src/twin/\n")
  run("add", "-A")
  run("commit", "-qm", "init")
  return join(repo, "src")
}

/** What the guard's own walk returns — the filesystem view, twin included. */
const walk = (root: string, skipSubtree?: string): string[] =>
  ["alpha", "beta"].filter((s) => s !== skipSubtree).map((s) => join(root, s, "mod.ts"))

const twinFiles = (root: string): string[] =>
  Array.from({ length: 50 }, (_, i) => join(root, "twin", `m${i}.ts`))

describe("population floor", () => {
  test("a walk that reached everything passes (paired control)", () => {
    const root = build()
    expect(() => assertScanPopulation(walk(root), root)).not.toThrow()
  })

  test("INJECTION: an empty walk is red — 'found nothing' is not 'nothing to find'", () => {
    const root = build()
    expect(() => assertScanPopulation([], root)).toThrow(/reached 0 TRACKED files/)
  })

  test("INJECTION: an IGNORED twin is not reach, even 50 files of it", () => {
    const root = build()
    // The defect this contract exists for, reproduced: every real source file is
    // gone and only a gitignored twin remains. The walk-backed form of this
    // helper PASSED here — measured, in this repo, before the rewrite.
    expect(() => assertScanPopulation(twinFiles(root), root, { min: 2 })).toThrow(
      /reached 0 TRACKED files/,
    )
  })

  test("INJECTION: a tracked path that no longer exists on disk is not reach", () => {
    const root = build()
    rmSync(join(root, "alpha"), { recursive: true, force: true })
    rmSync(join(root, "beta"), { recursive: true, force: true })
    // Still in the index; gone from the tree. `git ls-files` alone would count
    // both and report a healthy population over an empty checkout.
    expect(() => assertScanPopulation(walk(root), root, { min: 2 })).toThrow(
      /reached 0 TRACKED files/,
    )
  })

  test("INJECTION: losing ONE subtree is red, which a count floor cannot see", () => {
    const root = build()
    expect(() => assertScanPopulation(walk(root, "beta"), root, { min: 1 })).toThrow(
      /enumerated none of them/,
    )
  })

  test("INJECTION: a NESTED subtree loss is red, which a one-level claim cannot see", () => {
    const root = build()
    mkdirSync(join(root, "alpha", "deep"), { recursive: true })
    writeFileSync(join(root, "alpha", "deep", "mod.ts"), "export const d = 3\n")
    Bun.spawnSync(["git", "add", "-A"], { cwd: join(root, "..") })
    // `alpha` is still reached and the count is still full — the exact hole
    // measured on the PEP fence when `src/agent/loop` was dropped.
    expect(() => assertScanPopulation(walk(root), root)).toThrow(/alpha\/deep/)
  })

  test("a subtree holding no collectable file is NOT demanded (no red on a clean tree)", () => {
    const root = build()
    // `docs/` is tracked but holds only `.md`. A floor that reds here is a floor
    // people delete.
    expect(() => assertScanPopulation(walk(root), root)).not.toThrow()
  })

  test("an IGNORED subtree is not demanded either — it is not part of the corpus", () => {
    const root = build()
    // `twin/` holds 50 `.ts` on disk. Demanding it would red every clean tree.
    expect(() => assertScanPopulation(walk(root), root)).not.toThrow()
  })

  test("topLevelOnly: a non-recursive scan that missed a tracked sibling is red", () => {
    const root = build()
    writeFileSync(join(root, "a.ts"), "export const a = 1\n")
    writeFileSync(join(root, "b.ts"), "export const b = 2\n")
    Bun.spawnSync(["git", "add", "-A"], { cwd: join(root, "..") })
    expect(() =>
      assertScanPopulation([join(root, "a.ts"), join(root, "b.ts")], root, { topLevelOnly: true }),
    ).not.toThrow()
    expect(() => assertScanPopulation([join(root, "a.ts")], root, { topLevelOnly: true })).toThrow(
      /b\.ts|did not enumerate/,
    )
  })

  test("PREDICATE: the second number reds when the matcher selects nothing", () => {
    const root = build()
    const files = walk(root)
    // The walk is full; the guard's own matcher has rotted to zero hits. A floor
    // on the walk alone clears this, which is why there are two numbers.
    expect(() => assertScanPopulation(files, root, { matched: [], minMatched: 1 })).toThrow(
      /matcher selected 0 of 2/,
    )
    expect(() => assertScanPopulation(files, root, { matched: files, minMatched: 1 })).not.toThrow()
  })

  test("PREDICATE: a second number that is never compared is refused", () => {
    const root = build()
    expect(() => assertScanPopulation(walk(root), root, { matched: [] })).toThrow(
      /never compared is not a second number/,
    )
  })

  test("a root git cannot read fails loudly rather than reporting a clean corpus", () => {
    const bare = mkdtempSync(join(tmpdir(), "scan-pop-nogit-"))
    made.push(bare)
    expect(() => assertScanPopulation([], bare)).toThrow(/reach cannot be measured/)
  })
})
