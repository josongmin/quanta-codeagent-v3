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
import { runFamilyBoxGrade } from "@/apps/bench/remote/box-session/family-box-grade"
import { DEFAULT_CHUNK_PATHS } from "@/apps/bench/remote/box-session/types"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"
import { fail, fakeBox } from "./_fake-box"

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

/**
 * The only behaviour this file needs beyond the shared fake box is a grade that
 * FAILS, so the teardown-on-failure property has something to fail on.
 */
const recorder = (opts: { gradeFails?: boolean } = {}) =>
  fakeBox({
    predictions: PREDS_JSONL,
    passRate: PASS_RATE,
    ...(opts.gradeFails === true ? { grade: fail(3, "evaluator exploded") } : {}),
  })

const isGrade = (c: string) => c.includes("test_run.py") && c.includes("--pred")
/** The teardown is the command that REMOVES the checkout — matched by what it
 *  does, not by its argv[0]. It is now an `sh -c` that refuses a symlink first. */
const isTeardown = (c: string) => /'?rm'?\s+'?-rf'?/.test(c)
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

/**
 * THE VENV STEP IS ISSUED, AND IS DISTINGUISHABLE FROM THE $HOME PROBE.
 *
 * Every fixture in this directory answered `cmd.includes("$HOME")` with the
 * box's home directory — which also matched the `"$HOME"/.local/bin/uv venv …`
 * step. The venv command was therefore answered by the probe branch, exit 0,
 * in every test: a grader phase that stopped building its interpreter
 * environment entirely would not have reddened a single one of them.
 */
describe("the grader phase builds its own interpreter environment", () => {
  test("🔴 the uv venv step reaches the box as its own command", async () => {
    const r = recorder()
    await runFamilyBoxGrade({
      ssh: r.ssh,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
      paths: DEFAULT_CHUNK_PATHS,
    })
    const venv = r.issued.filter((c) => c.includes("uv") && c.includes("venv"))
    expect(venv.length, "the grader phase never created its venv").toBeGreaterThan(0)
    // …and it names the python the evaluator is pinned to, not whatever is first
    // on PATH: `python3 -m venv` inherits the version that ran it.
    expect(venv.join("\n")).toContain("--python 3.11")
  })

  test("the $HOME probe and the venv step are DIFFERENT commands", async () => {
    const r = recorder()
    await runFamilyBoxGrade({
      ssh: r.ssh,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
      paths: DEFAULT_CHUNK_PATHS,
    })
    const probe = r.issued.filter((c) => c.includes('printf %s "$HOME"'))
    const venv = r.issued.filter((c) => c.includes("uv") && c.includes("venv"))
    expect(probe.length).toBeGreaterThan(0)
    expect(venv.length).toBeGreaterThan(0)
    expect(probe.some((c) => venv.includes(c))).toBe(false)
  })
})
