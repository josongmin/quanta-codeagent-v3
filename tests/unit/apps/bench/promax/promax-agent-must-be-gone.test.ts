/**
 * PMX-04 — THE ANSWER KEY IS NOT MATERIALIZED WHILE THE AGENT MAY STILL BE ALIVE.
 *
 * The bench is launched detached, and the completion probe accepts EITHER
 * `run.exit` or a fallback:
 *
 *     if [ -s run.exit ]; then cat run.exit;
 *     elif <report parses> && <preds non-empty>; then echo 0; fi
 *
 * On that second branch the wrapper never wrote `run.exit`, so the bench's state
 * is unknown — the artifacts merely look finished. `runChunkBench` then returns
 * and the grader phase clones the pinned upstream onto the box.
 *
 * The whole gold boundary rests on the agent and the answer key never coexisting.
 * The agent phase proves the key is absent before it starts; nothing proved the
 * AGENT was gone before the key arrived. Every abnormal exit already throws
 * `BoxDiedDuringRunError` and skips the grade, so the hole is precisely the
 * benign-looking artifact fallback.
 *
 * The probe is the literal command we launched, not a guess at process names.
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
const PREDS = `${JSON.stringify({ instance_id: "aws__s2n-tls-5464", model_patch: "P" })}\n`
const PASS_RATE = JSON.stringify([
  {
    instance_id: "aws__s2n-tls-5464",
    language: "c",
    passed: true,
    model: { final_result: "success", raw_reason: "success", returncode: 0, script_exit_code: 0 },
    golden: { final_result: "success", raw_reason: "success", returncode: 0, script_exit_code: 0 },
  },
])

/** `agentAlive` ⇒ the box reports a live bench process. */
const recorder = (opts: { agentAlive?: boolean } = {}) => {
  const issued: string[] = []
  return {
    issued,
    ssh: async (cmd: string) => {
      issued.push(cmd)
      if (cmd.includes("pgrep")) {
        // Models the REAL command: `pgrep -f … >/dev/null && echo ALIVE`. When
        // nothing matches, the `&&` short-circuits — empty stdout, non-zero exit.
        return opts.agentAlive === true
          ? { code: 0, stdout: "ALIVE\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "" }
      }
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
      return { code: 0, stdout: "", stderr: "" }
    },
  }
}

const grade = (r: ReturnType<typeof recorder>) =>
  runFamilyBoxGrade({
    ssh: r.ssh,
    log: () => {},
    family: "promax",
    bootstrap: promaxBootstrap(),
    paths: DEFAULT_CHUNK_PATHS,
  })

const materializedGold = (issued: readonly string[]): boolean =>
  issued.some((c) => c.includes("'git'"))

describe("a live agent process blocks the grader window", () => {
  test("🔴 the answer key is NOT materialized while the bench still runs", async () => {
    const r = recorder({ agentAlive: true })
    await expect(grade(r)).rejects.toThrow(/still running|did not exit|agent/i)
    expect(
      materializedGold(r.issued),
      "the answer key was cloned onto a box still running the agent",
    ).toBe(false)
  })

  test("🔴 the check happens BEFORE anything is materialized", async () => {
    const r = recorder({ agentAlive: true })
    await grade(r).catch(() => {})
    const probeAt = r.issued.findIndex((c) => c.includes("pgrep"))
    expect(probeAt).toBeGreaterThan(-1)
    // nothing gold-bearing issued at all, so ordering is trivially satisfied
    expect(r.issued.filter((c) => c.includes("'git'"))).toEqual([])
  })

  test("PAIRED CONTROL: with the agent gone, the grade proceeds normally", async () => {
    const r = recorder({ agentAlive: false })
    const out = await grade(r)
    expect(out?.artifactText).toBe(PASS_RATE)
    expect(materializedGold(r.issued)).toBe(true)
  })

  test("the probe names the bench command we actually launched", async () => {
    const r = recorder({ agentAlive: false })
    await grade(r)
    const probe = r.issued.find((c) => c.includes("pgrep")) ?? ""
    expect(probe).toContain("apps/bench/cli.ts")
  })
})
