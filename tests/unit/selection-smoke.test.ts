import { describe, expect, test } from "bun:test"
import type { Candidate } from "@/runner/batch/eval/selection-executor"
import {
  type PrepareIssueSmokeSelectionPortDeps,
  prepareIssueSmokeAux,
  prepareIssueSmokeSelectionPort,
  runIssueSmokeScript,
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

describe("prepareIssueSmokeSelectionPort (base-RED executed-authority gate)", () => {
  // The extractor is a HEURISTIC regex guess. It may only confer a veto after the
  // base-RED gate proves the source actually reproduces the failure on base.

  test("base-RED public MWE (proven oracle) becomes a candidate veto authority", async () => {
    const deps: PrepareIssueSmokeSelectionPortDeps = {
      resetBase: async () => true,
      // Base run reproduces the failure (exit≠0 ⇒ false). A candidate that FIXES
      // it runs green (true) in /tmp/fixed; one that leaves it red (false) elsewhere.
      runScript: async (_instance, sandbox) => sandbox.includes("fixed"),
      rematerialize: fakeRematerialize((patch) =>
        patch.includes("fix") ? "/tmp/fixed" : "/tmp/stillred",
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
    // Candidate that fixes the base-red oracle ⇒ true (no veto).
    await expect(smoke(mkCandidate("+++ b/x.py\n+fix"))).resolves.toBe(true)
    // Candidate that leaves the proven base-red oracle red ⇒ false (executed veto).
    await expect(smoke(mkCandidate("+++ b/x.py\n+nope"))).resolves.toBe(false)
  })

  // TEETH: the legacy base-GREEN gate would have manufactured a keep-green veto
  // here (base ran clean, candidate "broke" it). A base-green source is NOT a
  // proven oracle — an "Expected output" block that merely runs clean must NOT
  // grant the regex guess executed authority. New invariant ⇒ no veto port.
  test("base-GREEN source confers NO authority (regex guess stays seed-only)", async () => {
    const runCalls: string[] = []
    const deps: PrepareIssueSmokeSelectionPortDeps = {
      resetBase: async () => true,
      // Base runs CLEAN (green/true) — could be a wrong block that just imports.
      runScript: async (_instance, sandbox) => {
        runCalls.push(sandbox)
        return true
      },
      rematerialize: fakeRematerialize(() => "/tmp/any"),
    }
    const port = await prepareIssueSmokeSelectionPort(
      mkSmokeInstance(issue),
      "/tmp/base",
      1000,
      deps,
    )
    expect(port).toBeUndefined()
    // It probed base exactly once and then refused authority — no candidate run.
    expect(runCalls).toEqual(["/tmp/base"])
  })

  test("base setup/exec failure (null) confers NO authority (fail-open)", async () => {
    const port = await prepareIssueSmokeSelectionPort(mkSmokeInstance(issue), "/tmp/base", 1000, {
      resetBase: async () => true,
      runScript: async () => null,
    })
    expect(port).toBeUndefined()
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

  // TEETH (the bug scenario end-to-end): the issue's only fenced block is an
  // "Expected output" snippet that `hasCall` mis-extracts. It runs CLEAN on base
  // (it's just a print). Under the old base-GREEN gate this would have become a
  // keep-green veto authority over candidate selection — a wrong block driving the
  // oracle. The base-RED gate refuses it: NO veto port, the regex guess stays a seed.
  test("mis-extracted 'Expected output' block granted NO executed authority", async () => {
    const outputOnlyIssue =
      "The MathML printer drops subscripts.\n\nExpected output:\n```python\nprint('<msub>...</msub>')\n```"
    const candidateRuns: string[] = []
    const port = await prepareIssueSmokeSelectionPort(
      mkSmokeInstance(outputOnlyIssue),
      "/tmp/base",
      1000,
      {
        resetBase: async () => true,
        // The mis-extracted output block runs clean on base (green/true).
        runScript: async () => true,
        rematerialize: fakeRematerialize((patch) => {
          candidateRuns.push(patch)
          return "/tmp/any"
        }),
      },
    )
    // No authority: the regex guess that merely runs clean cannot veto candidates.
    expect(port).toBeUndefined()
    // And it never executed any CANDIDATE (authority was refused at the base gate).
    expect(candidateRuns).toEqual([])
  })
})

describe("runIssueSmokeScript", () => {
  test("Pro python instance with dockerhubTag ⇒ issue smoke runs inside the instance image", async () => {
    const seen: (readonly string[])[] = []
    const ok = await runIssueSmokeScript(
      {
        swebench: {
          instanceId: "qutebrowser__qutebrowser-pro-1",
          repo: "qutebrowser/qutebrowser",
          version: "1.0",
          baseCommit: "abc",
          repoLanguage: "python",
          dockerhubTag: "qutebrowser.demo",
        },
      },
      "/tmp/sb",
      "print('ok')",
      1000,
      {
        writeFile: async () => {},
        removeFile: async () => {},
        exec: async (argv) => {
          seen.push(argv)
          return { code: 0, stdout: "", stderr: "" }
        },
      },
    )
    expect(ok).toBe(true)
    expect(seen[0]).toEqual([
      "docker",
      "run",
      "--rm",
      "-v",
      "/tmp/sb:/tmp/sb",
      "-w",
      "/tmp/sb",
      "jefzda/sweap-images:qutebrowser.demo",
      "python",
      "-s",
      "/tmp/sb/.quanta-issue-smoke.py",
    ])
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
