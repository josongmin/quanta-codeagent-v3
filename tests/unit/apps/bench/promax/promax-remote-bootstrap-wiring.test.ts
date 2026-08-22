/**
 * PMX-04 — the resolved PROFILE (not ambient env) drives the remote lane, and
 * the remote dry-run shows the operator what a launch would actually bind.
 *
 * ⚠️ SPEND SAFETY. `createFullRemoteBackend(...).run()` is called with
 * `dryRun: true`, which returns the plan BEFORE `RunInstances`, before any
 * preflight, and before the token-budget lease. No AWS call, no ssh, no Docker
 * exists on that path — the injected `spawn` below is asserted never to be
 * reached, which is itself a load-bearing refusal.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DATASET_FAMILIES, type DatasetFamily } from "@/apps/bench/dataset-family-token"
import {
  buildProMaxBootstrapPlan,
  PROMAX_EVAL_META_RELATIVE_PATH,
  PROMAX_EVALUATOR_RELATIVE_PATH,
} from "@/apps/bench/harness/promax"
import { familyRemoteBootstrap } from "@/apps/bench/profiles/bootstrap"
import {
  PROMAX_ONBOX_CHECKOUT_ROOT,
  PROMAX_ONBOX_ROOT,
  PROMAX_ONBOX_VENV_ROOT,
} from "@/apps/bench/profiles/promax-bootstrap"
import { resolveDatasetFamilyProfile } from "@/apps/bench/profiles/registry"
import { createFullRemoteBackend } from "@/apps/bench/remote/full"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"
import {
  detectGodModules,
  GOD_MODULE_MAX_LINES,
  type SourceFile,
} from "../../../../../tools/god-code/detect"

const PINNED = "77041028bc4e2135644b63b504aa961a68aafbb6"
const FAMILY_ENV = "QUANTA_SWEBENCH_DATASET_FAMILY"

const cfgFor = (family: string | undefined, env: NodeJS.ProcessEnv = {}) =>
  resolveBenchRunConfig({ argvFamily: family, env })

// ---------------------------------------------------------------------------
// The typed bootstrap specification the PROFILE supplies
// ---------------------------------------------------------------------------

describe("PMX-04 — the family PROFILE supplies the typed remote bootstrap", () => {
  test("only promax declares one; the whole family union flows through", () => {
    const declared: DatasetFamily[] = []
    for (const family of DATASET_FAMILIES) {
      const spec = familyRemoteBootstrap(cfgFor(family))
      if (spec !== undefined) declared.push(family)
      // the port is resolved off the PROFILE, never a string compare here
      expect(resolveDatasetFamilyProfile(family).family).toBe(family)
    }
    expect(declared).toEqual(["promax"])
  })

  test("the promax bootstrap carries the exact commit, paths, and workers=1", () => {
    const spec = familyRemoteBootstrap(cfgFor("promax"))
    if (spec === undefined) throw new Error("promax must declare a remote bootstrap")
    expect(spec.family).toBe("promax")
    expect(spec.graderWorkers).toBe(1)
    const flat = spec.commands.map((c) => c.argv.join(" ")).join("\n")
    expect(flat).toContain(PINNED)
    expect(flat).toContain(PROMAX_ONBOX_CHECKOUT_ROOT)
    expect(flat).toContain(PROMAX_ONBOX_VENV_ROOT)
  })

  test("the projected commands are exactly the harness plan (no second builder)", () => {
    const spec = familyRemoteBootstrap(cfgFor("promax"))
    if (spec === undefined) throw new Error("unreachable")
    const owner = buildProMaxBootstrapPlan({
      family: "promax",
      upstreamRepoUrl:
        spec.commands.length > 0 ? "https://github.com/key4127/SWE-Bench-ProMax" : "",
      upstreamGitCommit: PINNED,
      upstreamFiles: [],
      campaignRoot: PROMAX_ONBOX_ROOT,
      checkoutRoot: PROMAX_ONBOX_CHECKOUT_ROOT,
      venvRoot: PROMAX_ONBOX_VENV_ROOT,
      evaluatorPython: `${PROMAX_ONBOX_VENV_ROOT}/bin/python`,
      systemPython: "python3",
      evaluatorWorkers: 1,
      patchGenConcurrency: 1,
      requiredPlatform: { os: "linux", architecture: "amd64" },
      minFreeDiskBytes: 1,
    })
    // Same checkout argv, produced by the harness owner in both cases.
    expect(spec.commands.filter((c) => c.step === "checkout").map((c) => c.argv)).toEqual(
      owner.filter((c) => c.step === "checkout").map((c) => [...c.argv]),
    )
  })
})

// ---------------------------------------------------------------------------
// The remote DRY-RUN plan
// ---------------------------------------------------------------------------

const dryRunPlanFor = async (args: {
  readonly family?: DatasetFamily
  readonly env?: Record<string, string | undefined>
}): Promise<readonly string[]> => {
  const saved = new Map<string, string | undefined>()
  const apply = (k: string, v: string | undefined): void => {
    if (!saved.has(k)) saved.set(k, process.env[k])
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  apply(FAMILY_ENV, args.env?.[FAMILY_ENV])
  try {
    const result = await createFullRemoteBackend({
      repoDir: "/repo",
      authJson: "{}",
      datasetPath: "/does/not/exist.jsonl",
      dryRun: true,
      ...(args.family !== undefined ? { swebenchDatasetFamily: args.family } : {}),
      // If a regression ever reached provisioning from a dry run, this throws
      // instead of touching AWS.
      spawn: () => {
        throw new Error("SPEND GUARD: a dry-run must never spawn a process")
      },
      onLog: () => {},
    }).run()
    return result.plan ?? []
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe("PMX-04 — the remote dry-run plan binds commit, paths, workers=1 and family", () => {
  test("a promax dry-run names the family, the pinned commit, the evaluator paths and workers=1", async () => {
    const plan = (await dryRunPlanFor({ family: "promax" })).join("\n")
    expect(plan).toContain("dataset-family=promax")
    expect(plan).toContain(PINNED)
    expect(plan).toContain(PROMAX_ONBOX_CHECKOUT_ROOT)
    expect(plan).toContain(PROMAX_EVALUATOR_RELATIVE_PATH)
    expect(plan).toContain(PROMAX_EVAL_META_RELATIVE_PATH)
    expect(plan).toContain("promax-evaluator-workers=1")
  })

  test("a verified dry-run carries NONE of it (existing plans stay byte-identical)", async () => {
    const plan = (await dryRunPlanFor({})).join("\n")
    expect(plan).toContain("dataset-family=verified")
    expect(plan).not.toContain(PINNED)
    expect(plan).not.toContain("promax")
  })

  test("family comes from the RESOLVED profile, not live process env", async () => {
    // argv says promax while the ambient env shouts `pro`: the plan must be
    // ProMax's, and must carry no ScaleAI-Pro material.
    const promax = (await dryRunPlanFor({ family: "promax", env: { [FAMILY_ENV]: "pro" } })).join(
      "\n",
    )
    expect(promax).toContain("dataset-family=promax")
    expect(promax).toContain(PINNED)
    expect(promax).not.toContain("ScaleAI")

    // and the converse: argv says pro while ambient env shouts promax.
    const pro = (await dryRunPlanFor({ family: "pro", env: { [FAMILY_ENV]: "promax" } })).join("\n")
    expect(pro).toContain("dataset-family=pro")
    expect(pro).not.toContain(PINNED)
    expect(pro).not.toContain("promax-evaluator-workers")
  })

  test("with NO argv family the env selector is honoured (the fallback is still live)", async () => {
    const plan = (await dryRunPlanFor({ env: { [FAMILY_ENV]: "promax" } })).join("\n")
    expect(plan).toContain("dataset-family=promax")
    expect(plan).toContain(PINNED)
  })
})

// ---------------------------------------------------------------------------
// Env isolation between the two SIBLING families
// ---------------------------------------------------------------------------

describe("PMX-04 — ProMax env is not forwarded for Verified/Live/Pro, and Pro env is not reused for ProMax", () => {
  /** An env in which BOTH families' knobs are set, so a leak is visible. */
  const BOTH: NodeJS.ProcessEnv = {
    QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME: "myfork",
    QUANTA_SWEBENCH_PRO_MODEL_NAME: "my-model",
    QUANTA_PROMAX_BUNDLE_ROOT: "/frozen/promax-bundle",
    QUANTA_PROMAX_PYTHON: "/frozen/venv/bin/python",
  }
  const prefix = (family: DatasetFamily): string =>
    resolveDatasetFamilyProfile(family).onBoxEnvPrefix({
      datasetPath: "~/instances.jsonl",
      env: BOTH,
    })

  test("verified and live forward NOTHING even with both knob sets present", () => {
    expect(prefix("verified")).toBe("")
    expect(prefix("live")).toBe("")
  })

  test("Pro forwards its own knobs and NO ProMax key", () => {
    const out = prefix("pro")
    expect(out).toContain("QUANTA_SWEBENCH_PRO_HARNESS_DIR")
    expect(out).toContain("QUANTA_SWEBENCH_PRO_DOCKERHUB_USERNAME='myfork'")
    expect(out).not.toContain("QUANTA_PROMAX")
    expect(out).not.toContain("/frozen/promax-bundle")
  })

  test("ProMax forwards its identity PIN and NO Pro key — and no grader-only path", () => {
    const out = prefix("promax")
    expect(out).toContain(`QUANTA_PROMAX_UPSTREAM_COMMIT='${PINNED}'`)
    expect(out).not.toContain("QUANTA_SWEBENCH_PRO_")
    // invariant 3: the gold-bearing bundle root and its interpreter are
    // GRADER-phase and must never reach the AGENT-phase environment.
    expect(out).not.toContain("QUANTA_PROMAX_BUNDLE_ROOT")
    expect(out).not.toContain("/frozen/promax-bundle")
    expect(out).not.toContain("QUANTA_PROMAX_PYTHON")
    expect(out).not.toContain("/frozen/venv/bin/python")
  })

  test("the whole family union is covered, and exactly two families emit anything", () => {
    const emitting = DATASET_FAMILIES.filter((f) => prefix(f) !== "")
    expect([...emitting].sort()).toEqual(["pro", "promax"])
  })
})

