/**
 * jun-30 T4 — `DatasetFamilyProfile` registry: the SINGLE per-family backend
 * port. This RED test encodes the DoD: every family resolves ALL FOUR
 * behaviors (readCorpus / gradeEvaluator / harnessSpec+onBoxEnvPrefix+setupBox /
 * preflight / remoteDefaultPreset) from ONE
 * profile object, and each behavior is byte-identical to the pre-T4 scattered
 * string-compare sites for verified/live/pro.
 *
 * Non-vacuity: the full {verified, live, pro} union flows through every
 * assertion (no single-literal narrowing), and each behavior is observed by
 * REAL effect (a derived testCmd, a verifier log string, a resolved pip-spec /
 * namespace / on-box env prefix, a thrown preflight refusal) — not a source
 * string. red-on-injection is proven by the scattered-consumer scan test.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatasetFamily } from "../dataset-family"
import { RemoteDatasetPreflightError } from "../remote/box-session/dataset-rows"
import type { Instance } from "../types"
import { loadFamilyCorpusRowsOrThrow } from "./corpus-read"
import { DATASET_FAMILY_PROFILES, resolveDatasetFamilyProfile } from "./registry"
import type { PreflightInput } from "./types"

const ALL_FAMILIES: readonly DatasetFamily[] = ["verified", "live", "pro", "promax"] as const

/** The families whose HARNESS SPEC is a swebench pip build. ProMax is excluded
 *  on purpose: it grades with its own pinned upstream evaluator and refuses the
 *  `swebench` pip-spec / image namespace outright (see `profiles/promax.ts` and
 *  the dedicated assertion in `behavior 3a` below), so a `swebench`-shaped
 *  expectation would be wrong rather than merely inapplicable. */
const SWEBENCH_HARNESS_FAMILIES = ["verified", "live", "pro"] as const

describe("registry — exhaustive resolution (adding a family = one entry)", () => {
  test("every DatasetFamily resolves a profile carrying all four behaviors", () => {
    for (const family of ALL_FAMILIES) {
      const p = resolveDatasetFamilyProfile(family)
      expect(p.family).toBe(family)
      expect(typeof p.readCorpus).toBe("function")
      expect(typeof p.gradeEvaluator).toBe("function")
      expect(typeof p.harnessSpec).toBe("function")
      expect(typeof p.onBoxEnvPrefix).toBe("function")
      expect(typeof p.setupBox).toBe("function")
      expect(typeof p.preflight).toBe("function")
    }
  })
  test("registry keys exactly the closed family union (drift guard)", () => {
    expect(Object.keys(DATASET_FAMILY_PROFILES).sort()).toEqual([...ALL_FAMILIES].sort())
    for (const family of ALL_FAMILIES) {
      expect(DATASET_FAMILY_PROFILES[family].family).toBe(family)
    }
  })
})

