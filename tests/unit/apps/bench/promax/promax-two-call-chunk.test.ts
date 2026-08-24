/**
 * PMX-04 — THE TWO-CALL CHUNK, driven through the REAL callee.
 *
 * A ProMax chunk cannot be one on-box invocation. The grader phase materializes
 * the answer key; the agent must run while it is ABSENT (its bootstrap carries an
 * `absenceProbe` that proves exactly that). So:
 *
 *   1. patch-gen only, key absent
 *   2. grader phase materializes the key
 *   3. THE GRADE, inside that window
 *   4. teardown removes the key — bound to the same executor call
 *
 * These tests drive `runFamilyBoxGrade` with a recording ssh, so the ORDER and
 * the CONTENT of what reaches the box are observed rather than asserted about a
 * plan. The properties that matter:
 *
 *  - a family that grades inline (verified) issues NOTHING here — no ssh, no
 *    profile call, byte-identical to before this existed;
 *  - the grade command runs AFTER the materialize commands and BEFORE the
 *    teardown;
 *  - a FAILING grade still tears the key down;
 *  - the artifact is read back INSIDE the window, so it does not depend on the
 *    evaluator's output happening to survive the teardown.
 */
import { describe, expect, test } from "bun:test"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance/frozen-snapshot"
import { runFamilyBoxGrade } from "@/apps/bench/remote/box-session/family-box-grade"
import { DEFAULT_CHUNK_PATHS } from "@/apps/bench/remote/box-session/types"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"

/** The grader phase hash-verifies each pinned file before anything is graded —
 *  a rail this fixture ran into the honest way. A fake box that answers with
 *  nothing makes the bootstrap refuse, which is correct: an UNVERIFIED upstream
 *  file may not be graded against. So the fake answers with the FROZEN digests. */
const ONBOX_DIGESTS: ReadonlyArray<readonly [string, string]> = [
  ["data/swe-bench-promax.json", PROMAX_V1_SNAPSHOT.dataset_sha256],
  ["data/eval.json", PROMAX_V1_SNAPSHOT.eval_sha256],
  ["src/evaluation/test_run.py", PROMAX_V1_SNAPSHOT.evaluator_sha256],
]

const promaxBootstrap = () =>
  familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))

/** What the bench actually writes: JSONL, one prediction per line. */
const PREDS_JSONL = `${JSON.stringify({ instance_id: "aws__s2n-tls-5464", model_patch: "PATCH" })}\n`

const PASS_RATE = JSON.stringify([
  {
    instance_id: "aws__s2n-tls-5464",
    language: "c",
    passed: true,
    model: { final_result: "success", raw_reason: "success", returncode: 0, script_exit_code: 0 },
    golden: { final_result: "success", raw_reason: "success", returncode: 0, script_exit_code: 0 },
  },
])

interface Rec {
  readonly issued: string[]
  readonly ssh: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>
}

