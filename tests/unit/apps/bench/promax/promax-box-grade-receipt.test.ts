/**
 * PMX-04 — A BOX GRADE MUST LEAVE A REPLAYABLE RECEIPT, NOT JUST A NUMBER.
 *
 * `receiveOfficialGradeReceipt` and `DEFAULT_OFFICIAL_GRADE_RECEIPT_BOX_PATH`
 * had ZERO production callers, so `FullRemoteResult.officialGrade` was never set
 * on this path and every receipt-aware branch downstream was dead for ProMax.
 * The grade's only surviving trace was `resolved N | unresolved M`.
 *
 * That also left the `evaluatorSha256` guard — which exists so a receipt names
 * the BYTES that produced its verdicts — applying to a shape this path never
 * produced.
 *
 * Everything the receipt needs is already in hand at grade time: the argv and cwd
 * come from the family's own `boxGrade` (which is why that port returns them
 * rather than a bare string — re-deriving argv by splitting a shell string would
 * be a guess at the quoting), the exit code and streams come from the ssh call,
 * the artifact is the pass-rate document, and the evaluator's sha256 is the
 * frozen pin the grader phase HASH-VERIFIED on the box moments earlier.
 */
import { describe, expect, test } from "bun:test"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import type { FamilyRemoteBootstrap } from "@/apps/bench/profiles/types"
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
const PREDS = `${JSON.stringify({ instance_id: "aws__s2n-tls-5464", model_patch: "P" })}\n`

const ssh = async (cmd: string) => {
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
  if (cmd.includes("test_run.py")) return { code: 0, stdout: "EVAL-STDOUT", stderr: "EVAL-STDERR" }
  return { code: 0, stdout: "", stderr: "" }
}

const grade = () =>
  runFamilyBoxGrade({
    ssh,
    log: () => {},
    family: "promax",
    bootstrap: promaxBootstrap(),
    paths: DEFAULT_CHUNK_PATHS,
  })

describe("the on-box grade reports the evidence a receipt needs", () => {
  test("🔴 it returns the OBSERVATION, not just the artifact text", async () => {
    const out = await grade()
    expect(out).toBeDefined()
    expect(out?.artifactText).toBe(PASS_RATE)
    expect(out?.observation).toBeDefined()
  })

  test("🔴 the observation carries the real ARGV and CWD of the invocation", async () => {
    const out = await grade()
    const argv = out?.observation.argv ?? []
    // the actual tokens, not a split of the rendered shell string
    expect(argv[0]).toContain("/venv/bin/python")
    expect(argv.join(" ")).toContain("test_run.py")
    expect(argv).toContain("--workers")
    expect(out?.observation.cwd).toBe("/opt/quanta/promax/upstream")
  })

  test("🔴 it carries the evaluator's exit code and BOTH streams", async () => {
    const out = await grade()
    expect(out?.observation.exitCode).toBe(0)
    expect(out?.observation.stdout).toBe("EVAL-STDOUT")
    expect(out?.observation.stderr).toBe("EVAL-STDERR")
  })

  test("🔴 it carries the evaluator sha256 the grader phase VERIFIED on the box", async () => {
    const out = await grade()
    // the frozen pin — and the grader phase refused unless the box reported it
    expect(out?.observation.evaluatorSha256).toBe(PROMAX_V1_SNAPSHOT.evaluator_sha256)
  })

  test("PAIRED CONTROL: an inline-grading family reports nothing", async () => {
    const out = await runFamilyBoxGrade({
      ssh,
      log: () => {},
      family: "verified",
      bootstrap: undefined,
      paths: DEFAULT_CHUNK_PATHS,
    })
    expect(out).toBeUndefined()
  })
})

