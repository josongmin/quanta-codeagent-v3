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

interface Fixture {
  /** `<repo>/src`, the walk root. */
  readonly root: string
  /** Pin a floor for `id` and hand back the baseline path to read it from. */
  readonly pin: (walked: number, matched?: number) => string
}

/** A repo with `alpha/mod.ts` + `beta/mod.ts` tracked, `docs/note.md` tracked,
 *  and an IGNORED twin holding 50 `.ts` files. */
const build = (): Fixture => {
  const repo = mkdtempSync(join(tmpdir(), "scan-pop-"))
  made.push(repo)
  const git = (...args: string[]): void => {
    const r = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" })
    if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed in fixture`)
  }
  git("init", "-q")
  git("config", "user.email", "t@t.t")
  git("config", "user.name", "t")
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
  writeFileSync(join(repo, ".gitignore"), "src/twin/\nreach-baseline.json\n")
  git("add", "-A")
  git("commit", "-qm", "init")
  return {
    root: join(repo, "src"),
    pin: (walked, matched) => {
      const path = join(repo, "reach-baseline.json")
      const row = matched === undefined ? { walked } : { walked, matched }
      writeFileSync(path, JSON.stringify({ note: "fixture", scans: { fx: row } }, null, 2))
      return path
    },
  }
}

/** Re-stage, so a file created after `build()` counts as tracked. */
const stage = (root: string): void => {
  Bun.spawnSync(["git", "add", "-A"], { cwd: join(root, ".."), stdout: "pipe", stderr: "pipe" })
}

/** What the guard's own walk returns — the filesystem view, twin included. */
const walk = (root: string, skipSubtree?: string): string[] =>
  ["alpha", "beta"].filter((s) => s !== skipSubtree).map((s) => join(root, s, "mod.ts"))

const twinFiles = (root: string): string[] =>
  Array.from({ length: 50 }, (_, i) => join(root, "twin", `m${i}.ts`))

describe("population floor", () => {
  test("a walk that reached everything passes (paired control)", () => {
    const fx = build()
    expect(() =>
      assertScanPopulation(walk(fx.root), fx.root, { id: "fx", baselinePath: fx.pin(2) }),
    ).not.toThrow()
  })

  test("INJECTION: an empty walk is red — 'found nothing' is not 'nothing to find'", () => {
    const fx = build()
    expect(() => assertScanPopulation([], fx.root, { id: "fx", baselinePath: fx.pin(2) })).toThrow(
      /reached 0 TRACKED files/,
    )
  })

  test("INJECTION: an IGNORED twin is not reach, even 50 files of it", () => {
    const fx = build()
    // The defect this contract exists for, reproduced: every real source file is
    // gone and only a gitignored twin remains. The walk-backed form of this
    // helper PASSED here — measured, in this repo, before the rewrite.
    expect(() =>
      assertScanPopulation(twinFiles(fx.root), fx.root, { id: "fx", baselinePath: fx.pin(2) }),
    ).toThrow(/reached 0 TRACKED files/)
  })

  test("INJECTION: a tracked path that no longer exists on disk is not reach", () => {
    const fx = build()
    const bl = fx.pin(2)
    rmSync(join(fx.root, "alpha"), { recursive: true, force: true })
    rmSync(join(fx.root, "beta"), { recursive: true, force: true })
    // Still in the index; gone from the tree. `git ls-files` alone lists the
    // INDEX, so it would count both and report a healthy corpus over an empty
    // checkout.
    expect(() =>
      assertScanPopulation(walk(fx.root), fx.root, { id: "fx", baselinePath: bl }),
    ).toThrow(/reached 0 TRACKED files/)
  })

  test("INJECTION: losing ONE subtree is red, which a count floor cannot see", () => {
    const fx = build()
    expect(() =>
      assertScanPopulation(walk(fx.root, "beta"), fx.root, { id: "fx", baselinePath: fx.pin(1) }),
    ).toThrow(/enumerated none of them/)
  })

  test("INJECTION: a NESTED subtree loss is red, which a one-level claim cannot see", () => {
    const fx = build()
    mkdirSync(join(fx.root, "alpha", "deep"), { recursive: true })
    writeFileSync(join(fx.root, "alpha", "deep", "mod.ts"), "export const d = 3\n")
    stage(fx.root)
    // `alpha` is still reached and the count is still full — the exact hole
    // measured on the PEP fence when `src/agent/loop` was dropped.
    expect(() =>
      assertScanPopulation(walk(fx.root), fx.root, { id: "fx", baselinePath: fx.pin(2) }),
    ).toThrow(/alpha\/deep/)
  })

  test("a subtree holding no collectable file is NOT demanded (no red on a clean tree)", () => {
    const fx = build()
    // `docs/` is tracked but holds only `.md`. A floor that reds here is a floor
    // people delete.
    expect(() =>
      assertScanPopulation(walk(fx.root), fx.root, { id: "fx", baselinePath: fx.pin(2) }),
    ).not.toThrow()
  })

  test("an IGNORED subtree is not demanded either — it is not part of the corpus", () => {
    const fx = build()
    // `twin/` holds 50 `.ts` on disk. Demanding it would red every clean tree.
    expect(() =>
      assertScanPopulation(walk(fx.root), fx.root, { id: "fx", baselinePath: fx.pin(2) }),
    ).not.toThrow()
  })

  test("topLevelOnly: a non-recursive scan that missed a tracked sibling is red", () => {
    const fx = build()
    writeFileSync(join(fx.root, "a.ts"), "export const a = 1\n")
    writeFileSync(join(fx.root, "b.ts"), "export const b = 2\n")
    stage(fx.root)
    const bl = fx.pin(1)
    const opts = { id: "fx", baselinePath: bl, topLevelOnly: true } as const
    expect(() =>
      assertScanPopulation([join(fx.root, "a.ts"), join(fx.root, "b.ts")], fx.root, opts),
    ).not.toThrow()
    expect(() => assertScanPopulation([join(fx.root, "a.ts")], fx.root, opts)).toThrow(
      /b\.ts|did not enumerate/,
    )
  })

  test("PREDICATE: the second number reds when the matcher selects nothing", () => {
    const fx = build()
    const bl = fx.pin(2, 1)
    const files = walk(fx.root)
    // The walk is full; the guard's own matcher has rotted to zero hits. A floor
    // on the walk alone clears this, which is why there are two numbers.
    expect(() =>
      assertScanPopulation(files, fx.root, { id: "fx", baselinePath: bl, matched: [] }),
    ).toThrow(/selected 0 of 2/)
    expect(() =>
      assertScanPopulation(files, fx.root, { id: "fx", baselinePath: bl, matched: files }),
    ).not.toThrow()
  })

  test("PREDICATE: a pinned matched floor that the guard never reports is refused", () => {
    const fx = build()
    expect(() =>
      assertScanPopulation(walk(fx.root), fx.root, { id: "fx", baselinePath: fx.pin(2, 1) }),
    ).toThrow(/pins a matched floor .* but the guard passed no matched set/)
  })

  test("PREDICATE: a matched set with no pinned floor is refused", () => {
    const fx = build()
    expect(() =>
      assertScanPopulation(walk(fx.root), fx.root, {
        id: "fx",
        baselinePath: fx.pin(2),
        matched: [],
      }),
    ).toThrow(/pins no matched floor/)
  })

  test("CLOSED UNIVERSE: an unpinned scan fails rather than defaulting to 1", () => {
    const fx = build()
    expect(() =>
      assertScanPopulation(walk(fx.root), fx.root, { id: "not-pinned", baselinePath: fx.pin(2) }),
    ).toThrow(/no reach floor pinned for "not-pinned"/)
  })

  test("a root git cannot read fails loudly rather than reporting a clean corpus", () => {
    const bare = mkdtempSync(join(tmpdir(), "scan-pop-nogit-"))
    made.push(bare)
    const bl = join(bare, "bl.json")
    writeFileSync(bl, JSON.stringify({ note: "fixture", scans: { fx: { walked: 1 } } }))
    expect(() => assertScanPopulation([], bare, { id: "fx", baselinePath: bl })).toThrow(
      /reach cannot be measured/,
    )
  })
})
