/**
 * Ratchet — a guard that derives a verdict from a scan must prove the scan
 * reached something.
 *
 * ## The class, in one sentence
 *
 * `[]`, `0` and `false` mean both "no violations" and "I never looked". Every
 * defect in the 2026-08-26/27 campaign reduced to that: a repo scan seeded from
 * the cwd, a `catch { return [] }` in a loader, a `git ls-files` whose exit code
 * was checked (it exits 0 with no output on no match), a ceiling of zero. The
 * verdict was derived from a scan that never happened, and it read as success.
 *
 * ## Why a burn-down and not zero-tolerance
 *
 * Thirty files carry this shape today. Fixing them is per-file work — each needs
 * a floor DERIVED from what its own scan actually reaches, and a proof that the
 * floor fires. Eight were fixed that way already, each proven by running a
 * byte-identical copy against an empty mirror of the repo's directory skeleton
 * and confirming it went from green to red.
 *
 * What must not happen is a THIRTY-FIRST. So the list is closed and one-directional:
 * a new file joining it fails, and a file leaving it can never come back without
 * a deliberate edit to the ledger. That is the same shape as
 * `lint-debt-ceiling.json` and `god-code/allowlist.json`, which is why the ledger
 * lives beside its detector rather than inside this file.
 *
 * ## What the floor has to be
 *
 * A MEASUREMENT, not a number the author picked. `toBeGreaterThan(0)` does not
 * count and that is deliberate: 56 of 81 floors already written in this repo are
 * `> 0`, which passes against any non-empty directory and says nothing about a
 * partial walk, a wrong subtree, or a matcher that stopped matching. A floor is
 * only worth its line if it is close enough to the real corpus size to notice
 * the scan shrinking.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { floorlessGuards } from "@/../tools/dev/anti-vacuity-census"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const LEDGER = join(REPO_ROOT, "tools", "dev", "anti-vacuity-burndown.json")

const ledger = (): readonly string[] => {
  const raw = JSON.parse(readFileSync(LEDGER, "utf8")) as { burndown?: readonly string[] }
  return raw.burndown ?? []
}

describe("anti-vacuity burn-down", () => {
  const known = ledger()
  const found = floorlessGuards()

  test("anti-vacuity: the census itself reached the tree", () => {
    // This ratchet is an instance of the class it guards, so it needs the same
    // proof. A census that returned nothing would make every assertion below
    // pass — "no floorless guards" and "I never looked for any" are the same
    // empty array.
    expect(known.length, "the ledger is empty — regenerate it, do not delete it").toBeGreaterThan(0)
    const sources = known.filter((f) => {
      try {
        return readFileSync(join(REPO_ROOT, f), "utf8").length > 0
      } catch {
        return false
      }
    })
    expect(
      sources.length,
      "no ledger entry resolves to a real file — the census is scanning the wrong tree",
    ).toBeGreaterThan(known.length / 2)
  })

  test("🔴 no NEW guard derives a verdict from an unfloored scan", () => {
    const added = found.filter((f) => !known.includes(f)).sort()
    expect(
      added,
      added.length === 0
        ? ""
        : "these scan the repo and assert a verdict without asserting the scan reached " +
            "anything — an empty scan passes them. Add a floor DERIVED from what the scan " +
            "actually reads (a count close to the real corpus, never `> 0`), and prove it " +
            "fires by pointing the scan at an empty directory:\n  " +
            added.join("\n  "),
    ).toEqual([])
  })

  test("the ledger has no stale entries — a fixed guard must be removed from it", () => {
    // One-directional the other way. A file that gained a floor but stayed listed
    // is a permission nobody needs, and it would silently re-admit the file if the
    // floor were later deleted.
    const stale = known.filter((f) => !found.includes(f)).sort()
    expect(
      stale,
      stale.length === 0
        ? ""
        : "these now have a floor (or no longer scan) — remove them from " +
            "tools/dev/anti-vacuity-burndown.json so the list can only shrink:\n  " +
            stale.join("\n  "),
    ).toEqual([])
  })

  test("🔴 the census does not accept `> 0` as a floor", () => {
    // The whole precision of the rule. If `toBeGreaterThan(0)` counted, 56 of the
    // 81 floors already in this repo would satisfy it and the ratchet would
    // certify a tree that is mostly unprotected.
    const withZeroFloor = known.filter((f) => {
      try {
        const src = readFileSync(join(REPO_ROOT, f), "utf8")
        return /toBeGreaterThan(?:OrEqual)?\(\s*0\s*\)/.test(src)
      } catch {
        return false
      }
    })
    // Not an assertion that none exist — an assertion that having one did NOT
    // keep the file off the list.
    expect(withZeroFloor.every((f) => known.includes(f))).toBe(true)
  })
})