// ---------------------------------------------------------------------------
// God-module ratchet on the box modules PMX-04 touches
// ---------------------------------------------------------------------------

describe("PMX-04 — box modules stay below the god-module threshold", () => {
  const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
  const WATCHED = [
    "src/apps/bench/run-main.ts",
    "src/apps/bench/remote/box-session.ts",
    "src/apps/bench/remote/box-session/ec2-lifecycle.ts",
    "src/apps/bench/remote/full.ts",
    "src/apps/bench/remote/pool.ts",
    "src/apps/bench/profiles/promax.ts",
  ]

  test("none of the near-limit modules PMX-04 wires through is a god module", () => {
    const files: SourceFile[] = WATCHED.map((rel) => ({
      path: rel,
      text: readFileSync(join(REPO, rel), "utf8"),
    }))
    // The floor makes this non-vacuous: a typo'd path would otherwise read as
    // "nothing exceeds the threshold".
    expect(files.length).toBe(WATCHED.length)
    for (const f of files) expect(f.text.length).toBeGreaterThan(0)
    expect(detectGodModules(files, GOD_MODULE_MAX_LINES).map((m) => m.file)).toEqual([])
  })

  test("PAIRED CONTROL — the detector really does flag an over-threshold module", () => {
    // Without this, "nothing was flagged" could equally mean "the detector is
    // inert". One synthetic file, one real refusal.
    const oversized: SourceFile = {
      path: "src/apps/bench/synthetic-god.ts",
      text: `${"const x = 1\n".repeat(GOD_MODULE_MAX_LINES + 1)}`,
    }
    expect(detectGodModules([oversized], GOD_MODULE_MAX_LINES).map((m) => m.file)).toEqual([
      oversized.path,
    ])
  })

  test("each watched module is genuinely NEAR the threshold (the rail has something to hold)", () => {
    // If these files were tiny, staying under 1000 lines would be no achievement
    // and the rail would be decorative. Three of them sit in the 900s today.
    const lines = WATCHED.map((rel) => readFileSync(join(REPO, rel), "utf8").split("\n").length)
    expect(Math.max(...lines)).toBeGreaterThan(GOD_MODULE_MAX_LINES * 0.8)
    expect(Math.max(...lines)).toBeLessThanOrEqual(GOD_MODULE_MAX_LINES)
  })
})