describe("WIRING — the family really builds a receipt from that observation", () => {
  test("🔴 promax's receipt port produces a receipt that PARSES under the real validator", async () => {
    const { resolveDatasetFamilyProfile } = await import("@/apps/bench/profiles/registry")
    const { parseOfficialGradeReceipt } = await import("@/runner/batch/eval/official-grade")
    const out = await grade()
    const build = resolveDatasetFamilyProfile("promax").buildBoxGradeReceipt
    if (build === undefined || out === undefined) return

    const json = build({
      assignedInstanceIds: ["aws__s2n-tls-5464"],
      artifactText: out.artifactText,
      artifactPath: "/local/passrate.json",
      ...out.observation,
    })
    const parsed = parseOfficialGradeReceipt(JSON.parse(json) as unknown)
    expect(parsed.ok, "the receipt this path emits does not satisfy its own validator").toBe(true)
  })

  test("🔴 the receipt NAMES the evaluator bytes — the guard that had no producer", async () => {
    const { resolveDatasetFamilyProfile } = await import("@/apps/bench/profiles/registry")
    const out = await grade()
    const build = resolveDatasetFamilyProfile("promax").buildBoxGradeReceipt
    // NOT `if (… === undefined) return`. That is the shape where a family losing
    // its receipt port makes the assertions below disappear and the test PASS.
    if (build === undefined) throw new Error("promax declares no buildBoxGradeReceipt")
    if (out === undefined) throw new Error("the on-box grade produced no observation")
    const json = build({
      assignedInstanceIds: ["aws__s2n-tls-5464"],
      artifactText: out.artifactText,
      artifactPath: "/local/passrate.json",
      ...out.observation,
    })
    expect(json).toContain(PROMAX_V1_SNAPSHOT.evaluator_sha256)
    expect(json).toContain(PROMAX_V1_SNAPSHOT.upstream_git_commit)
    expect(json).toContain("test_run.py")
  })
})

describe("WIRING — the grade records which images it ran against", () => {
  test("🔴 the observation carries a DIGEST-pinned image per assigned instance", async () => {
    const DIGEST = `key4127/refactor-dockerhub@sha256:${"a".repeat(64)}`
    const withImages = async (cmd: string) => {
      if (cmd.includes("image-provenance.py")) {
        return {
          code: 0,
          stdout: `aws__s2n-tls-5464\tkey4127/refactor-dockerhub:aws__s2n-tls-5464\t${DIGEST}\n`,
          stderr: "",
        }
      }
      return ssh(cmd)
    }
    const out = await runFamilyBoxGrade({
      ssh: withImages,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
      paths: DEFAULT_CHUNK_PATHS,
      assignedInstanceIds: ["aws__s2n-tls-5464"],
      sleep: async () => {},
    })
    expect(out?.observation.images).toHaveLength(1)
    expect(out?.observation.images[0]?.repoDigest).toBe(DIGEST)
  })

  test("🔴 a grade whose images cannot be pinned REFUSES rather than reporting a number", async () => {
    const noDigest = async (cmd: string) => {
      if (cmd.includes("image-provenance.py")) {
        return { code: 0, stdout: "aws__s2n-tls-5464\tsome:tag\t\n", stderr: "" }
      }
      return ssh(cmd)
    }
    await expect(
      runFamilyBoxGrade({
        ssh: noDigest,
        log: () => {},
        family: "promax",
        bootstrap: promaxBootstrap(),
        paths: DEFAULT_CHUNK_PATHS,
        assignedInstanceIds: ["aws__s2n-tls-5464"],
        sleep: async () => {},
      }),
    ).rejects.toThrow(/cannot be pinned|NO digest/i)
  })

  test("PAIRED CONTROL: with no assigned set there is nothing to reconcile, and no capture", async () => {
    const out = await grade()
    expect(out?.observation.images).toEqual([])
  })
})

describe("the images reach the RECEIPT, not just the observation", () => {
  test("🔴 the serialized receipt names every image digest", async () => {
    // Every image assertion in this file used to stop at
    // `out.observation.images` — the in-memory value — under a heading claiming
    // the grade RECORDS which images it ran against. It did not: the
    // `buildBoxGradeReceipt` port had no `images` field, promax never read one,
    // and an `as Parameters<…>` cast hid the mismatch. The digests were captured,
    // used to FAIL runs, and dropped on the floor.
    const { resolveDatasetFamilyProfile } = await import("@/apps/bench/profiles/registry")
    const DIGEST = `key4127/refactor-dockerhub@sha256:${"c".repeat(64)}`
    const withImages = async (cmd: string) => {
      if (cmd.includes("image-provenance.py")) {
        return {
          code: 0,
          stdout: `aws__s2n-tls-5464\tkey4127/refactor-dockerhub:aws__s2n-tls-5464\t${DIGEST}\n`,
          stderr: "",
        }
      }
      return ssh(cmd)
    }
    const out = await runFamilyBoxGrade({
      ssh: withImages,
      log: () => {},
      family: "promax",
      bootstrap: promaxBootstrap(),
      paths: DEFAULT_CHUNK_PATHS,
      assignedInstanceIds: ["aws__s2n-tls-5464"],
      sleep: async () => {},
    })
    const build = resolveDatasetFamilyProfile("promax").buildBoxGradeReceipt
    // NOT `if (… === undefined) return`. That is the shape where a family losing
    // its receipt port makes the assertions below disappear and the test PASS.
    if (build === undefined) throw new Error("promax declares no buildBoxGradeReceipt")
    if (out === undefined) throw new Error("the on-box grade produced no observation")

    const json = build({
      assignedInstanceIds: ["aws__s2n-tls-5464"],
      artifactText: out.artifactText,
      artifactPath: "/local/passrate.json",
      ...out.observation,
    })
    // THE claim: the digest is IN the persisted document, not merely in memory.
    expect(json, "the receipt cannot say which image produced its verdicts").toContain(DIGEST)
    expect(json).toContain("aws__s2n-tls-5464")
  })
})

