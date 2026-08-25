/**
 * PMX-04 — NOTHING TO GRADE ⇒ THE ANSWER KEY IS NEVER MATERIALIZED.
 *
 * `runChunkBench` RETURNS its exit code, it does not throw. So a patch-gen pass
 * that died still fell through to the grade: the grader phase cloned the pinned
 * upstream — the answer key — onto the box, ran the evaluator against a
 * predictions file that was absent or empty, and tore it down again. Cost and
 * exposure for a grade that could not say anything.
 *
 * The gate is deliberately NOT the exit code. A partially failed patch-gen still
 * produces patches for the instances that finished, and those must be graded;
 * conversely a clean exit can produce nothing. The question that actually decides
 * it is "are there predictions to grade", so that is what gets asked.
 *
 * When there are none the grade is SKIPPED and an empty artifact is returned —
 * which the assigned-set reconciliation then turns into an infra error for every
 * assigned instance. The chunk reads as a total infra failure, which is what it
 * was. It does not read as a clean empty run, and no gold is ever placed on the
 * box to find that out.
 */
import { describe, expect, test } from "bun:test"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import { runFamilyBoxGrade } from "@/apps/bench/remote/box-session/family-box-grade"
import { DEFAULT_CHUNK_PATHS } from "@/apps/bench/remote/box-session/types"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"
import { fail, fakeBox, ok } from "./_fake-box"

const promaxBootstrap = () =>
  familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))

/**
 * `preds` decides what the fake box says the predictions file holds; `null`
 * models the file being absent entirely. Everything else — the home probe, the
 * pinned digests, the interpreter floor — comes from the shared fake box, so
 * this file no longer carries its own copy of a responder that has been wrong
 * in seven places at once.
 */
const recorder = (preds: string | null) =>
  fakeBox({
    override: (cmd) =>
      cmd.includes(DEFAULT_CHUNK_PATHS.preds)
        ? preds === null
          ? fail(1, "No such file or directory")
          : ok(preds)
        : undefined,
  })

const materializedGold = (issued: readonly string[]): boolean =>
  issued.some((c) => c.includes("'git'") || c.includes("upstream"))

const ranEvaluator = (issued: readonly string[]): boolean =>
  issued.some((c) => c.includes("test_run.py") && c.includes("--pred"))

describe("no predictions ⇒ no answer key on the box", () => {
  test("🔴 an ABSENT predictions file skips the grade AND the materialization", async () => {
    const r = recorder(null)
    const out = await runFamilyBoxGrade({
      ssh: r.ssh,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
      paths: DEFAULT_CHUNK_PATHS,
    })
    // `undefined`, not "": there is no grade to report at all, and an empty
    // artifact would read as "the evaluator ran and said nothing".
    expect(out).toBeUndefined()
    expect(materializedGold(r.issued), "the answer key was cloned with nothing to grade").toBe(
      false,
    )
    expect(ranEvaluator(r.issued)).toBe(false)
  })

  test("🔴 an EMPTY predictions array does the same", async () => {
    for (const empty of ["", "   ", "[]"]) {
      const r = recorder(empty)
      const out = await runFamilyBoxGrade({
        ssh: r.ssh,
        log: () => {},
        family: "promax",
        bootstrap: promaxBootstrap(),
        paths: DEFAULT_CHUNK_PATHS,
      })
      expect(out, `preds=${JSON.stringify(empty)}`).toBeUndefined()
      expect(materializedGold(r.issued), `preds=${JSON.stringify(empty)}`).toBe(false)
    }
  })

  test("PAIRED CONTROL: a NON-empty predictions file does materialize and grade", async () => {
    // JSONL, which is what the bench writes — not the array the evaluator reads.
    const r = recorder(
      `${JSON.stringify({ instance_id: "aws__s2n-tls-5464", model_patch: "x" })}\n`,
    )
    await runFamilyBoxGrade({
      ssh: r.ssh,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
      paths: DEFAULT_CHUNK_PATHS,
    })
    expect(materializedGold(r.issued)).toBe(true)
    expect(ranEvaluator(r.issued)).toBe(true)
  })
})