describe("consumer metadata — verifierLabel / defaultDatasetName / gradesWithProHarness", () => {
  test("ONLY pro grades with the ScaleAI Pro dep-builder — promax must not inherit it", () => {
    expect(resolveDatasetFamilyProfile("pro").gradesWithProHarness).toBe(true)
    expect(resolveDatasetFamilyProfile("pro").verifierLabel).toBe("ScaleAI SWE-bench Pro harness")
    // PMX-01 invariant 1: `promax` is a SIBLING of `pro`, not an alias. Setting
    // this true would hand ProMax the `QUANTA_SWEBENCH_PRO_*` harness knobs.
    expect(resolveDatasetFamilyProfile("promax").gradesWithProHarness).toBe(false)
    for (const family of ["verified", "live"] as const) {
      expect(resolveDatasetFamilyProfile(family).gradesWithProHarness).toBe(false)
      expect(resolveDatasetFamilyProfile(family).verifierLabel).toBeUndefined()
    }
  })
  test("verifier labels are DISTINCT per family (pro and promax can never read as one)", () => {
    const labels = ALL_FAMILIES.map((f) => resolveDatasetFamilyProfile(f).verifierLabel)
    expect(labels.filter((l) => l !== undefined).length).toBe(2) // pro + promax
    expect(resolveDatasetFamilyProfile("promax").verifierLabel).toMatch(/promax/i)
    expect(resolveDatasetFamilyProfile("promax").verifierLabel).not.toBe(
      resolveDatasetFamilyProfile("pro").verifierLabel,
    )
  })
  test("live and promax each name their OWN dataset; verified/pro default downstream", () => {
    expect(resolveDatasetFamilyProfile("live").defaultDatasetName).toBe(
      "SWE-bench-Live/SWE-bench-Live",
    )
    // Naming it is what stops a ProMax run being defaulted onto SWE-bench Verified.
    expect(resolveDatasetFamilyProfile("promax").defaultDatasetName).toBe(
      "swe-bench-promax/SWE-Bench-ProMax",
    )
    for (const family of ["verified", "pro"] as const) {
      expect(resolveDatasetFamilyProfile(family).defaultDatasetName).toBeUndefined()
    }
  })
  test("every family declares a UNIQUE report partition key (packet invariant 1)", () => {
    const keys = ALL_FAMILIES.map((f) => resolveDatasetFamilyProfile(f).reportPartitionKey)
    expect(new Set(keys).size).toBe(ALL_FAMILIES.length)
    expect(resolveDatasetFamilyProfile("pro").reportPartitionKey).not.toBe(
      resolveDatasetFamilyProfile("promax").reportPartitionKey,
    )
  })
})

describe("behavior 1 — parseRow (corpus normalize)", () => {
  const proRow = {
    instance_id: "scale__demo-1",
    repo: "demo/demo",
    base_commit: "0".repeat(40),
    problem_statement: "x",
    fail_to_pass: JSON.stringify(["tests/t.py::test_y"]),
    repo_language: "python",
  }
  const jsonl = JSON.stringify(proRow)
  const instanceFor = (family: DatasetFamily, text: string): Instance => {
    const rows = resolveDatasetFamilyProfile(family).readCorpus(text)
    const task = rows[0]?.task
    if (task === undefined) throw new Error(`${family} produced no runnable task`)
    return task.toInstance("/tmp")
  }

  test("pro normalizes lowercase fail_to_pass ⇒ real testCmd; verified/live are identity no-op", () => {
    // `readCorpus` IS the reader the run path uses — observe the real downstream
    // effect (derived testCmd), not an intermediate record.
    expect(instanceFor("pro", jsonl).testCmd).toContain("test_y")
    for (const family of ["verified", "live"] as const) {
      // identity: the SAME lowercase row degrades to the "true" no-op
      expect(instanceFor(family, jsonl).testCmd).toBe("true")
      // and the row the reader surfaces is the source row, bytes unchanged
      expect(resolveDatasetFamilyProfile(family).readCorpus(jsonl)[0]?.record).toEqual(proRow)
    }
  })
})

