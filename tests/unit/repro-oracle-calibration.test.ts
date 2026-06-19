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
