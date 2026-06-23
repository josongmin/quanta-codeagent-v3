/**
 * Hellgate teeth for repro-oracle gold calibration — the false-NEGATIVE guard.
 * REAL git repo: the probe reads the materialized worktree, so a calibration
 * that ran on the WRONG tree (base instead of gold) cannot pass silently. The
 * core tooth: a probe that says "not resolved" on the GOLD fix is flagged a
 * CONFIRMED false negative (so a resolved gate on it can fail-open).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { calibrateReproOracle } from "@/runner/batch/eval/repro-oracle-calibration"

let repo: string
const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim()

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "calib-"))
  git("init", "-q")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  writeFileSync(join(repo, "fix.txt"), "buggy\n")
  git("add", "-A")
  git("commit", "-q", "-m", "base")
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

const baseCommit = (): string => git("rev-parse", "HEAD")

/** A gold patch that writes the resolution marker into the tree. */
const goldPatchAddingMarker = (): string => {
  writeFileSync(join(repo, "fix.txt"), "GOLDFIX\n")
  const p = execFileSync("git", ["diff"], { cwd: repo, encoding: "utf8" })
  git("checkout", "--", ".")
  return p
}

/** A resolved-probe that READS the materialized tree: votes "resolved" iff the
 *  tree carries the gold marker. Running it on base (no marker) ⇒ votes 0 — so
 *  it can only report resolved when calibration actually materialized gold. */
const treeReadingProbe = async (sandbox: string): Promise<{ votes: number; k: number } | null> => {
  const resolved = readFileSync(join(sandbox, "fix.txt"), "utf8").includes("GOLDFIX")
  return { votes: resolved ? 2 : 0, k: 2 }
}

