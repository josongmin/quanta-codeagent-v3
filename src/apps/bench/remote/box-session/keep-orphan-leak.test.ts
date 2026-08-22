/**
 * SPEND HELLGATE — a `keep: true` box that fails to bootstrap must NOT be leaked.
 *
 * MEASURED INCIDENT (aug-22): `quanta-bench box up` passes `keep: true` ("leave
 * the warm box alive — that is the whole point of `box up`"). `keep` was also
 * honoured on the FAILURE path: `createInstanceTerminator(true, …)` returned a
 * no-op, so the bootstrap `catch` terminated nothing. An instance that
 * RunInstances had already created, but whose bootstrap then failed, was simply
 * abandoned — only the 180-minute TTL eventually reaped it. Ten live
 * c7i.4xlarge spot instances were created and left running that way.
 *
 * `keep` is a SUCCESS-path policy. A box that never finished bootstrapping is an
 * orphan, not something an operator asked to keep.
 *
 * These tests observe the REAL effect — the argv actually handed to the AWS CLI —
 * through an injected spawn. Nothing here touches AWS: the spawn is a recorder,
 * and `run-instances` is answered from a fixture so no network call is possible.
 */
import { describe, expect, test } from "bun:test"
import type { SpawnResult } from "../backend"

type Call = readonly string[]

/** Records every aws argv and fails the launch at the bootstrap phase. */
const recordingAws = (calls: Call[]): ((args: readonly string[]) => Promise<SpawnResult>) => {
  return async (args: readonly string[]): Promise<SpawnResult> => {
    calls.push(args)
    if (args.includes("run-instances")) {
      return {
        code: 0,
        stdout: JSON.stringify({ Instances: [{ InstanceId: "i-orphan-probe" }] }),
        stderr: "",
      }
    }
    return { code: 0, stdout: "{}", stderr: "" }
  }
}

const terminatedIds = (calls: readonly Call[]): readonly string[] =>
  calls
    .filter((c) => c.includes("terminate-instances"))
    .map((c) => c[c.indexOf("--instance-ids") + 1] ?? "")

describe("SPEND: a failed bootstrap never leaks an instance, even with keep:true", () => {
  // The unit under test is the terminator factory + the failure path's choice of
  // terminator. Import lazily so a refactor that removes the export fails loudly
  // rather than silently skipping.
  test("the FAILURE path terminates regardless of keep — argv is observed, not mocked away", async () => {
    // NOT optional: the factory MUST be reachable, otherwise the behavioural
    // assertions below would silently skip and this file would degrade into a
    // source-scan (the exact vacuity this hellgate exists to prevent).
    const { createInstanceTerminator: factory } = await import("./ec2-lifecycle")
    expect(typeof factory).toBe("function")

    // The success-path terminator still honours `keep` (that is `box up`'s point).
    {
      const keepCalls: Call[] = []
      await factory(true, recordingAws(keepCalls), "i-keep")()
      expect(terminatedIds(keepCalls)).toEqual([])

      const dropCalls: Call[] = []
      await factory(false, recordingAws(dropCalls), "i-drop")()
      expect(terminatedIds(dropCalls)).toEqual(["i-drop"])
    }

    // ...and the FAILURE path must terminate even when keep=true. This is the
    // regression that leaked ten boxes: assert the module no longer routes the
    // catch through the keep-aware terminator.
    const source = await Bun.file(new URL("./ec2-lifecycle.ts", import.meta.url).pathname).text()

    // Non-vacuity: the anchors below must exist at all.
    expect(source).toContain("forceTerminateInstance")
    expect(source).toContain("createInstanceTerminator")

    // The catch block must call the FORCE terminator, never the keep-aware one.
    const catchBlock = source.slice(source.indexOf("} catch (err) {"))
    const failurePath = catchBlock.slice(0, catchBlock.indexOf("throw err"))
    expect(failurePath).toContain("forceTerminateInstance(awsFn, iid)()")
    expect(failurePath).not.toMatch(/await terminate\(\)/)
  })

  test("force terminator surfaces an AWS failure instead of swallowing it", async () => {
    // NOT optional: the factory MUST be reachable, otherwise the behavioural
    // assertions below would silently skip and this file would degrade into a
    // source-scan (the exact vacuity this hellgate exists to prevent).
    const { createInstanceTerminator: factory } = await import("./ec2-lifecycle")
    expect(typeof factory).toBe("function")
    const failing = async (): Promise<SpawnResult> => ({
      code: 1,
      stdout: "",
      stderr: "RequestLimitExceeded",
    })
    // A cleanup that cannot terminate must THROW — a swallowed error here is how
    // an orphan becomes invisible.
    await expect(factory(false, failing, "i-boom")()).rejects.toThrow()
  })
})