describe("behavior 2 — gradeEvaluator (harness selection)", () => {
  const inst: Instance = {
    id: "scale__demo-1",
    repoPath: "/tmp",
    problemStatement: "x",
    testCmd: "true",
    swebench: { instanceId: "scale__demo-1", repo: "demo/demo", baseCommit: "0".repeat(40) },
  }
  // aug-22 HIGH-4: the LOCAL-grade guard travels WITH the profile. It used to be a
  // `family === "live"` compare inside python-swebench.ts — the last family branch
  // outside the registry, and one python-verifier-wiring's hand-rolled copy of the
  // evaluator could (and did) diverge from.
  test("live's evaluator refuses an unconfigured LOCAL grade; verified/pro do not", async () => {
    const saved = process.env.QUANTA_SWEBENCH_NAMESPACE
    delete process.env.QUANTA_SWEBENCH_NAMESPACE
    try {
      const live = await resolveDatasetFamilyProfile("live").gradeEvaluator()(
        inst,
        "diff --git a b",
        { probe: async () => false },
      )
      expect(live.log).toContain("refusing local SWE-bench-Live grade")
      expect(live.gradingCompleted).toBe(false)
      // paired control 1: the OTHER families are not refused by Live's guard
      const verified = await resolveDatasetFamilyProfile("verified").gradeEvaluator()(
        inst,
        "diff --git a b",
        { probe: async () => false },
      )
      expect(verified.log).not.toContain("refusing local SWE-bench-Live grade")
      // paired control 2: an operator who configured the namespace proceeds
      process.env.QUANTA_SWEBENCH_NAMESPACE = "starryzhang"
      const configured = await resolveDatasetFamilyProfile("live").gradeEvaluator()(
        inst,
        "diff --git a b",
        { probe: async () => false },
      )
      expect(configured.log).not.toContain("refusing local SWE-bench-Live grade")
    } finally {
      if (saved === undefined) delete process.env.QUANTA_SWEBENCH_NAMESPACE
      else process.env.QUANTA_SWEBENCH_NAMESPACE = saved
    }
  })

  test("pro routes to the Pro verifier (observable 'not wired' log); verified/live route to official", async () => {
    const proRes = await resolveDatasetFamilyProfile("pro").gradeEvaluator({})(
      inst,
      "diff --git a b",
    )
    expect(proRes.log).toContain("Pro harness not wired")
    for (const family of ["verified", "live"] as const) {
      const res = await resolveDatasetFamilyProfile(family).gradeEvaluator()(
        inst,
        "diff --git a b",
        {
          probe: async () => false,
        },
      )
      expect(res.log).not.toContain("Pro harness not wired")
    }
  })
})

describe("behavior 3a — harnessSpec (pip-spec / prebuilt-image namespace)", () => {
  const baseInput = {
    datasetName: "",
    pipSpecOverride: undefined,
    namespaceOverride: undefined,
  }
  test("verified ⇒ stock swebench build + namespace", () => {
    const r = resolveDatasetFamilyProfile("verified").harnessSpec(baseInput)
    expect(r.pipSpec).toBe("swebench")
    expect(r.namespace).toBe("swebench")
  })
  test("live ⇒ fork pip-spec + starryzhang namespace, even for a NON-live dataset name", () => {
    const r = resolveDatasetFamilyProfile("live").harnessSpec({
      ...baseInput,
      datasetName: "/local/chunk-01.jsonl",
    })
    expect(r.pipSpec).toBe("git+https://github.com/SWE-bench-Live/SWE-bench-Live")
    expect(r.namespace).toBe("starryzhang")
  })
  test("pro ⇒ stock swebench build + namespace (its Scale harness does the docker work)", () => {
    const r = resolveDatasetFamilyProfile("pro").harnessSpec(baseInput)
    expect(r.pipSpec).toBe("swebench")
    expect(r.namespace).toBe("swebench")
  })
  test("a LIVE dataset NAME still forces the fork for a stock family (back-compat)", () => {
    for (const family of ["verified", "pro"] as const) {
      const r = resolveDatasetFamilyProfile(family).harnessSpec({
        ...baseInput,
        datasetName: "SWE-bench-Live/SWE-bench-Live",
      })
      expect(r.pipSpec).toBe("git+https://github.com/SWE-bench-Live/SWE-bench-Live")
      expect(r.namespace).toBe("starryzhang")
    }
  })
  test("promax REFUSES the swebench harness axis entirely (its grader is elsewhere)", () => {
    // Returning the stock spec here would make a ProMax box byte-indistinguishable
    // from a Verified one in the harness axis — the silent Verified route PMX-01's
    // DoD forbids. Even an operator OVERRIDE cannot conjure a swebench build for
    // a family that does not grade with swebench.
    expect(() => resolveDatasetFamilyProfile("promax").harnessSpec({ ...baseInput })).toThrow(
      /promax/i,
    )
    expect(() =>
      resolveDatasetFamilyProfile("promax").harnessSpec({
        ...baseInput,
        pipSpecOverride: "swebench==9.9.9",
        namespaceOverride: "custom-ns",
      }),
    ).toThrow(/promax/i)
  })
  test("overrides win for every swebench-harness family (pip-spec + namespace)", () => {
    for (const family of SWEBENCH_HARNESS_FAMILIES) {
      const r = resolveDatasetFamilyProfile(family).harnessSpec({
        ...baseInput,
        datasetName: "SWE-bench-Live/SWE-bench-Live",
        pipSpecOverride: "swebench==9.9.9",
        namespaceOverride: "custom-ns",
      })
      expect(r.pipSpec).toBe("swebench==9.9.9")
      expect(r.namespace).toBe("custom-ns")
    }
  })
})