const recorder = (opts: { gradeFails?: boolean } = {}): Rec => {
  const issued: string[] = []
  return {
    issued,
    ssh: async (cmd: string) => {
      issued.push(cmd)
      if (cmd.includes("$HOME")) return { code: 0, stdout: "/home/ubuntu", stderr: "" }
      // the grader phase proves its interpreter clears the PEP 604 floor before
      // anything is graded — another real rail this fixture met head-on
      if (cmd.includes("--version")) {
        return { code: 0, stdout: "Python 3.11.14\n", stderr: "" }
      }
      if (cmd.includes("sha256sum")) {
        const hit = ONBOX_DIGESTS.find(([suffix]) => cmd.includes(suffix))
        return hit === undefined
          ? { code: 1, stdout: "", stderr: "no such file" }
          : { code: 0, stdout: `${hit[1]}  ${suffix_of(cmd)}`, stderr: "" }
      }
      // TWO different `cat`s now: the predictions probe (JSONL, as the bench
      // writes it) and the pass-rate read (the evaluator's document).
      if (cmd.startsWith("cat ") && cmd.includes(DEFAULT_CHUNK_PATHS.preds)) {
        return { code: 0, stdout: PREDS_JSONL, stderr: "" }
      }
      if (cmd.startsWith("cat ")) return { code: 0, stdout: PASS_RATE, stderr: "" }
      if (cmd.includes("test_run.py")) {
        return opts.gradeFails
          ? { code: 3, stdout: "", stderr: "evaluator exploded" }
          : { code: 0, stdout: "", stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    },
  }
}

/** the path token the sha256sum line echoes back, as the real tool prints it */
const suffix_of = (cmd: string): string => cmd.split("'").filter((s) => s.startsWith("/"))[0] ?? ""

const isGrade = (c: string) => c.includes("test_run.py") && c.includes("--pred")
const isTeardown = (c: string) => c.includes("'rm'")
/** The PASS-RATE read specifically. `cat` is also used to probe the predictions
 *  file before anything is materialized, so a bare `startsWith("cat ")` would
 *  match that earlier probe and make the ordering assertion below read backwards. */
const isRead = (c: string) => c.startsWith("cat ") && c.includes(DEFAULT_CHUNK_PATHS.passRate)

describe("a family that grades INLINE is untouched", () => {
  test("verified issues no ssh at all and reports no artifact", async () => {
    const r = recorder()
    const out = await runFamilyBoxGrade({
      ssh: r.ssh,
      log: () => {},
      family: "verified",
      bootstrap: undefined,
      paths: DEFAULT_CHUNK_PATHS,
    })
    expect(out).toBeUndefined()
    expect(r.issued).toEqual([])
  })
})

describe("a ProMax chunk grades inside the window", () => {
  test("the order is materialize → grade → read → teardown", async () => {
    const r = recorder()
    const out = await runFamilyBoxGrade({
      ssh: r.ssh,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
      paths: DEFAULT_CHUNK_PATHS,
    })
    expect(out?.artifactText).toBe(PASS_RATE)

    const gradeAt = r.issued.findIndex(isGrade)
    const readAt = r.issued.findIndex(isRead)
    const teardownAt = r.issued.findIndex(isTeardown)
    expect(gradeAt).toBeGreaterThan(-1)
    expect(readAt).toBeGreaterThan(gradeAt)
    // THE property: the artifact is read while the checkout still exists, so this
    // does not rely on the evaluator's output surviving the teardown.
    expect(teardownAt).toBeGreaterThan(readAt)
    // …and the MATERIALIZE commands really ran first. `gradeAt > 0` was not
    // enough: the `$HOME` probe is always issued first, so an empty grader phase
    // (no checkout, no hash verification, no venv) satisfied it silently.
    const clonedAt = r.issued.findIndex((c) => c.includes("'git'"))
    const verifiedAt = r.issued.findIndex((c) => c.includes("sha256sum"))
    expect(clonedAt, "the pinned checkout was never created").toBeGreaterThan(-1)
    expect(verifiedAt, "the pinned files were never hash-verified").toBeGreaterThan(-1)
    expect(gradeAt).toBeGreaterThan(clonedAt)
    expect(gradeAt).toBeGreaterThan(verifiedAt)
  })

  test("the grade command names the pinned evaluator and the chunk's predictions", async () => {
    const r = recorder()
    await runFamilyBoxGrade({
      ssh: r.ssh,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
      paths: DEFAULT_CHUNK_PATHS,
    })
    const grade = r.issued.find(isGrade) ?? ""
    expect(grade).toContain("/opt/quanta/promax/upstream/src/evaluation/test_run.py")
    expect(grade).toContain("/opt/quanta/promax/venv/bin/python")
    // the chunk's `~/…` forms are resolved to REAL absolute paths: a quoted `~`
    // expands to nothing, and the evaluator would read an empty predictions file
    // and grade every instance as a miss.
    expect(grade).toContain("/home/ubuntu/preds.grader.json")
    expect(grade).toContain("/home/ubuntu/pass-rate.json")
    expect(grade).not.toContain("~/")
  })

  test("🔴 a FAILING grade still tears the answer key down, and surfaces the grade error", async () => {
    const r = recorder({ gradeFails: true })
    await expect(
      runFamilyBoxGrade({
        ssh: r.ssh,
        log: () => {},
        family: "promax",
        bootstrap: promaxBootstrap(),
        paths: DEFAULT_CHUNK_PATHS,
      }),
    ).rejects.toThrow(/on-box grade failed/i)
    expect(r.issued.some(isTeardown), "the answer key was NOT removed after a failed grade").toBe(
      true,
    )
  })

  test("a chunk carrying NO bootstrap REFUSES rather than grading against nothing", async () => {
    const r = recorder()
    await expect(
      runFamilyBoxGrade({
        ssh: r.ssh,
        log: () => {},
        family: "promax",
        bootstrap: undefined,
        paths: DEFAULT_CHUNK_PATHS,
      }),
    ).rejects.toThrow(/never materialized|NO declared bootstrap/i)
    // refused BEFORE any command reached the box
    expect(r.issued).toEqual([])
  })
})
