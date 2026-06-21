import { describe, expect, test } from "bun:test"
import type { Candidate } from "@/runner/batch/eval/selection-executor"
import {
  type PrepareIssueSmokeSelectionPortDeps,
  prepareIssueSmokeAux,
  prepareIssueSmokeSelectionPort,
  seedFromIssueSmoke,
} from "@/runner/batch/eval/selection-smoke"

const mkCandidate = (patch: string): Candidate => ({
  id: "cand-0",
  patch,
  turns: 1,
  files: ["x.py"],
  baseValidatedRed: true,
})

const issue = "#### Minimal example\n```python\nimport xarray as xr\nxr.DataArray([1])\n```"

type SmokeInstance = Parameters<typeof prepareIssueSmokeAux>[0]

/** Build a typed smoke instance, omitting `localEnv` (exactOptionalPropertyTypes
 *  rejects an explicit `undefined` on an optional prop; the port reads it via
 *  `localEnv !== undefined`, so omission is equivalent). */
const mkSmokeInstance = (problemStatement: string): SmokeInstance => ({
  problemStatement,
  swebench: { repo: "pydata/xarray", version: "0.12", baseCommit: "abc", instanceId: "x" },
})

type Rematerialize = NonNullable<PrepareIssueSmokeSelectionPortDeps["rematerialize"]>

/** Fake rematerialize: route the probe to a sandbox path chosen by `pickSandbox`
 *  so the test drives baseGreen/patchedGreen deterministically. Typed as the
 *  real `withCandidatePatch` generic so no `any` leaks. */
const fakeRematerialize =
  (pickSandbox: (patch: string) => string): Rematerialize =>
  <T>(args: Parameters<Rematerialize>[0]): Promise<T | null> =>
    args.probe(pickSandbox(args.patch)) as Promise<T | null>

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
      mkSmokeInstance(issue),
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
      rematerialize: fakeRematerialize((patch) =>
        patch.includes("break") ? "/tmp/broken" : "/tmp/clean",
      ),
    }
    const port = await prepareIssueSmokeSelectionPort(
      mkSmokeInstance(issue),
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
      mkSmokeInstance("No runnable public MWE here."),
      "/tmp/base",
      1000,
      { resetBase: async () => true },
    )
    expect(port).toBeUndefined()
  })
})

/**
 * T-SMK-04 — issue smoke is demoted to a repro SEED. The extracted snippet is
 * exposed with `provenance: "repro-seed"` so it can seed repro generation, never
 * decide admissibility on its own.
 */
describe("seedFromIssueSmoke (repro-seed, not a gate)", () => {
  test("executable public MWE ⇒ repro-seed snippet", () => {
    const seed = seedFromIssueSmoke({ problemStatement: issue })
    expect(seed?.provenance).toBe("repro-seed")
    expect(seed?.code).toContain("import xarray")
  })

  test("no executable MWE ⇒ no seed (extractor false-positive cannot fabricate one)", () => {
    expect(seedFromIssueSmoke({ problemStatement: "No runnable MWE here." })).toBeUndefined()
  })
})

/**
 * T-SMK-04 — auxiliary-only issue smoke. The probe RUNS the MWE but yields
 * telemetry (`baseGreen`/`patchedGreen`/`wouldReject`), never a veto boolean the
 * selector feeds into `smokeGreen`. A candidate that fails standalone issue
 * smoke is therefore NOT made inadmissible: `wouldReject` is recorded separately
 * from any admissibility effect.
 */
describe("prepareIssueSmokeAux (auxiliary telemetry, no veto)", () => {
  test("candidate failing standalone smoke yields aux telemetry, not a veto boolean", async () => {
    const deps: PrepareIssueSmokeSelectionPortDeps = {
      resetBase: async () => true,
      runScript: async (_instance, sandbox) => !sandbox.includes("broken"),
      rematerialize: fakeRematerialize((patch) =>
        patch.includes("break") ? "/tmp/broken" : "/tmp/clean",
      ),
    }
    const aux = await prepareIssueSmokeAux(mkSmokeInstance(issue), "/tmp/base", 1000, deps)
    expect(aux).toBeDefined()
    const probe = aux!
    // A candidate that BREAKS the public MWE: the legacy gate would have vetoed.
    const broke = await probe(mkCandidate("+++ b/x.py\n+break"))
    // The API returns AUX TELEMETRY, not a boolean the selector treats as a veto.
    expect(typeof broke).toBe("object")
    expect(broke.baseGreen).toBe(true)
    expect(broke.patchedGreen).toBe(false)
    // wouldReject is RECORDED, separate from any admissibility effect.
    expect(broke.wouldReject).toBe(true)

    // A candidate that keeps the MWE green is not flagged.
    const safe = await probe(mkCandidate("+++ b/x.py\n+safe"))
    expect(safe.patchedGreen).toBe(true)
    expect(safe.wouldReject).toBe(false)
  })

  test("base setup failure stays fail-open (no aux probe)", async () => {
    const aux = await prepareIssueSmokeAux(
      mkSmokeInstance(issue),
      "/tmp/base",
      1000,
      // Base reset always fails ⇒ no probe, fail-open.
      { resetBase: async () => false },
    )
    expect(aux).toBeUndefined()
  })

  test("base-red MWE: probe runs but never reports wouldReject (no veto manufactured)", async () => {
    const deps: PrepareIssueSmokeSelectionPortDeps = {
      resetBase: async () => true,
      // Base MWE is RED (false) regardless of tree.
      runScript: async () => false,
      rematerialize: fakeRematerialize(() => "/tmp/any"),
    }
    const aux = await prepareIssueSmokeAux(mkSmokeInstance(issue), "/tmp/base", 1000, deps)
    expect(aux).toBeDefined()
    const r = await aux!(mkCandidate("+++ b/x.py\n+anything"))
    expect(r.baseGreen).toBe(false)
    // Legacy gate only ever vetoed on a base-GREEN MWE ⇒ never wouldReject here.
    expect(r.wouldReject).toBe(false)
  })

  test("no executable MWE ⇒ no aux probe", async () => {
    const aux = await prepareIssueSmokeAux(mkSmokeInstance("No runnable MWE."), "/tmp/base", 1000, {
      resetBase: async () => true,
    })
    expect(aux).toBeUndefined()
  })
})