describe("behavior 3b — onBoxEnvPrefix (the on-box KEY=val prefix)", () => {
  const datasetPath = "/box/chunk.jsonl"
  test("verified/live ⇒ empty prefix (byte-identical); pro ⇒ the Scale harness wiring", () => {
    for (const family of ["verified", "live"] as const) {
      expect(resolveDatasetFamilyProfile(family).onBoxEnvPrefix({ datasetPath, env: {} })).toBe("")
    }
    const pro = resolveDatasetFamilyProfile("pro").onBoxEnvPrefix({ datasetPath, env: {} })
    expect(pro).toContain("QUANTA_SWEBENCH_PRO_HARNESS_DIR")
    expect(pro).toContain("QUANTA_SWEBENCH_PRO_PYTHON_BIN")
  })
  test("pro on-box prefix forwards operator dockerhub/model overrides only when set", () => {
    const withOverrides = resolveDatasetFamilyProfile("pro").onBoxEnvPrefix({
      datasetPath,
      env: {
        QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME: "acme",
        QUANTA_SWEBENCH_PRO_MODEL_NAME: "mymodel",
      },
    })
    expect(withOverrides).toContain("QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME='acme'")
    expect(withOverrides).toContain("QUANTA_SWEBENCH_PRO_MODEL_NAME='mymodel'")
    const bare = resolveDatasetFamilyProfile("pro").onBoxEnvPrefix({ datasetPath, env: {} })
    expect(bare).not.toContain("QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME")
  })
})

describe("behavior 3c — setupBox (on-box family bootstrap)", () => {
  const recordSsh = () => {
    const cmds: string[] = []
    return {
      cmds,
      ssh: async (cmd: string) => {
        cmds.push(cmd)
        return { code: 0, stdout: "", stderr: "" }
      },
    }
  }
  test("pro clones the Scale harness + builds its venv; verified/live issue NO ssh at all", async () => {
    const pro = recordSsh()
    await resolveDatasetFamilyProfile("pro").setupBox({ ssh: pro.ssh, log: () => {} })
    expect(pro.cmds.some((c) => c.includes("scaleapi/SWE-bench_Pro-os"))).toBe(true)
    expect(pro.cmds.some((c) => c.includes("swebench-pro-venv"))).toBe(true)
    for (const family of ["verified", "live"] as const) {
      const stock = recordSsh()
      await resolveDatasetFamilyProfile(family).setupBox({ ssh: stock.ssh, log: () => {} })
      expect(stock.cmds).toEqual([])
    }
  })
  test("a failing clone FAILS the bootstrap (fail-loud, not a silent skip)", async () => {
    await expect(
      resolveDatasetFamilyProfile("pro").setupBox({
        ssh: async () => ({ code: 1, stdout: "", stderr: "boom" }),
        log: () => {},
      }),
    ).rejects.toThrow(/Pro harness clone failed/)
  })
})

describe("behavior 5 — remoteDefaultPreset", () => {
  test("the multi-language families (pro, promax) declare the LSP-optional default", () => {
    for (const family of ["pro", "promax"] as const) {
      expect(resolveDatasetFamilyProfile(family).remoteDefaultPreset).toBe("agentless-v1")
    }
    for (const family of ["verified", "live"] as const) {
      expect(resolveDatasetFamilyProfile(family).remoteDefaultPreset).toBeUndefined()
    }
  })
})

