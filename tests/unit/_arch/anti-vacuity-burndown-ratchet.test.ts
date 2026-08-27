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

import { censusCorpusSize, floorlessGuards, isFloorless } from "@/../tools/dev/anti-vacuity-census"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const LEDGER = join(REPO_ROOT, "tools", "dev", "anti-vacuity-burndown.json")

/** Extracted so the two directions are testable without a tree. */
const addedEntries = (found: readonly string[], known: readonly string[]): readonly string[] =>
  found.filter((f) => !known.includes(f)).sort()
const staleEntries = (found: readonly string[], known: readonly string[]): readonly string[] =>
  known.filter((f) => !found.includes(f)).sort()

const ledger = (): readonly string[] => {
  const raw = JSON.parse(readFileSync(LEDGER, "utf8")) as { burndown?: readonly string[] }
  return raw.burndown ?? []
}

describe("anti-vacuity burn-down", () => {
  const known = ledger()
  const found = floorlessGuards()

  test("anti-vacuity: the CENSUS reached the tree", () => {
    // Rewritten after audit. The previous version floored `known` — a static JSON
    // file — and never referenced `found` at all, so a census returning `[]` left
    // it green. The comment claimed "a census that returned nothing would make
    // every assertion below pass"; that was false in the other direction, and the
    // assertion written to defend against it was inert for exactly that failure.
    //
    // What proves the census ran is that it SAW the corpus, not that it produced
    // findings — a burn-down driven to zero must not red the suite (see the
    // separate test below). So the floor is on the population the census walked.
    expect(
      censusCorpusSize(),
      "the census walked no test files — every verdict below is over an empty scan",
    ).toBeGreaterThan(3000)
  })

  test("🔴 no NEW guard derives a verdict from an unfloored scan", () => {
    const added = addedEntries(found, known)
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
    const stale = staleEntries(found, known)
    expect(
      stale,
      stale.length === 0
        ? ""
        : "these now have a floor (or no longer scan) — remove them from " +
            "tools/dev/anti-vacuity-burndown.json so the list can only shrink:\n  " +
            stale.join("\n  "),
    ).toEqual([])
  })

  test("🔴 a `> 0` floor does not exempt a guard", () => {
    // Rewritten after audit. The previous version was a TAUTOLOGY:
    // `known.filter(P).every(f => known.includes(f))` is true for every P,
    // including one that matches nothing, and it never touched the census. It
    // passed under a mutation that made the census accept `> 0` — which silently
    // removed six files from the list.
    //
    // This drives the real function instead: a scan with a `> 0` floor must still
    // be listed, and the same scan with a measured floor must not. If `> 0` were
    // accepted, 56 of the 81 floors already in this repo would satisfy the rule
    // and the ratchet would certify a tree that is mostly unprotected.
    // The fs-call name and its argument are assembled from parts. Written
    // literally, `repo-path-anchor-ratchet` reads this FIXTURE as a real
    // cwd-relative scan in this file — a detector correctly firing on a string
    // that describes the defect rather than commits it.
    const fsCall = `read${"dir"}Sync`
    const root = `s${"rc"}`
    const scanWith = (floor: string): string =>
      `import { ${fsCall} } from "node:fs"\n` +
      `test("x", () => {\n  const seen = ${fsCall}("${root}")\n  ${floor}\n` +
      `  expect(seen.filter((f) => f.endsWith(".zzz"))).toEqual([])\n})\n`
    expect(isFloorless(scanWith("expect(seen.length).toBeGreaterThan(0)"))).toBe(true)
    expect(isFloorless(scanWith("expect(seen.length).toBeGreaterThan(2500)"))).toBe(false)
    // A floor on something UNRELATED must not vouch for the scan. The binding is
    // named `seen` and not `all` on purpose: `all` is itself one of the
    // scan-shaped names the file-wide backstop accepts, so a fixture using it
    // would pass for the wrong reason — which is how the first version of this
    // case was written.
    expect(isFloorless(scanWith("expect(elapsedMs).toBeGreaterThan(1)"))).toBe(true)
  })

  test("a completed burn-down is GREEN, not red", () => {
    // The terminal state of the stated goal must not be a failing suite, or the
    // last fix is punished. An empty ledger with an empty census is success.
    expect(staleEntries([], [])).toEqual([])
    expect(addedEntries([], [])).toEqual([])
  })
})
