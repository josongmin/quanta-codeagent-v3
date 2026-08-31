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

import {
  censusCorpusSize,
  floorlessGuards,
  isFloorless,
  isScanVerdictGuard,
} from "@/../tools/dev/anti-vacuity-census"
import { manifest } from "@/../tools/dev/empty-mirror-check"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const LEDGER = join(REPO_ROOT, "tools", "dev", "anti-vacuity-burndown.json")

/** Extracted so the two directions are testable without a tree. */
const addedEntries = (found: readonly string[], known: readonly string[]): readonly string[] =>
  found.filter((f) => !known.includes(f)).sort()
const staleEntries = (found: readonly string[], known: readonly string[]): readonly string[] =>
  known.filter((f) => !found.includes(f)).sort()

const manifestFiles = (): readonly string[] => manifest().map((c) => c.file)

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

  /**
   * Candidates the census flags that ground truth REFUTED.
   *
   * The census is a candidate detector, not a verdict. Each entry here was run
   * against a mirror in which the tree it scans was empty and went RED, so it is
   * protected by something the regex cannot see — a positive assertion
   * (`expect(entries).toContain(…)`), a non-empty expected list, or a floor
   * expressed in a shape no pattern matches. Listing them keeps the ledger an
   * honest statement of remaining debt instead of a 20%-wrong one.
   *
   * This list may only shrink or be re-justified; each entry names the evidence.
   */
  // The remaining terminal/surface-coupling guards now have recognized corpus
  // protection. Any future exemption must still earn its place below.
  const REFUTED: ReadonlySet<string> = new Set()

  test("🔴 no NEW guard derives a verdict from an unfloored scan", () => {
    // The static census is a CANDIDATE detector and no longer the authority.
    // Measured 2026-08-29: it still flags four guards that the execution-based
    // oracle judges RED — `slice-fence-static-hellgate-r3`,
    // `no-per-framework-heuristic-ratchet`, `observability-audit-ratchet` and
    // `knobs-import-bundle` — because their floors are expressed in shapes no
    // regex resolves. Three static detectors were built before the oracle and
    // all three under-reported; the run against an empty corpus is what settles
    // it, and `tools/dev/empty-mirror-check.ts` is where that verdict lives.
    //
    // What survives here is the cheap pre-filter: a candidate the oracle has not
    // yet been pointed at must be bound in the manifest, so nothing enters the
    // tree unjudged.
    const bound = new Set(manifestFiles())
    const added = addedEntries(found, known)
      .filter((f) => !REFUTED.has(f))
      .filter((f) => !bound.has(f))
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
    const mapAnchored =
      `import { ${fsCall} } from "node:fs"\n` +
      `test("x", () => {\n  const found = new Map([["live.ts", 1]])\n` +
      `  const seen = ${fsCall}("${root}")\n` +
      `  expect(found.get("live.ts")).toBe(1)\n` +
      `  expect(seen.filter((f) => f.endsWith(".zzz"))).toEqual([])\n})\n`
    expect(isFloorless(mapAnchored)).toBe(false)
    // A floor on something UNRELATED must not vouch for the scan. The binding is
    // named `seen` and not `all` on purpose: `all` is itself one of the
    // scan-shaped names the file-wide backstop accepts, so a fixture using it
    // would pass for the wrong reason — which is how the first version of this
    // case was written.
    expect(isFloorless(scanWith("expect(elapsedMs).toBeGreaterThan(1)"))).toBe(true)
  })

  test("🔴 every zero-verdict SPELLING is recognised, not just `toEqual([])`", () => {
    // The census only looks at files that both SCAN and state a zero-verdict, so
    // a spelling missing from that second gate removes the file from the
    // population entirely — no floor is demanded and nothing reports it. Measured
    // 2026-08-30: five spellings were missing, and 18 scanning guards used one of
    // them. `cross-slice-cycle` was among them and was genuinely vacuous — its
    // ban is a LOOP BODY over `readdir`, so an empty listing ran it zero times
    // and the test passed having asserted nothing. Proven by paired control:
    // with the listing forced empty it failed with the floor and passed 10/10
    // without it.
    //
    // The oracle cannot replace this gate. It judges a FILE, and that file has
    // another test that throws on a blanked tree, so the whole file reads red
    // while the vacuous test inside it is invisible.
    const fsCall = `read${"dir"}Sync`
    const root = `s${"rc"}`
    const scanEndingIn = (verdict: string): string =>
      `import { ${fsCall} } from "node:fs"\n` +
      `test("x", () => {\n  const seen = ${fsCall}("${root}")\n` +
      `  ${verdict}\n})\n`
    for (const verdict of [
      'expect(seen.filter((f) => f.endsWith(".zzz"))).toEqual([])',
      'expect(seen.filter((f) => f.endsWith(".zzz"))).toStrictEqual([])',
      'expect(seen.some((f) => f.endsWith(".zzz"))).toBe(false)',
      'expect(seen.filter((f) => f.endsWith(".zzz")).length).toBeLessThan(1)',
      'expect(new Map(seen.filter((f) => f.endsWith(".zzz")).map((f) => [f, 1]))).toEqual(new Map())',
      'expect(Object.fromEntries(seen.filter((f) => f.endsWith(".zzz")).map((f) => [f, 1]))).toEqual({})',
    ]) {
      expect(isFloorless(scanEndingIn(verdict)), verdict).toBe(true)
    }
  })

  test("🔴 `ls-files` in an ERROR STRING is not a scan", () => {
    // The census matched the bare token, so a guard that never runs git but names
    // it in a failure message joined the population — `repro-grounding` was in it
    // on the strength of `throw new Error("git ${lsFiles} failed")` and nothing
    // else. An enrollment campaign built on that population would have spent work
    // adding a corpus floor to a file with no corpus.
    const lsFiles = `ls-${"files"}`
    const errorOnly =
      `const f = () => { if (r.exitCode !== 0) throw new Error("git ${lsFiles} failed") }\n` +
      `test("t", () => { expect(offenders).toEqual([]) })\n`
    expect(isScanVerdictGuard(errorOnly), "an error message is not a scan").toBe(false)

    // Both real shapes must still count, or the fix trades one blindness for
    // another: the array form and the shell-string form are both live here.
    // Assembled from parts, the house convention for a fixture that spells out
    // the very shape the detector hunts: written literally, this file becomes a
    // scanning guard by its own census and demands a corpus floor for fixtures.
    const exec = `exec${"Sync"}`
    const arrayForm =
      `const out = Bun.spawnSync(["git", "${lsFiles}", "-z"], { cwd: R })\n` +
      `test("t", () => { expect(offenders).toEqual([]) })\n`
    const stringForm =
      `const out = ${exec}("git ${lsFiles} -- src")\n` +
      `test("t", () => { expect(offenders).toEqual([]) })\n`
    expect(isScanVerdictGuard(arrayForm), "the array call form must still count").toBe(true)
    expect(isScanVerdictGuard(stringForm), "the shell-string call form must still count").toBe(true)
  })

  test("every REFUTED entry is still refuted — ground truth, not a permanent excuse", () => {
    // An entry earns its place by going RED on an empty mirror. If the census
    // stops flagging it at all, the exemption is dead weight and must go, or it
    // silently re-admits the file when the census changes again.
    const dead = [...REFUTED].filter((f) => !found.includes(f)).sort()
    expect(
      dead,
      dead.length === 0
        ? ""
        : `the census no longer flags these — remove them from REFUTED:\n  ${dead.join("\n  ")}`,
    ).toEqual([])
  })

  test("a completed burn-down is GREEN, not red", () => {
    // The terminal state of the stated goal must not be a failing suite, or the
    // last fix is punished. An empty ledger with an empty census is success.
    expect(staleEntries([], [])).toEqual([])
    expect(addedEntries([], [])).toEqual([])
  })
})
