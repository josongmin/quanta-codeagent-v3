/**
 * The floor is itself a guard, so it gets the same treatment it exists to
 * impose: each claim is shown RED under an injection that removes exactly the
 * thing the claim protects, against a paired control that stays green.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertScanPopulation } from "../_shared/scan-population"

const build = (): string => {
  const root = mkdtempSync(join(tmpdir(), "scan-pop-"))
  for (const sub of ["alpha", "beta"]) {
    mkdirSync(join(root, sub), { recursive: true })
    writeFileSync(join(root, sub, "mod.ts"), "export const x = 1\n")
  }
  mkdirSync(join(root, "docs"), { recursive: true })
  writeFileSync(join(root, "docs", "note.md"), "# no source here\n")
  return root
}

const walk = (root: string, skipSubtree?: string): string[] =>
  ["alpha", "beta"].filter((s) => s !== skipSubtree).map((s) => join(root, s, "mod.ts"))

describe("population floor", () => {
  test("a walk that reached everything passes (paired control)", () => {
    const root = build()
    try {
      expect(() => assertScanPopulation(walk(root), root)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("INJECTION: an empty walk is red — 'found nothing' is not 'nothing to find'", () => {
    const root = build()
    try {
      expect(() => assertScanPopulation([], root)).toThrow(/reached no files at all/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("INJECTION: losing ONE subtree is red, which a count floor cannot see", () => {
    const root = build()
    try {
      const partial = walk(root, "beta")
      // The count floor alone is satisfied — this is the exact hole measured on
      // the PEP fence, where a high count hid a dropped subtree.
      expect(() => assertScanPopulation(partial, root, { min: 1 })).toThrow(
        /enumerated none of them/,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a subtree holding no collectable file is NOT demanded (no red on a clean tree)", () => {
    const root = build()
    try {
      // `docs/` holds only .md. A floor that reds here is a floor people delete.
      expect(() => assertScanPopulation(walk(root), root)).not.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("topLevelOnly: a non-recursive scan that missed a sibling file is red", () => {
    const root = build()
    try {
      writeFileSync(join(root, "a.ts"), "export const a = 1\n")
      writeFileSync(join(root, "b.ts"), "export const b = 2\n")
      // A recursive floor would be wrong here — the scan is not supposed to
      // descend — but "missed one of its own peers" is the same defect.
      expect(() =>
        assertScanPopulation([join(root, "a.ts"), join(root, "b.ts")], root, {
          topLevelOnly: true,
        }),
      ).not.toThrow()
      expect(() =>
        assertScanPopulation([join(root, "a.ts")], root, { topLevelOnly: true }),
      ).toThrow(/b\.ts|did not enumerate/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("INJECTION: a NESTED subtree loss is red, which a one-level claim cannot see", () => {
    const root = build()
    try {
      mkdirSync(join(root, "alpha", "deep"), { recursive: true })
      writeFileSync(join(root, "alpha", "deep", "mod.ts"), "export const d = 3\n")
      // `alpha` is still reached, and the count is still high — the exact hole
      // measured on the PEP fence when `src/agent/loop` was dropped.
      expect(() => assertScanPopulation(walk(root), root)).toThrow(/alpha\/deep/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("the on-disk probe does not reuse the walk: a walk blind to a subtree still reds", () => {
    const root = build()
    try {
      // `gamma` appears on disk AFTER the walk's notion of the tree was fixed —
      // the same shape as a walk whose skip-list silently swallowed a subtree.
      mkdirSync(join(root, "gamma"), { recursive: true })
      writeFileSync(join(root, "gamma", "mod.ts"), "export const y = 2\n")
      expect(() => assertScanPopulation(walk(root), root)).toThrow(/gamma|enumerated none/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
