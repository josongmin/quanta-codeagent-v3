/**
 * PMX-04 — A FAMILY THAT GRADES ON-BOX NEVER ASKS FOR THE SWEBENCH HARNESS.
 *
 * `harnessSpec` refuses for ProMax, and that refusal is load-bearing: the
 * `swebench` pip package and the `swebench`/`starryzhang` image namespaces are
 * not ProMax's grader, and returning the stock spec would make a ProMax box
 * byte-indistinguishable from a Verified one in the harness axis.
 *
 * But it was still CALLED unconditionally on the money path — once per fresh
 * provision (the pip-spec that builds the on-box grading shim) and once per
 * chunk (the image namespace baked into the bench command). Opening the lane
 * deleted the three refusals that fired BEFORE `RunInstances` and left this one,
 * which fires after. So a ProMax run provisioned a real box and then died: it
 * cost a box to learn what used to be free.
 *
 * That is the exact failure the aug-22 A-C round hoisted `admitBox` out of
 * `setupBox` to kill — a guard that runs once the box has already been paid for
 * and rewritten is not a guard.
 *
 * The fix is not to soften `harnessSpec`. It is to stop asking a family for a
 * harness it does not use: a family declaring `boxGrade` grades with its OWN
 * pinned evaluator, so neither the shim nor the namespace means anything to it.
 */
import { describe, expect, test } from "bun:test"
import type { DatasetFamily } from "@/apps/bench/dataset-family-token"
import { resolveDatasetFamilyProfile } from "@/apps/bench/profiles/registry"
import { buildBenchCommand } from "@/apps/bench/remote/box-session"
import { DEFAULT_CHUNK_PATHS } from "@/apps/bench/remote/box-session/types"

const params = (family: DatasetFamily) =>
  ({
    datasetPath: "/ds.jsonl",
    authJson: "{}",
    preset: "agentless-v1",
    model: "gpt-5",
    concurrency: 1,
    artifactSuffix: "run1",
    recordTrajectory: false,
    forwardedBenchEnv: "",
    datasetFamily: family,
  }) as Parameters<typeof buildBenchCommand>[0]

describe("the bench command for an on-box-grading family", () => {
  test("🔴 building it does NOT throw — the refusal must not fire after the box is paid for", () => {
    expect(() => buildBenchCommand(params("promax"), DEFAULT_CHUNK_PATHS)).not.toThrow()
  })

  test("🔴 it carries NO swebench image namespace — that axis is not ProMax's grader", () => {
    const cmd = buildBenchCommand(params("promax"), DEFAULT_CHUNK_PATHS)
    expect(cmd).not.toContain("QUANTA_SWEBENCH_NAMESPACE")
    // …and still no inline grading shim, which is the other half of the split
    expect(cmd).not.toContain("QUANTA_SWEBENCH_PYTHON=1")
  })

  test("PAIRED CONTROL: an inline-grading family still gets BOTH, byte-for-byte", () => {
    const cmd = buildBenchCommand(params("verified"), DEFAULT_CHUNK_PATHS)
    expect(cmd).toContain("QUANTA_SWEBENCH_NAMESPACE=")
    expect(cmd).toContain("QUANTA_SWEBENCH_PYTHON=1")
  })

  test("the refusal itself is UNCHANGED — nothing may reach the swebench harness", () => {
    // Softening `harnessSpec` would have been the wrong fix: it is what stops a
    // ProMax box being byte-indistinguishable from a Verified one.
    expect(() => resolveDatasetFamilyProfile("promax").harnessSpec({ datasetName: "" })).toThrow(
      /swebench pip-spec \/ image namespace/,
    )
  })
})