/**
 * WHOSE DIGEST IS ON THE RECEIPT.
 *
 * The existing assertion compares the receipt against
 * `PROMAX_V1_SNAPSHOT.evaluator_sha256` — but the bootstrap's declared
 * expectation is built from that same constant, so the assertion holds equally
 * well if the profile hardcoded the snapshot and never read the plan at all.
 *
 * These drive a bootstrap whose declared digest is NOT the snapshot value, so
 * the only way the receipt can name it is by reading what was verified.
 */
describe("the receipt's evaluator digest is READ, not assumed", () => {
  const OTHER = "b".repeat(64)

  /** promax always declares one; a missing plan is a bug, not a test skip. */
  const realBootstrap = (): FamilyRemoteBootstrap => {
    const b = promaxBootstrap()
    if (b === undefined) throw new Error("promax declares no remote bootstrap")
    return b
  }

  const retargeted = (): FamilyRemoteBootstrap => {
    const real = realBootstrap()
    return {
      ...real,
      commands: real.commands.map((c) =>
        c.verifies?.path.endsWith("test_run.py") === true
          ? { ...c, verifies: { ...c.verifies, sha256: OTHER } }
          : c,
      ),
    }
  }

  const gradeWith = (bootstrap: ReturnType<typeof promaxBootstrap>) =>
    runFamilyBoxGrade({
      ssh: async (cmd: string) => {
        if (cmd.includes("sha256sum") && cmd.includes("test_run.py")) {
          // the box confirms whatever THIS plan declared
          return { code: 0, stdout: `${OTHER}  x`, stderr: "" }
        }
        if (cmd.includes("image-provenance.py")) {
          return {
            code: 0,
            stdout: `aws__s2n-tls-5464\timg:aws__s2n-tls-5464\timg@sha256:${"d".repeat(64)}\n`,
            stderr: "",
          }
        }
        return ssh(cmd)
      },
      log: () => {},
      family: "promax",
      bootstrap,
      paths: DEFAULT_CHUNK_PATHS,
      assignedInstanceIds: ["aws__s2n-tls-5464"],
      sleep: async () => {},
    })

  test("🔴 the receipt names the digest the PLAN declared and the box confirmed", async () => {
    const { resolveDatasetFamilyProfile } = await import("@/apps/bench/profiles/registry")
    const out = await gradeWith(retargeted())
    const build = resolveDatasetFamilyProfile("promax").buildBoxGradeReceipt
    if (build === undefined) throw new Error("promax declares no buildBoxGradeReceipt")
    if (out === undefined) throw new Error("the on-box grade produced no observation")
    const json = build({
      assignedInstanceIds: ["aws__s2n-tls-5464"],
      artifactText: out.artifactText,
      artifactPath: "/local/passrate.json",
      ...out.observation,
    })
    expect(json, "the receipt named a digest nobody verified").toContain(OTHER)
    expect(
      json,
      "the receipt named the frozen constant instead of the verified plan",
    ).not.toContain(PROMAX_V1_SNAPSHOT.evaluator_sha256)
  })

  test("🔴 a grader phase declaring NO evaluator digest is REFUSED, not graded", async () => {
    const real = realBootstrap()
    // OMIT `verifies` rather than setting it to `undefined`: the field is
    // optional, and a plan that "declares a verification of nothing" is not the
    // shape under test — a plan that declares none is.
    const blind: FamilyRemoteBootstrap = {
      ...real,
      commands: real.commands.map((c) => {
        if (c.verifies?.path.endsWith("test_run.py") !== true) return c
        const { verifies: _dropped, ...rest } = c
        return rest
      }),
    }
    // the refusal branch of `verifiedEvaluatorSha256` had no test at all: a plan
    // that verifies nothing would have produced a receipt naming "" as the bytes
    // that produced the verdicts.
    await expect(gradeWith(blind)).rejects.toThrow(/declares no evaluator digest/i)
  })
})
