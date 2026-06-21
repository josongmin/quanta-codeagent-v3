import { describe, expect, test } from "bun:test"
import type { Candidate } from "@/runner/batch/eval/selection-executor"
import {
  prepareIssueSmokeSelectionPort,
  type PrepareIssueSmokeSelectionPortDeps,
} from "@/runner/batch/eval/selection-smoke"

const mkCandidate = (patch: string): Candidate => ({
  id: "cand-0",
  patch,
  turns: 1,
  files: ["x.py"],
  baseValidatedRed: true,
})

const issue = "#### Minimal example\n```python\nimport xarray as xr\nxr.DataArray([1])\n```"

describe("prepareIssueSmokeSelectionPort", () => {
  test("base-red public MWE does not become selector authority", async () => {
    const runCalls: string[] = []
    const deps: PrepareIssueSmokeSelectionPortDeps = {
      resetBase: async () => true,
      runScript: async (_instance, sandbox) => {
        runCalls.push(sandbox)
        return false
      },
    }
    const port = await prepareIssueSmokeSelectionPort(
      {
        problemStatement: issue,
        localEnv: undefined,
        swebench: { repo: "pydata/xarray", version: "0.12", baseCommit: "abc", instanceId: "x" },
      },
      "/tmp/base",
      1000,
      deps,
    )
    expect(port).toBeUndefined()
    expect(runCalls).toEqual(["/tmp/base"])
  })

  test("base-green public MWE becomes a candidate keep-green hard gate", async () => {
    const deps: PrepareIssueSmokeSelectionPortDeps = {
      resetBase: async () => true,
      runScript: async (_instance, sandbox) => !sandbox.includes("broken"),
      rematerialize: (async <T>({ patch, probe }) =>
        (await probe(patch.includes("break") ? "/tmp/broken" : "/tmp/clean")) as T) as
        PrepareIssueSmokeSelectionPortDeps["rematerialize"],
    }
    const port = await prepareIssueSmokeSelectionPort(
      {
        problemStatement: issue,
        localEnv: undefined,
        swebench: { repo: "pydata/xarray", version: "0.12", baseCommit: "abc", instanceId: "x" },
      },
      "/tmp/base",
      1000,
      deps,
    )
    expect(port).toBeDefined()
    const smoke = port!
    await expect(smoke(mkCandidate("+++ b/x.py\n+safe"))).resolves.toBe(true)
    await expect(smoke(mkCandidate("+++ b/x.py\n+break"))).resolves.toBe(false)
  })

  test("no executable public python block => no smoke port", async () => {
    const port = await prepareIssueSmokeSelectionPort(
      {
        problemStatement: "No runnable public MWE here.",
        localEnv: undefined,
        swebench: { repo: "pydata/xarray", version: "0.12", baseCommit: "abc", instanceId: "x" },
      },
      "/tmp/base",
      1000,
      { resetBase: async () => true },
    )
    expect(port).toBeUndefined()
  })
})
