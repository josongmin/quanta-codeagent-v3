/**
 * PMX-04 — A PATCH-GEN-ONLY REPORT MUST NOT REACH THE LEADERBOARD.
 *
 * For a family that grades in its own grader phase, the bench report is written
 * by a pass with the grading shim OFF: every instance in it is an explicit
 * "requires the official Python harness — REFUSING to fake-grade" infra error, BY
 * CONSTRUCTION. Its verdicts are discarded — that is why `parseBoxGradeVerdicts`
 * exists at all.
 *
 * It was still mirrored to the canonical SSOT (`~/.quanta/bench/results`), which
 * is the leaderboard dashboard's first report root. The report carries
 * `datasetFamily: promax`, so it landed on the ProMax view: a campaign row whose
 * every instance is a measurement hole — and, until the grade receipt existed,
 * the ONLY ProMax artifact any dashboard would ever see.
 *
 * The dashboard does exclude those rows from its denominator (`grader_invalid` is
 * a re-runnable hole), so this is not a wrong PERCENTAGE. It is a wrong ARTIFACT:
 * the run's authoritative record is the pass-rate document and the grade receipt
 * beside it, both of which are saved. The report stays on disk as forensics; it
 * just stops claiming to be a result.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  fetchChunkArtifacts,
  shouldMirrorReportToSsot,
} from "@/apps/bench/remote/box-session/chunk-artifacts"
import { DEFAULT_CHUNK_PATHS } from "@/apps/bench/remote/box-session/types"
import { __resetRuntimeConfig } from "@/shared/runtime-config"

/**
 * RESTORE, never delete. `tests/setup.ts` installs `QUANTA_BENCH_RESULTS_DIR`
 * as the FENCE against writing the operator's live results corpus — the aug-22
 * incident — and bun runs every test file in ONE process, so deleting it here
 * disarms that fence for every file scheduled afterwards. MEASURED: a sibling
 * file's hooks saw both variables `undefined` for its entire run.
 */
const restoreEnv = (prior: Readonly<Record<string, string | undefined>>): void => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe("the SSOT mirror is skipped for a patch-gen-only report", () => {
  test("🔴 a family that grades on-box does NOT mirror its bench report", () => {
    expect(shouldMirrorReportToSsot("promax")).toBe(false)
  })

  test("PAIRED CONTROL: every inline-grading family still mirrors", () => {
    for (const family of ["verified", "live", "pro"] as const) {
      expect(shouldMirrorReportToSsot(family), `${family} stopped mirroring`).toBe(true)
    }
  })

  test("the decision follows the PORT, not a family name", async () => {
    // Packet invariant 10: no `family === "promax"` compare outside the profile.
    // A future on-box-grading family must inherit this without editing transport.
    //
    // Resolved from THIS file rather than from a relative path: a cwd-relative
    // read passes or fails on where the runner was invoked, which is not a
    // property of the code under test.
    const { readFileSync } = await import("node:fs")
    const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "../../../../..")
    const file = join(repoRoot, "src/apps/bench/remote/box-session/chunk-artifacts.ts")
    expect(existsSync(file), `the module moved: ${file}`).toBe(true)
    const src = readFileSync(file, "utf8")
    expect(src).not.toMatch(/===\s*"promax"/)
    expect(src).toContain("boxGrade")
  })
})

/**
 * WIRING — the predicate is not the behaviour.
 *
 * Everything above calls `shouldMirrorReportToSsot` directly, and the invariant
 * test is a SPELLING check on a source file. Both pass unchanged if
 * `fetchChunkArtifacts` stops consulting the predicate and mirrors
 * unconditionally — which is the actual regression to fear, because the mirror
 * is what puts a patch-gen-only report on the leaderboard.
 *
 * So these drive the REAL transport function and observe the REAL sink, with
 * both the SSOT and the bench home redirected into a temp dir so nothing
 * reaches the operator's `~/.quanta/bench/results`.
 */
describe("WIRING — the transport actually consults the predicate", () => {
  const temps: string[] = []
  const priorEnv: Record<string, string | undefined> = {
    QUANTA_BENCH_RESULTS_DIR: process.env.QUANTA_BENCH_RESULTS_DIR,
    QUANTA_BENCH_HOME: process.env.QUANTA_BENCH_HOME,
  }
  afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true })
    restoreEnv(priorEnv)
    __resetRuntimeConfig()
  })

  const REPORT = JSON.stringify({ schemaVersion: 1, instances: [] })

  /** Run the real fetch with an isolated SSOT, and report what landed there. */
  const mirrored = async (family: "promax" | "verified"): Promise<readonly string[]> => {
    const dir = mkdtempSync(join(tmpdir(), "promax-ssot-wiring-"))
    temps.push(dir)
    const ssot = join(dir, "ssot")
    process.env.QUANTA_BENCH_RESULTS_DIR = ssot
    process.env.QUANTA_BENCH_HOME = join(dir, "bench-home")
    __resetRuntimeConfig()
    await fetchChunkArtifacts({
      ssh: async (cmd: string) =>
        cmd.includes(DEFAULT_CHUNK_PATHS.report)
          ? { code: 0, stdout: REPORT, stderr: "" }
          : { code: 1, stdout: "", stderr: "" },
      datasetFamily: family,
      paths: DEFAULT_CHUNK_PATHS,
      artifactSuffix: `wiring-${family}`,
      recordTrajectory: false,
      log: () => {},
    })
    return existsSync(ssot) ? readdirSync(ssot) : []
  }

  test("🔴 a promax chunk's report does NOT land on the results SSOT", async () => {
    expect(
      await mirrored("promax"),
      "a patch-gen-only report reached the leaderboard's report root",
    ).toEqual([])
  })

  test("PAIRED CONTROL: a verified chunk's report DOES land there", async () => {
    // Without this the test above passes just as well when the mirror is broken
    // for everyone, or when the sink redirection silently sends it elsewhere.
    expect(
      (await mirrored("verified")).length,
      "the mirror landed nothing for ANY family — the sink is not being observed",
    ).toBeGreaterThan(0)
  })
})