describe("PMX-01 — the promax profile's own ports (paired against the built-ins)", () => {
  test("readCorpus is a PUBLIC projection: gold never reaches the runner Instance", () => {
    const row = {
      instance_id: "k__p-1",
      repo: "a/b",
      base_commit: "0".repeat(40),
      problem_statement: "x",
      language: "go",
      patch: "GOLD-PATCH",
      test_patch: "GOLD-TEST",
    }
    const text = JSON.stringify(row)
    const promaxRows = resolveDatasetFamilyProfile("promax").readCorpus(text)
    const promaxInstance = promaxRows[0]?.task?.toInstance("/tmp")
    expect(promaxInstance?.goldPatch).toBeUndefined()
    expect(JSON.stringify(promaxInstance)).not.toContain("GOLD-PATCH")
    expect(JSON.stringify(promaxInstance)).not.toContain("GOLD-TEST")
    // …and the SLICE bytes a chunk would carry are gold-free too
    expect(promaxRows[0]?.sourceLine).not.toContain("GOLD-PATCH")
    expect(promaxRows[0]?.sourceLine).toContain("k__p-1")
    // PAIRED: the built-ins carry the SAME row's gold onto the Instance, and
    // their slice bytes are the VERBATIM source line.
    for (const family of ["verified", "live", "pro"] as const) {
      const rows = resolveDatasetFamilyProfile(family).readCorpus(text)
      expect(rows[0]?.task?.toInstance("/tmp").goldPatch).toBe("GOLD-PATCH")
      expect(rows[0]?.sourceLine).toBe(text)
      expect(rows[0]?.record).toEqual(row)
    }
  })

  test("onBoxEnvPrefix carries only the frozen PIN — never the gold-bearing bundle root", () => {
    const prefix = resolveDatasetFamilyProfile("promax").onBoxEnvPrefix({
      datasetPath: "/box/chunk.jsonl",
      env: {
        QUANTA_PROMAX_BUNDLE_ROOT: "/opt/promax/x",
        QUANTA_PROMAX_PYTHON: "/opt/venv/bin/python",
        QUANTA_SWEBENCH_PRO_HARNESS_DIR: "/should/not/leak",
      },
    })
    expect(prefix).toContain("QUANTA_PROMAX_UPSTREAM_COMMIT=")
    // aug-22 G2 — this prefix is the AGENT phase's environment, and the frozen
    // bundle is gold-bearing (`patch` / `test_patch` on every row). Forwarding
    // its ROOT handed the agent process a path to gold, so it is excluded here
    // and delivered out of band to the GRADER phase instead (PMX-04).
    expect(prefix).not.toContain("QUANTA_PROMAX_BUNDLE_ROOT")
    expect(prefix).not.toContain("/opt/promax/x")
    expect(prefix).not.toContain("QUANTA_PROMAX_PYTHON")
    expect(prefix).not.toContain("QUANTA_SWEBENCH_PRO_")
    // …and a MALFORMED ProMax knob still fails closed at this boundary, so the
    // exclusion above is a deliberate omission, not a skipped resolution.
    expect(() =>
      resolveDatasetFamilyProfile("promax").onBoxEnvPrefix({
        datasetPath: "/box/chunk.jsonl",
        env: { QUANTA_PROMAX_BUNDLE_ROOT: "relative/not/absolute" },
      }),
    ).toThrow(/QUANTA_PROMAX_BUNDLE_ROOT/)
    // Unset knobs stay ABSENT — nothing fabricates a default bundle root.
    const bare = resolveDatasetFamilyProfile("promax").onBoxEnvPrefix({
      datasetPath: "/box/chunk.jsonl",
      env: {},
    })
    expect(bare).toContain("QUANTA_PROMAX_UPSTREAM_COMMIT=")
    expect(bare).not.toContain("QUANTA_PROMAX_BUNDLE_ROOT")
    // PAIRED: verified/live still emit nothing at all (byte-identical).
    for (const family of ["verified", "live"] as const) {
      expect(
        resolveDatasetFamilyProfile(family).onBoxEnvPrefix({ datasetPath: "/x", env: {} }),
      ).toBe("")
    }
  })

  test("setupBox refuses (PMX-04 owns live ProMax provisioning) without issuing ssh", async () => {
    const cmds: string[] = []
    await expect(
      resolveDatasetFamilyProfile("promax").setupBox({
        ssh: async (c: string) => {
          cmds.push(c)
          return { code: 0, stdout: "", stderr: "" }
        },
        log: () => {},
      }),
    ).rejects.toThrow(/promax/i)
    expect(cmds).toEqual([])
  })

  test("planNotes surface the FROZEN pin from the typed config; other families add none", () => {
    const cfg = {
      datasetFamily: "promax",
      familySelector: "explicit",
      promax: {
        upstreamCommit: "deadbeef",
        bundleRoot: "/opt/b",
        python: undefined,
        samplePath: "/opt/samples/PMX-7.manifest.json",
      },
    } as const
    const notes = resolveDatasetFamilyProfile("promax").planNotes?.(cfg) ?? []
    expect(notes.join("\n")).toContain("promax-upstream-commit=deadbeef")
    expect(notes.join("\n")).toContain("promax-bundle-root=/opt/b")
    // PMX-06 — a dry-run must show WHICH sample a launch would select.
    expect(notes.join("\n")).toContain("promax-sample=/opt/samples/PMX-7.manifest.json")
    for (const family of ["verified", "live", "pro"] as const) {
      expect(resolveDatasetFamilyProfile(family).planNotes).toBeUndefined()
    }
  })
})

