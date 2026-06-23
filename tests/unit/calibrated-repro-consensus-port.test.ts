/**
 * Integration teeth for `makeCalibratedReproConsensusPort` — the GOLD-CALIBRATED
 * fail-open wrapper (jun-20 audit: the wrapper's fail-open branch was 0-coverage;
 * `calibrateReproOracle` itself is unit-covered in repro-oracle-calibration.test.ts).
 *
 * REAL git + REAL `python3` repro execution (no injected exec — the wrapper builds
 * its own reproExecBundle, so we drive it end-to-end). The decisive teeth:
 *   - BAD oracle (a repro that NEVER reports "resolved", even on the gold fix) ⇒
 *     calibration.falseNegative ⇒ the port FAILS OPEN (returns null for any
 *     candidate, without touching the candidate's tree).
 *   - GOOD oracle (a repro that recognizes the gold fix) ⇒ NOT false-negative ⇒
 *     the port is the real base scorer (calibration goldCalibrated=true).
 *   - Empty reproducing set ⇒ CALIBRATION_UNAVAILABLE + a null-returning port.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeCalibratedReproConsensusPort } from "@/runner/batch/eval/driver"
import type { Candidate } from "@/runner/batch/eval/selection-executor"
import type { Instance } from "@/runner/batch/types"

let repo: string
const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim()

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "calib-port-"))
  git("init", "-q")
  git("config", "user.email", "t@t")
  git("config", "user.name", "t")
  writeFileSync(join(repo, "marker.txt"), "buggy\n")
  git("add", "-A")
  git("commit", "-q", "-m", "base")
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

// repo UNDEFINED ⇒ reproExecBundle has no buildArgv ⇒ default `python3 <script>`.
// baseCommit present so the gold patch materializes.
const instance = (): Instance =>
  ({ swebench: { baseCommit: git("rev-parse", "HEAD") } }) as unknown as Instance

// Gold patch flips marker.txt buggy → FIXED.
const goldFix = (): string => {
  writeFileSync(join(repo, "marker.txt"), "FIXED\n")
  const p = execFileSync("git", ["diff"], { cwd: repo, encoding: "utf8" })
  git("checkout", "--", ".")
  return p
}

// P1 (pytest-grounded): a repro is now a pytest test whose verdict is the
// process EXIT CODE (the self-driving footer runs pytest on the file). The
// driver invokes it as `python3 <script>`; the footer drives pytest.
const FOOTER = [
  "",
  "",
  'if __name__ == "__main__":',
  "    import sys, pytest",
  '    sys.exit(pytest.main([__file__, "-q", "-p", "no:cacheprovider"]))',
].join("\n")

// A repro that recognizes the fix: PASSES (resolved) iff marker==FIXED, else the
// assertion FAILS (reproduced). On the buggy base tree it is red; on the gold
// fix it is green — a TRUSTWORTHY oracle.
const GOOD_REPRO = `def test_marker():\n    assert "FIXED" in open("marker.txt").read()${FOOTER}`
// A BROKEN oracle: its assertion ALWAYS fails, so it NEVER reports resolved even
// when the gold fix is applied (the false-negative the calibration must catch).
const BAD_REPRO = `def test_always_red():\n    assert False${FOOTER}`

const CAND: Candidate = {
  id: "c0",
  patch: "diff --git a/marker.txt b/marker.txt\n",
  turns: 1,
  files: ["marker.txt"],
  baseValidatedRed: true,
}

describe("makeCalibratedReproConsensusPort — gold-calibrated fail-open wrapper", () => {
  test("BAD oracle (never resolves gold) ⇒ falseNegative ⇒ port FAILS OPEN (null)", async () => {
    const inst = instance()
    inst.goldPatch = goldFix()
    const { port, calibration } = await makeCalibratedReproConsensusPort(
      inst,
      [BAD_REPRO],
      repo,
      60_000,
    )
    expect(calibration.available).toBe(true)
    expect(calibration.falseNegative).toBe(true) // oracle rejected the known-correct gold fix
    expect(await port(CAND)).toBeNull() // fail-open: never rejects a candidate
    // P3 non-vacuity: this BAD repro is RED on base (it just never resolves), so it
    // is NOT vacuous — the falseNegative path, not the vacuous path, fires here.
    expect(calibration.vacuous ?? false).toBe(false)
  }, 30_000) // P3 added a base-probe ⇒ calibration runs the repro set TWICE (base + gold)

  test("GOOD oracle (recognizes gold fix) ⇒ NOT falseNegative ⇒ uses real base scorer", async () => {
    const inst = instance()
    inst.goldPatch = goldFix()
    const { calibration } = await makeCalibratedReproConsensusPort(inst, [GOOD_REPRO], repo, 60_000)
    expect(calibration.available).toBe(true)
    expect(calibration.goldCalibrated).toBe(true)
    expect(calibration.falseNegative).toBe(false) // oracle is trustworthy here
    expect(calibration.goldVotes).toBeGreaterThanOrEqual(calibration.goldK ?? 1)
    // P3: a GOOD repro is RED on base (reproduces the bug) ⇒ NOT vacuous.
    expect(calibration.vacuous ?? false).toBe(false)
    expect(calibration.baseResolved ?? false).toBe(false)
  }, 30_000) // P3 added a base-probe ⇒ calibration runs the repro set TWICE (base + gold)

  test("empty reproducing set ⇒ CALIBRATION_UNAVAILABLE + null-returning port (no git)", async () => {
    const { port, calibration } = await makeCalibratedReproConsensusPort(
      instance(),
      [],
      "/sbx-does-not-exist",
      1000,
    )
    expect(calibration.available).toBe(false)
    expect(calibration.falseNegative).toBe(false) // no claim
    expect(await port(CAND)).toBeNull()
  })

  test("absent gold patch ⇒ no calibration claim ⇒ base scorer (not fail-open)", async () => {
    const inst = instance() // no goldPatch set
    const { calibration } = await makeCalibratedReproConsensusPort(inst, [GOOD_REPRO], repo, 60_000)
    expect(calibration.available).toBe(false)
    expect(calibration.falseNegative).toBe(false) // absent gold is NOT an oracle fault
  })
})
