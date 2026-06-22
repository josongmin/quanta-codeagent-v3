import { describe, expect, test } from "bun:test"
import type { ReproExecPort } from "@/agent/repro-test/execute"
import {
  buildImportProbeInputs,
  enrichInputsFromInstances,
  parseReproScriptsSidecar,
  type RescoreInstanceCoords,
  runReproRescore,
  summarizeRescore,
} from "@/runner/batch/eval/repro-rescore-run"

/**
 * Hellgate — the production glue around {@link rescoreReproScripts}: parse the
 * persisted repro-scripts sidecar, build a synthetic import-probe (for the
 * build-env class where the script content is irrelevant — the repo can't even
 * BUILD), orchestrate, and summarize. All driven with injected ports so no real
 * checkout / subprocess / LLM is needed.
 */

const SIDECAR = [
  JSON.stringify({
    instance_id: "astropy__astropy-13033",
    repo: "astropy/astropy",
    version: "5.1",
    base_commit: "298ccb478e",
    scripts: [
      { source: "import astropy\nprint('Issue reproduced')", outcome: "exec_failed" },
      { source: "import astropy.table", outcome: "exec_failed" },
    ],
  }),
  "", // blank line tolerated
  JSON.stringify({
    instance_id: "django__django-11138",
    repo: "django/django",
    version: "3.0",
    scripts: [{ source: "print('Other issues')", outcome: "other" }],
  }),
].join("\n")

const fakeExecByCwd =
  (byCwd: Record<string, { code: number; stdout: string }>): ReproExecPort =>
  async (_argv, cwd, _t) => {
    const r = byCwd[cwd] ?? { code: 1, stdout: "" }
    return { code: r.code, stdout: r.stdout, stderr: "" }
  }

describe("parseReproScriptsSidecar", () => {
  test("PS-1: parses jsonl into rescore inputs, tolerating blank lines", () => {
    const inputs = parseReproScriptsSidecar(SIDECAR)
    expect(inputs.map((i) => i.instanceId)).toEqual([
      "astropy__astropy-13033",
      "django__django-11138",
    ])
    const astro = inputs[0]
    expect(astro?.repo).toBe("astropy/astropy")
    expect(astro?.version).toBe("5.1")
    expect(astro?.baseCommit).toBe("298ccb478e")
    expect(astro?.scripts).toHaveLength(2)
    expect(astro?.scripts[0]?.source).toContain("import astropy")
    // recorded outcome is carried through for parity comparison
    expect(astro?.scripts[0]?.recordedOutcome).toBe("exec_failed")
  })

  test("PS-2: a malformed line throws loudly (never silently drops an instance)", () => {
    expect(() => parseReproScriptsSidecar('{"instance_id":"x"  BROKEN')).toThrow()
  })
})

describe("buildImportProbeInputs", () => {
  test("IP-1: synthesizes an import probe per instance (build-env class needs no real script)", () => {
    const inputs = buildImportProbeInputs([
      { instanceId: "astropy__astropy-13033", repo: "astropy/astropy", version: "5.1" },
    ])
    expect(inputs).toHaveLength(1)
    // the probe imports the repo's top package and prints the reproduced marker
    expect(inputs[0]?.scripts[0]?.source).toContain("import astropy")
    expect(inputs[0]?.scripts[0]?.source).toContain("Issue reproduced")
  })

  test("IP-2: a repo whose import name diverges from the slug uses the known alias (no false exec_failed)", () => {
    const inputs = buildImportProbeInputs([
      { instanceId: "scikit-learn__scikit-learn-1", repo: "scikit-learn/scikit-learn", version: "1.3" },
    ])
    // slug tail would be `scikit_learn` (ModuleNotFoundError); the real module is `sklearn`.
    expect(inputs[0]?.scripts[0]?.source).toContain("import sklearn")
    expect(inputs[0]?.scripts[0]?.source).not.toContain("import scikit_learn")
  })
})