describe("behavior 4 — preflight (fail-closed Pro shape check)", () => {
  // PMX-02: a preflight body no longer opens the dataset — it receives a thunk
  // bound to the family's OWN reader. This mirrors exactly what
  // `assertDatasetGradeableForFamily` builds in production.
  const preflightInput = (path: string, family: DatasetFamily): PreflightInput => ({
    datasetPath: path,
    surface: "t",
    readRows: () => loadFamilyCorpusRowsOrThrow({ datasetPath: path, surface: "t", family }),
  })
  const writeDataset = (rows: Array<Record<string, unknown>>): string => {
    const dir = mkdtempSync(join(tmpdir(), "t4-preflight-"))
    const path = join(dir, "ds.jsonl")
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n"))
    return path
  }
  const goodProRow = {
    instance_id: "scale__ok-1",
    repo: "demo/demo",
    base_commit: "0".repeat(40),
    problem_statement: "x",
    before_repo_set_cmd: "echo build",
    selected_test_files_to_run: "tests/t.py",
    fail_to_pass: JSON.stringify(["tests/t.py::test_y"]),
  }
  const badProRow = { instance_id: "scale__bad-1", repo: "demo/demo", base_commit: "0".repeat(40) }

  test("pro with malformed rows THROWS a preflight refusal", () => {
    const path = writeDataset([badProRow])
    expect(() => resolveDatasetFamilyProfile("pro").preflight(preflightInput(path, "pro"))).toThrow(
      RemoteDatasetPreflightError,
    )
  })
  test("pro with sound rows does NOT throw", () => {
    const path = writeDataset([goodProRow])
    expect(() =>
      resolveDatasetFamilyProfile("pro").preflight(preflightInput(path, "pro")),
    ).not.toThrow()
  })
  test("verified/live preflight is a no-op even on a malformed Pro-shaped dataset", () => {
    const path = writeDataset([badProRow])
    for (const family of ["verified", "live"] as const) {
      expect(() =>
        resolveDatasetFamilyProfile(family).preflight(preflightInput(path, family)),
      ).not.toThrow()
    }
  })
})
