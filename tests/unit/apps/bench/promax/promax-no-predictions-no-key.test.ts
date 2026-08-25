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
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance/frozen-snapshot"
import { runFamilyBoxGrade } from "@/apps/bench/remote/box-session/family-box-grade"
import { DEFAULT_CHUNK_PATHS } from "@/apps/bench/remote/box-session/types"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"

const promaxBootstrap = () =>
  familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))

const DIGESTS: ReadonlyArray<readonly [string, string]> = [
  ["data/swe-bench-promax.json", PROMAX_V1_SNAPSHOT.dataset_sha256],
  ["data/eval.json", PROMAX_V1_SNAPSHOT.eval_sha256],
  ["src/evaluation/test_run.py", PROMAX_V1_SNAPSHOT.evaluator_sha256],
]

/** `preds` decides what the fake box says the predictions file holds. */
const recorder = (preds: string | null) => {
  const issued: string[] = []
  return {
    issued,
    ssh: async (cmd: string) => {
      issued.push(cmd)
      if (cmd.includes('printf %s "$HOME"')) return { code: 0, stdout: "/home/ubuntu", stderr: "" }
      if (cmd.includes("--version")) return { code: 0, stdout: "Python 3.11.14\n", stderr: "" }
      if (cmd.includes("sha256sum")) {
        const hit = DIGESTS.find(([s]) => cmd.includes(s))
        return hit === undefined
          ? { code: 1, stdout: "", stderr: "no such file" }
          : { code: 0, stdout: `${hit[1]}  x`, stderr: "" }
      }
      if (cmd.includes(DEFAULT_CHUNK_PATHS.preds)) {
        return preds === null
          ? { code: 1, stdout: "", stderr: "No such file or directory" }
          : { code: 0, stdout: preds, stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    },
  }
}

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
