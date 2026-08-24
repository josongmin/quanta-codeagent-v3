/**
 * PMX-04 — THE GRADE MUST LEAVE A RECORD, AND MUST NOT LEAVE A COPY ON THE BOX.
 *
 * `fetchChunkArtifacts` pulls the report, the predictions, run.log, the observe
 * archive, closure diagnostics and trajectories back before the box dies. It did
 * not pull `pass-rate.json` — which for a box-grading family IS the grade. The
 * on-box copy was then either scrubbed by the next chunk or destroyed with the
 * box, so a ProMax run's only surviving trace was a terminal line reading
 * `resolved N | unresolved M`. Nothing replayable, nothing hashable.
 *
 * That also made the `evaluatorSha256` guard — which exists so a receipt names
 * the bytes that produced its verdicts — apply to a shape this path never
 * produced.
 *
 * The document is already read INSIDE the grader window, so persisting it needs
 * no second fetch. And once read it is removed from the box: a later chunk's
 * unsandboxed agent should not find a per-instance oracle sitting at a
 * predictable path, and the run-scoped scrub only ever clears the CURRENT
 * chunk's paths — it cannot reach an earlier chunk's.
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

const PASS_RATE = JSON.stringify([
  {
    instance_id: "aws__s2n-tls-5464",
    language: "c",
    passed: true,
    model: { final_result: "success", raw_reason: "success", returncode: 0, script_exit_code: 0 },
    golden: { final_result: "success", raw_reason: "success", returncode: 0, script_exit_code: 0 },
  },
])
const PREDS_JSONL = `${JSON.stringify({ instance_id: "aws__s2n-tls-5464", model_patch: "P" })}\n`

const recorder = () => {
  const issued: string[] = []
  return {
    issued,
    ssh: async (cmd: string) => {
      issued.push(cmd)
      if (cmd.includes("$HOME")) return { code: 0, stdout: "/home/ubuntu", stderr: "" }
      if (cmd.includes("--version")) return { code: 0, stdout: "Python 3.11.14\n", stderr: "" }
      if (cmd.includes("sha256sum")) {
        const hit = DIGESTS.find(([s]) => cmd.includes(s))
        return hit === undefined
          ? { code: 1, stdout: "", stderr: "no such file" }
          : { code: 0, stdout: `${hit[1]}  x`, stderr: "" }
      }
      if (cmd.startsWith("cat ") && cmd.includes(DEFAULT_CHUNK_PATHS.preds)) {
        return { code: 0, stdout: PREDS_JSONL, stderr: "" }
      }
      if (cmd.startsWith("cat ") && cmd.includes(DEFAULT_CHUNK_PATHS.passRate)) {
        return { code: 0, stdout: PASS_RATE, stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    },
  }
}

describe("the grade artifact", () => {
  test("KNOWN-ITEM FLOOR: it is returned to the caller, so it can be persisted", async () => {
    const r = recorder()
    const out = await runFamilyBoxGrade({
      ssh: r.ssh,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
      paths: DEFAULT_CHUNK_PATHS,
    })
    expect(out).toBe(PASS_RATE)
  })

  test("🔴 the on-box copy is REMOVED after it is read", async () => {
    const r = recorder()
    await runFamilyBoxGrade({
      ssh: r.ssh,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
      paths: DEFAULT_CHUNK_PATHS,
    })
    const removed = r.issued.some(
      (c) => c.includes("rm ") && c.includes(DEFAULT_CHUNK_PATHS.passRate),
    )
    expect(removed, "the grade document was left on the box for a later agent to find").toBe(true)
  })

  test("🔴 it is removed AFTER the read, never before — the read must still work", async () => {
    const r = recorder()
    const out = await runFamilyBoxGrade({
      ssh: r.ssh,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
      paths: DEFAULT_CHUNK_PATHS,
    })
    const readAt = r.issued.findIndex(
      (c) => c.startsWith("cat ") && c.includes(DEFAULT_CHUNK_PATHS.passRate),
    )
    const rmAt = r.issued.findIndex(
      (c) => c.includes("rm ") && c.includes(DEFAULT_CHUNK_PATHS.passRate),
    )
    expect(readAt).toBeGreaterThan(-1)
    expect(rmAt).toBeGreaterThan(readAt)
    expect(out).toBe(PASS_RATE) // and the content survived the removal
  })

  test("PAIRED CONTROL: an inline-grading family issues no such removal", async () => {
    const r = recorder()
    await runFamilyBoxGrade({
      ssh: r.ssh,
      log: () => {},
      family: "verified",
      bootstrap: undefined,
      paths: DEFAULT_CHUNK_PATHS,
    })
    expect(r.issued).toEqual([])
  })
})