describe("calibrateReproOracle", () => {
  test("CALIBRATED: probe recognizes the gold fix as resolved", async () => {
    const c = await calibrateReproOracle({
      resolvedProbe: treeReadingProbe,
      goldPatch: goldPatchAddingMarker(),
      sandbox: repo,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
    })
    expect(c.available).toBe(true)
    expect(c.goldCalibrated).toBe(true)
    expect(c.falseNegative).toBe(false)
    expect(c.goldVotes).toBe(2)
  })

  // THE core tooth: an oracle that says "not resolved" on the GOLD fix is a
  // confirmed false negative — the exact failure that rejects correct candidates.
  test("FALSE NEGATIVE: probe rejects the known-correct gold fix", async () => {
    const alwaysNotResolved = async (): Promise<{ votes: number; k: number }> => ({
      votes: 0,
      k: 2,
    })
    const c = await calibrateReproOracle({
      resolvedProbe: alwaysNotResolved,
      goldPatch: goldPatchAddingMarker(),
      sandbox: repo,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
    })
    expect(c.available).toBe(true)
    expect(c.goldCalibrated).toBe(false)
    expect(c.falseNegative).toBe(true) // confirmed: rejects a correct fix
  })

  // Anti-theater: if calibration ran the probe on BASE (not gold), the
  // tree-reading probe would see no marker and (wrongly) look false-negative.
  // CALIBRATED above already proves the probe saw the gold tree — this asserts
  // the materialization is the ONLY reason it could.
  test("the probe runs on the GOLD tree, not base (anti-theater)", async () => {
    // Inject base content that LACKS the marker before calibration; the probe
    // must still see GOLDFIX because calibration materializes gold.
    writeFileSync(join(repo, "fix.txt"), "STALE BASE\n")
    const c = await calibrateReproOracle({
      resolvedProbe: treeReadingProbe,
      goldPatch: goldPatchAddingMarker(),
      sandbox: repo,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
    })
    expect(c.goldCalibrated).toBe(true) // saw GOLDFIX ⇒ ran on gold tree
  })

  test("probe returns null on gold ⇒ falseNegative (vouches for nothing)", async () => {
    const c = await calibrateReproOracle({
      resolvedProbe: async () => null,
      goldPatch: goldPatchAddingMarker(),
      sandbox: repo,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
    })
    expect(c.available).toBe(true)
    expect(c.falseNegative).toBe(true)
    expect(c.goldVotes).toBeNull()
  })

  test("probe THROWS on gold ⇒ falseNegative (never throws out)", async () => {
    const c = await calibrateReproOracle({
      resolvedProbe: async () => {
        throw new Error("repro exec blew up")
      },
      goldPatch: goldPatchAddingMarker(),
      sandbox: repo,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
    })
    expect(c.available).toBe(true)
    expect(c.falseNegative).toBe(true)
  })

  // jun-20 audit MISSING-TEST: partial vote (0 < votes < k) — gold did apply +
  // probe was decisive, but quorum NOT reached ⇒ confirmed false negative.
  test("PARTIAL vote (votes=1, k=2) on gold ⇒ falseNegative", async () => {
    const c = await calibrateReproOracle({
      resolvedProbe: async () => ({ votes: 1, k: 2 }),
      goldPatch: goldPatchAddingMarker(),
      sandbox: repo,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
    })
    expect(c.available).toBe(true)
    expect(c.goldCalibrated).toBe(false)
    expect(c.falseNegative).toBe(true)
    expect(c.goldVotes).toBe(1)
    expect(c.goldK).toBe(2)
  })

  // jun-20 audit SUSPECT→GUARD: a degenerate `{votes:0,k:0}` verdict must NOT read
  // as calibrated via `0 >= 0`. The `k >= 1` guard forces falseNegative.
  test("degenerate {votes:0,k:0} on gold ⇒ falseNegative (k>=1 guard, not 0>=0)", async () => {
    const c = await calibrateReproOracle({
      resolvedProbe: async () => ({ votes: 0, k: 0 }),
      goldPatch: goldPatchAddingMarker(),
      sandbox: repo,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
    })
    expect(c.goldCalibrated).toBe(false) // 0>=0 must NOT calibrate
    expect(c.falseNegative).toBe(true)
  })

  // P3 metamorphic non-vacuity (jun-23): the probe reports RESOLVED even on the
  // UN-PATCHED base tree ⇒ the oracle is VACUOUS (its "green" is meaningless and
  // would false-GREEN a wrong candidate). This is a DISTINCT failure from
  // falseNegative — here gold ALSO resolves, so it is NOT a false-negative; the
  // base probe is what catches it. red-on-injection: without the base probe,
  // `vacuous` could never be true and a meaningless-green oracle would gate.
  test("VACUOUS oracle (resolved on BASE) ⇒ vacuous=true, baseResolved=true, NOT falseNegative", async () => {
    const c = await calibrateReproOracle({
      resolvedProbe: async () => ({ votes: 2, k: 2 }), // always green — even on the buggy base
      goldPatch: goldPatchAddingMarker(),
      sandbox: repo,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
    })
    expect(c.available).toBe(true)
    expect(c.baseResolved).toBe(true)
    expect(c.vacuous).toBe(true)
    expect(c.falseNegative).toBe(false) // gold resolves ⇒ not FN; vacuous is the separate reason
    expect(c.baseVotes).toBe(2)
    expect(c.baseK).toBe(2)
  })

  // Paired control: a SOUND oracle (red on base, green on gold) is NOT vacuous.
  test("SOUND oracle (NOT-resolved on base) ⇒ vacuous=false", async () => {
    const c = await calibrateReproOracle({
      resolvedProbe: treeReadingProbe, // resolves ONLY when the gold marker is present
      goldPatch: goldPatchAddingMarker(),
      sandbox: repo,
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
    })
    expect(c.baseResolved).toBe(false)
    expect(c.vacuous).toBe(false)
    expect(c.goldCalibrated).toBe(true)
  })

  // jun-20 audit REAL-BUG fix: `withCandidatePatch` can throw OUTSIDE the probe's
  // try/catch. A bogus (non-git, non-existent) sandbox exercises that path; the
  // "Never throws" contract must hold ⇒ resolve to UNAVAILABLE, not reject.
  test("non-git/absent sandbox ⇒ UNAVAILABLE, never throws", async () => {
    const c = await calibrateReproOracle({
      resolvedProbe: treeReadingProbe,
      goldPatch: goldPatchAddingMarker(),
      sandbox: join(tmpdir(), "calib-does-not-exist-xyz"),
      baseCommit: baseCommit(),
      timeoutMs: 30_000,
    })
    expect(c.available).toBe(false) // no claim
    expect(c.falseNegative).toBe(false) // a materialize failure is NOT an oracle fault
  })

  describe("UNAVAILABLE (no claim — never a false verdict)", () => {
    test("absent gold patch ⇒ available:false, no claim", async () => {
      const c = await calibrateReproOracle({
        resolvedProbe: treeReadingProbe,
        goldPatch: undefined,
        sandbox: repo,
        baseCommit: baseCommit(),
        timeoutMs: 30_000,
      })
      expect(c).toEqual({
        goldCalibrated: false,
        falseNegative: false,
        available: false,
        goldVotes: null,
        goldK: null,
        // P3 non-vacuity fields — UNAVAILABLE carries no claim on these either.
        baseResolved: false,
        vacuous: false,
        baseVotes: null,
        baseK: null,
      })
    })

    test("gold that does NOT apply ⇒ available:false (not a false-negative)", async () => {
      const bogus =
        "diff --git a/fix.txt b/fix.txt\n--- a/fix.txt\n+++ b/fix.txt\n@@ -1,1 +1,1 @@\n-NOT THE BASE CONTENT\n+x\n"
      const c = await calibrateReproOracle({
        resolvedProbe: treeReadingProbe,
        goldPatch: bogus,
        sandbox: repo,
        baseCommit: baseCommit(),
        timeoutMs: 30_000,
      })
      expect(c.available).toBe(false)
      expect(c.falseNegative).toBe(false) // a non-applying gold is NOT an oracle fault
    })
  })
})