describe("enrichInputsFromInstances", () => {
  const byId: ReadonlyMap<string, RescoreInstanceCoords> = new Map([
    ["astropy__astropy-13033", { instanceId: "astropy__astropy-13033", repo: "astropy/astropy", version: "5.1", baseCommit: "298ccb" }],
  ])

  test("EN-1: fills missing checkout coords from the matched instance", () => {
    const { enriched, unmatched } = enrichInputsFromInstances(
      [{ instanceId: "astropy__astropy-13033", scripts: [{ source: "x" }] }],
      byId,
    )
    expect(unmatched).toEqual([])
    expect(enriched[0]?.repo).toBe("astropy/astropy")
    expect(enriched[0]?.version).toBe("5.1")
    expect(enriched[0]?.baseCommit).toBe("298ccb")
  })

  test("EN-2: sidecar-provided coords take precedence over the corpus", () => {
    const { enriched } = enrichInputsFromInstances(
      [{ instanceId: "astropy__astropy-13033", repo: "fork/astropy", scripts: [{ source: "x" }] }],
      byId,
    )
    expect(enriched[0]?.repo).toBe("fork/astropy")
  })

  test("EN-3: an input with no matching instance is DROPPED and reported (never silently swallowed)", () => {
    const { enriched, unmatched } = enrichInputsFromInstances(
      [{ instanceId: "ghost__ghost-1", scripts: [{ source: "x" }] }],
      byId,
    )
    expect(enriched).toEqual([])
    expect(unmatched).toEqual(["ghost__ghost-1"])
  })

  test("EN-4: an unmatched id is dropped even when the sidecar itself carries coords", () => {
    // A ghost can't be checked out regardless of sidecar repo — dropping is correct.
    const { enriched, unmatched } = enrichInputsFromInstances(
      [{ instanceId: "ghost__ghost-1", repo: "custom/repo", scripts: [{ source: "x" }] }],
      byId,
    )
    expect(enriched).toEqual([])
    expect(unmatched).toEqual(["ghost__ghost-1"])
  })
})

describe("summarizeRescore", () => {
  test("SM-1: counts reproduced / drift / errored across instances", () => {
    const summary = summarizeRescore([
      { instanceId: "a", outcomes: ["reproduced"], reproducedCount: 1, recordedOutcomes: ["exec_failed"], parity: "drift" },
      { instanceId: "b", outcomes: ["exec_failed"], reproducedCount: 0, recordedOutcomes: ["exec_failed"], parity: "match" },
      { instanceId: "c", outcomes: [], reproducedCount: 0, recordedOutcomes: [], parity: "unknown", error: "boom" },
    ])
    expect(summary.total).toBe(3)
    expect(summary.instancesReproduced).toBe(1)
    expect(summary.drift).toBe(1)
    expect(summary.errored).toBe(1)
  })

  test("SM-2: all-errored run does NOT leak into reproduced/drift buckets", () => {
    const summary = summarizeRescore([
      { instanceId: "a", outcomes: [], reproducedCount: 0, recordedOutcomes: [], parity: "unknown", error: "checkout failed" },
      { instanceId: "b", outcomes: [], reproducedCount: 0, recordedOutcomes: [], parity: "unknown", error: "exec crashed" },
    ])
    expect(summary.total).toBe(2)
    expect(summary.errored).toBe(2)
    expect(summary.drift).toBe(0)
    expect(summary.instancesReproduced).toBe(0)
  })
})

describe("parseReproScriptsSidecar — hardened against silent corruption", () => {
  test("PS-3: an empty scripts[] throws (would otherwise rescore to a misleading outcomes:[])", () => {
    expect(() =>
      parseReproScriptsSidecar(JSON.stringify({ instance_id: "x", scripts: [] })),
    ).toThrow(/empty scripts/)
  })

  test("PS-4: a script with missing/empty source throws (would otherwise cause spurious drift)", () => {
    expect(() =>
      parseReproScriptsSidecar(
        JSON.stringify({ instance_id: "x", scripts: [{ outcome: "reproduced" }] }),
      ),
    ).toThrow(/missing\/empty source/)
  })
})

describe("runReproRescore — end-to-end orchestration with injected ports (zero LLM, zero clone)", () => {
  test("RUN-1: rescores sidecar inputs and flips astropy exec_failed→reproduced when build-env is fixed", async () => {
    const inputs = parseReproScriptsSidecar(SIDECAR)
    // Simulate the FIXED build-env: astropy now imports clean and reproduces;
    // django still hits "Other issues".
    const exec = fakeExecByCwd({
      "/sb/astropy__astropy-13033": { code: 0, stdout: "Issue reproduced\n" },
      "/sb/django__django-11138": { code: 0, stdout: "Other issues\n" },
    })
    const { results, summary } = await runReproRescore(inputs, {
      prepareSandbox: async (i) => `/sb/${i.instanceId}`,
      exec,
      writeFile: async () => {},
      buildArgv: (i, p) => ["uv", "run", "--python", i.version ?? "3", "python", p],
    })
    const astro = results.find((r) => r.instanceId === "astropy__astropy-13033")
    expect(astro?.reproducedCount).toBe(2)
    expect(astro?.parity).toBe("drift") // was exec_failed, now reproduced — the win is visible
    expect(summary.instancesReproduced).toBe(1)
  })
})
