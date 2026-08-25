/**
 * PMX-04 — AN SSH FAILURE IS NOT AN ANSWER, AT EVERY PROBE.
 *
 * `d9853dd5b` fixed exactly one of these: the agent-exit probe, where ssh-255 on
 * a dying box read as "the agent exited". Its two siblings were left reading a
 * TRANSPORT failure as DATA.
 *
 *  - the PREDICTIONS read. `preds.code !== 0` was folded into "patch-gen produced
 *    no predictions", which skips the grade and reports every assigned instance
 *    as an infra error. Run 3's log shows this misreport happening: the box had
 *    logged `wrote /home/ubuntu/preds.jsonl (7 prediction(s))` eleven lines
 *    earlier, and the run still said "produced no predictions".
 *  - the IMAGE-PROVENANCE capture. It never inspected the exit code at all, so a
 *    dropped connection became "the box reported no image for it at all" for
 *    every instance — a NETWORK event reported as an IMAGE fault. Its own sibling
 *    module warns about exactly this: "Collapsing them is how 'the run produced
 *    no verdicts' gets misfiled as 'the images were bad'."
 *
 * The distinction is available for free: ssh's 255 is the transport's own signal,
 * and neither `cat` nor the provenance pipeline exits 255.
 */
import { describe, expect, test } from "bun:test"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance/frozen-snapshot"
import { runFamilyBoxGrade } from "@/apps/bench/remote/box-session/family-box-grade"
import { DEFAULT_CHUNK_PATHS } from "@/apps/bench/remote/box-session/types"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"

const bootstrap = () =>
  familyRemoteBootstrap(resolveBenchRunConfig({ argvFamily: "promax", env: {} }))

const DIGESTS: ReadonlyArray<readonly [string, string]> = [
  ["data/swe-bench-promax.json", PROMAX_V1_SNAPSHOT.dataset_sha256],
  ["data/eval.json", PROMAX_V1_SNAPSHOT.eval_sha256],
  ["src/evaluation/test_run.py", PROMAX_V1_SNAPSHOT.evaluator_sha256],
]
const PREDS = `${JSON.stringify({ instance_id: "a-1", model_patch: "P" })}\n`
const PASS_RATE = JSON.stringify([
  {
    instance_id: "a-1",
    language: "c",
    passed: true,
    model: { final_result: "success", raw_reason: "s", returncode: 0, script_exit_code: 0 },
    golden: { final_result: "success", raw_reason: "s", returncode: 0, script_exit_code: 0 },
  },
])

/** `dropOn` names the command substring at which the box becomes unreachable. */
const boxThatDropsAt = (dropOn: string) => async (cmd: string) => {
  if (cmd.includes(dropOn)) {
    return { code: 255, stdout: "", stderr: "ssh: connect to host: Connection refused" }
  }
  if (cmd.includes("pgrep")) return { code: 1, stdout: "", stderr: "" }
  if (cmd.includes("$HOME")) return { code: 0, stdout: "/home/ubuntu", stderr: "" }
  if (cmd.includes("--version")) return { code: 0, stdout: "Python 3.11.14\n", stderr: "" }
  if (cmd.includes("sha256sum")) {
    const hit = DIGESTS.find(([s]) => cmd.includes(s))
    return hit === undefined
      ? { code: 1, stdout: "", stderr: "no such file" }
      : { code: 0, stdout: `${hit[1]}  x`, stderr: "" }
  }
  if (cmd.startsWith("cat ") && cmd.includes(DEFAULT_CHUNK_PATHS.preds)) {
    return { code: 0, stdout: PREDS, stderr: "" }
  }
  if (cmd.startsWith("cat ") && cmd.includes(DEFAULT_CHUNK_PATHS.passRate)) {
    return { code: 0, stdout: PASS_RATE, stderr: "" }
  }
  if (cmd.includes("image-provenance.py")) {
    return {
      code: 0,
      stdout: `a-1\tkey4127/refactor-dockerhub:a-1\tkey4127/refactor-dockerhub@sha256:${"a".repeat(64)}\n`,
      stderr: "",
    }
  }
  return { code: 0, stdout: "", stderr: "" }
}

const grade = (ssh: (cmd: string) => Promise<{ code: number; stdout: string; stderr: string }>) =>
  runFamilyBoxGrade({
    ssh,
    log: () => {},
    family: "promax",
    bootstrap: bootstrap(),
    paths: DEFAULT_CHUNK_PATHS,
    assignedInstanceIds: ["a-1"],
    sleep: async () => {},
  })

describe("a dropped connection is reported as a dropped connection", () => {
  test("🔴 the PREDICTIONS read: ssh-255 must not read as `produced no predictions`", async () => {
    // The damage is silent: "no predictions" skips the grade and files every
    // assigned instance as an infra error, so seven real patches vanish.
    await expect(grade(boxThatDropsAt(`cat ${DEFAULT_CHUNK_PATHS.preds}`))).rejects.toThrow(
      /unreachable|could not be established|ssh/i,
    )
  })

  test("🔴 the IMAGE capture: ssh-255 must not read as `no image for it at all`", async () => {
    let msg = ""
    try {
      await grade(boxThatDropsAt("image-provenance.py"))
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/unreachable|could not be established|ssh/i)
    // …and it must NOT be dressed up as an image problem
    expect(msg).not.toMatch(/reported no image for it at all/)
  })

  test("PAIRED CONTROL: a reachable box still grades normally", async () => {
    const out = await grade(boxThatDropsAt("__never_matches__"))
    expect(out?.artifactText).toBe(PASS_RATE)
  })
})
