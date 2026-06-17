import { describe, expect, test } from "bun:test"
import { runRepairRounds } from "@/runner/batch/eval/repair/index"
import type { RunOnceResult, ValidateArgs, ValidatorResult } from "@/runner/batch/eval/repair/types"

/**
 * T-302 — primary-rail enforcement in the repair orchestrator (the false-green
 * killer at the driver level). When `primaryRailCmd` is set, the per-round
 * validator gate must run THAT command, NOT the agent's own `lastVerifyCmd` /
 * repro — so a non-primary green can no longer clear the loop. Unset ⇒
 * byte-identical (agent-command gate).
 *
 * Red-on-injection: delete the `args.primaryRailCmd` branch in runValidate and
 * PR-1/PR-2 fail (the agent's green cmd would wrongly clear the round).
 */

const runOnce =
  (lastVerifyCmd: string | undefined) =>
  async (_seed: string | undefined): Promise<RunOnceResult> => ({
    patch: "diff --git a/x b/x\n",
    turns: 1,
    ...(lastVerifyCmd !== undefined ? { lastVerifyCmd } : {}),
  })

/** A validate spy: records the cmd it was handed, passes iff cmd is in `passing`. */
const makeValidate = (passing: ReadonlySet<string>) => {
  const seen: (string | undefined)[] = []
  const validate = async (args: ValidateArgs): Promise<ValidatorResult> => {
    seen.push(args.cmd)
    return args.cmd !== undefined && passing.has(args.cmd) ? { ok: true } : { ok: false, failTail: "x" }
  }
  return { validate, seen }
}

const base = {
  config: { maxRounds: 1 },
  problem: "fix it",
  buildContext: () => "seed",
  sandbox: "/tmp/sb",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  timeoutMs: 1000,
}

describe("T-302 repair primary-rail enforcement", () => {
  test("PR-1: rail RED + agent cmd would PASS ⇒ round NOT cleared (false-green killed)", async () => {
    // agent's own verify ('agent-green') is in the passing set; the rail is NOT.
    const { validate, seen } = makeValidate(new Set(["agent-green"]))
    const out = await runRepairRounds({
      ...base,
      runOnce: runOnce("agent-green"),
      validate,
      primaryRailCmd: "rail-cmd",
    })
    // validator was handed the RAIL cmd, never the agent's green cmd.
    expect(seen.every((c) => c === "rail-cmd")).toBe(true)
    expect(seen).not.toContain("agent-green")
    // rail never passes ⇒ loop exhausts unresolved (the would-be false green is gone).
    expect(out.validated).toBe(false)
  })

  test("PR-2: rail GREEN ⇒ round cleared on the rail (not the agent cmd)", async () => {
    const { validate, seen } = makeValidate(new Set(["rail-cmd"]))
    const out = await runRepairRounds({
      ...base,
      runOnce: runOnce("agent-red"),
      validate,
      primaryRailCmd: "rail-cmd",
    })
    expect(out.validated).toBe(true)
    expect(seen[0]).toBe("rail-cmd")
  })

  test("PR-3: primaryRailCmd UNSET ⇒ byte-identical agent-command gate", async () => {
    const { validate, seen } = makeValidate(new Set(["agent-green"]))
    const out = await runRepairRounds({
      ...base,
      runOnce: runOnce("agent-green"),
      validate,
      // no primaryRailCmd
    })
    expect(seen[0]).toBe("agent-green")
    expect(out.validated).toBe(true)
  })
})
