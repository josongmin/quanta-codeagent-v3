/**
 * jun-30 T4 STOP RULE (aug-22 audit HIGH-4 repair).
 *
 * The ticket's acceptance bar, verbatim: *"If adding a hypothetical family #4
 * still means editing parse + grade + remote-env + preflight separately, the
 * port is not finished."*
 *
 * This suite is that bar, executed. It registers a SYNTHETIC family #4 through
 * the registry and NOTHING else, then drives the REAL production entry points
 * for every family-conditional layer and asserts each one routed to family #4's
 * profile field:
 *
 *   layer                       production entry point driven here
 *   --------------------------  ------------------------------------------------
 *   0 selector parse            `resolveBenchRunConfig` (the composition root)
 *   1 corpus parse              `parseTasksForFamily`   (readSwebenchTasks' callee)
 *   2 grade harness             `gradeEvaluatorForFamily` (the pythonSwebench seam)
 *   3a remote harness spec      `ensureBoxSwebenchShimCurrent` (warm-box shim heal)
 *   3b remote namespace/prefix  `buildBenchCommand` (the literal box command)
 *   3c on-box family bootstrap  `setupBoxForFamily` (bootstrapBox's callee)
 *   4 preflight                 `assertDatasetGradeableForFamily` (full/pool callee)
 *   5 remote default preset     `resolveRemoteBenchExecutionPreset`
 *
 * Every one of those was a raw `=== "pro"` / `=== "live"` string compare in a
 * consumer module before this repair, so a family #4 could not exist without
 * editing each of them. If any consumer regresses to a string compare, its
 * assertion here goes red (proven by in-tree injection, see the repair receipt)
 * — this is a BEHAVIORAL rail, not a source scan. The source scan lives in
 * `tests/unit/dataset-family-profile-ssot.test.ts` and is the secondary rail.
 *
 * Non-vacuity: every family-4 assertion is PAIRED with the same production call
 * on a built-in family, so an assertion that passes because the production path
 * ignores the profile entirely (returning a constant) fails the pair.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gradeEvaluatorForFamily } from "../dataset-family"
import type { DatasetFamily } from "../dataset-family-token"
import { resolveRemoteBenchExecutionPreset } from "../preset"
import { buildBenchCommand } from "../remote/box-session"
import { assertDatasetGradeableForFamily } from "../remote/box-session/dataset-preflight"
import {
  buildSwebenchShim,
  ensureBoxSwebenchShimCurrent,
  setupBoxForFamily,
} from "../remote/box-session/ec2-lifecycle"
import { DEFAULT_CHUNK_PATHS, type GradeChunkParams } from "../remote/box-session/types"
import { resolveBenchRunConfig } from "../run-config"
import type { Instance } from "../types"
import { readFamilyCorpusText } from "./corpus-read"
import { jsonlFamilyCorpusReader } from "./jsonl-corpus"
import { registerDatasetFamilyProfile } from "./registry"
import type { DatasetFamilyProfile } from "./types"

/** The synthetic family. Cast because the union is a COMPILE-time closed set —
 *  a real family #4 adds one token to `DATASET_FAMILIES` and one profile object;
 *  this test proves that those two edits are ALL that is needed, i.e. that no
 *  consumer module has to change. */
const F4 = "family4" as DatasetFamily

const F4_PIP_SPEC = "family4-harness==0.0.1"
const F4_NAMESPACE = "family4-images"
const F4_ONBOX_PREFIX = "QUANTA_FAMILY4_ONBOX=1 "
const F4_SETUP_CMD = "echo family4-box-setup"
const F4_PRESET = "family4-preset"

const family4Profile: DatasetFamilyProfile = {
  family: F4,
  // PMX-01: a family declares its OWN report partition; the registry refuses a
  // duplicate, so family #4 can never be summed into another family's score.
  reportPartitionKey: "family4",
  verifierLabel: "family4 verifier",
  defaultDatasetName: "acme/Family4",
  remoteDefaultPreset: F4_PRESET,
  gradesWithProHarness: false,
  // layer 1 — its own corpus READER. family4 ships `f4_tests`, not FAIL_TO_PASS,
  // so it composes the shared JSONL reader with its own row normalizer.
  readCorpus: jsonlFamilyCorpusReader((raw: Record<string, unknown>) => ({
    ...raw,
    ...(raw.f4_tests != null ? { FAIL_TO_PASS: raw.f4_tests } : {}),
  })),
  // layer 2 — its own grade harness.
  gradeEvaluator: () => async () => ({
    resolved: true,
    gradingCompleted: true,
    log: "family4 harness graded this",
  }),
  // layer 3a/3b — its own pip-spec + image namespace (overrides still win).
  harnessSpec: (input) => ({
    pipSpec: input.pipSpecOverride ?? F4_PIP_SPEC,
    namespace: input.namespaceOverride ?? F4_NAMESPACE,
  }),
  onBoxEnvPrefix: () => F4_ONBOX_PREFIX,
  // layer 4 — its own fail-closed dataset shape check.
  preflight: (input) => {
    if (input.datasetPath.includes("bad")) {
      throw new Error("family4 preflight refused this dataset")
    }
  },
  // layer 3c — its own on-box bootstrap.
  setupBox: async (input) => {
    input.log("[family4] setting up")
    await input.ssh(F4_SETUP_CMD)
  },
}

/** Register family #4 for the whole file, then remove it. `registerDatasetFamilyProfile`
 *  is the registry's ONE extension point — no other module is touched. */
const unregisterF4 = registerDatasetFamilyProfile(family4Profile)

const F4_ROW = {
  instance_id: "family4__demo-1",
  repo: "demo/demo",
  base_commit: "0".repeat(40),
  problem_statement: "x",
  f4_tests: JSON.stringify(["tests/t.py::test_family_four"]),
}
const F4_JSONL = JSON.stringify(F4_ROW)

const INSTANCE: Instance = {
  id: "family4__demo-1",
  repoPath: "/tmp",
  problemStatement: "x",
  testCmd: "true",
  swebench: { instanceId: "family4__demo-1", repo: "demo/demo", baseCommit: "0".repeat(40) },
}

const chunkParams = (family: DatasetFamily): GradeChunkParams => ({
  datasetPath: "/local/chunk.jsonl",
  authJson: "{}",
  preset: "p",
  model: "m",
  concurrency: 1,
  artifactSuffix: "s",
  recordTrajectory: false,
  forwardedBenchEnv: "",
  datasetFamily: family,
})

/** Minimal fake BoxSession capturing issued ssh commands + a canned on-box shim. */
const fakeSession = (onBoxShim: string) => {
  const cmds: string[] = []
  const session = {
    log: () => {},
    ssh: async (cmd: string) => {
      cmds.push(cmd)
      if (cmd.startsWith("cat ~/swebench-python")) return { code: 0, stdout: onBoxShim, stderr: "" }
      return { code: 0, stdout: "1.2.3", stderr: "" }
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal BoxSession stub
  } as any
  return { session, cmds }
}

const writeDataset = (name: string, rows: Array<Record<string, unknown>>): string => {
  const dir = mkdtempSync(join(tmpdir(), "t4-stoprule-"))
  const path = join(dir, name)
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n"))
  return path
}

describe("T4 stop rule — a synthetic family #4 routes through EVERY layer with no consumer edit", () => {
  test("layer 0 (selector parse) — the composition root admits family4 from argv AND env", () => {
    expect(resolveBenchRunConfig({ argvFamily: "family4", env: {} }).datasetFamily).toBe(F4)
    // the ONE normalization owner applies: trim + case-fold, for the new family too
    expect(resolveBenchRunConfig({ argvFamily: "  Family4 ", env: {} }).datasetFamily).toBe(F4)
    expect(
      resolveBenchRunConfig({
        argvFamily: undefined,
        env: { QUANTA_SWEBENCH_DATASET_FAMILY: "FAMILY4" },
      }).datasetFamily,
    ).toBe(F4)
    // paired control: a still-unknown token is STILL refused (registration did
    // not open the gate to anything else)
    expect(() => resolveBenchRunConfig({ argvFamily: "family5", env: {} })).toThrow(
      /unknown dataset family/i,
    )
  })

  test("layer 1 (corpus parse) — the ONE reader resolves family4's readCorpus", () => {
    const testCmdFor = (family: DatasetFamily): string => {
      const task = readFamilyCorpusText(F4_JSONL, family)[0]?.task
      if (task === undefined) throw new Error(`${family} produced no runnable task`)
      return task.toInstance("/tmp").testCmd
    }
    expect(testCmdFor(F4)).toContain("test_family_four")
    // paired control: the SAME row through a built-in JSONL family is the no-op
    // parse (their readers accept it; only family4 knows `f4_tests`).
    for (const family of ["verified", "live", "pro"] as const) {
      expect(testCmdFor(family)).toBe("true")
    }
    // …and `promax` produces NO runnable task at all for this row, because a
    // ProMax public task REQUIRES the `language` label and F4_ROW has none. That
    // is the correct fail-closed answer for a mislabeled corpus, not a silent
    // no-op task — asserted rather than papered over.
    expect(readFamilyCorpusText(F4_JSONL, "promax")[0]?.task).toBeUndefined()
    // and it really is the profile's OWN reader that produced it
    expect(family4Profile.readCorpus(F4_JSONL)[0]?.task?.toInstance("/tmp").testCmd).toContain(
      "test_family_four",
    )
  })

  test("layer 2 (grade harness) — gradeEvaluatorForFamily routes to family4's verifier", async () => {
    const res = await gradeEvaluatorForFamily(F4)(INSTANCE, "diff --git a b")
    expect(res.log).toBe("family4 harness graded this")
    // paired control: the built-in families do NOT reach family4's harness
    const pro = await gradeEvaluatorForFamily("pro", {})(INSTANCE, "diff --git a b")
    expect(pro.log).not.toContain("family4")
  })

  test("layer 3a (remote harness spec) — the warm-box shim heals to family4's pip-spec", async () => {
    const { session, cmds } = fakeSession(buildSwebenchShim("swebench"))
    await ensureBoxSwebenchShimCurrent(session, F4)
    const write = cmds.find((c) => c.startsWith("cat > ~/swebench-python"))
    expect(write).toBeDefined()
    // the shim BODY is what proves the pip-spec came from family4's profile
    expect(buildSwebenchShim(F4_PIP_SPEC)).toContain(`--from '${F4_PIP_SPEC}' `)
    // paired control: a box already on family4's shim is left alone
    const current = fakeSession(buildSwebenchShim(F4_PIP_SPEC))
    await ensureBoxSwebenchShimCurrent(current.session, F4)
    expect(current.cmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(false)
    // …and a verified box is STILL left alone (family4 did not become the default)
    const verified = fakeSession(buildSwebenchShim("swebench"))
    await ensureBoxSwebenchShimCurrent(verified.session, "verified")
    expect(verified.cmds.some((c) => c.startsWith("cat > ~/swebench-python"))).toBe(false)
  })

  test("layer 3b (namespace + on-box prefix) — the real box command carries family4's values", () => {
    const cmd = buildBenchCommand(chunkParams(F4), DEFAULT_CHUNK_PATHS)
    expect(cmd).toContain(`QUANTA_SWEBENCH_NAMESPACE='${F4_NAMESPACE}'`)
    expect(cmd).toContain(F4_ONBOX_PREFIX)
    // paired control: the built-in families keep their own values
    const verified = buildBenchCommand(chunkParams("verified"), DEFAULT_CHUNK_PATHS)
    expect(verified).toContain("QUANTA_SWEBENCH_NAMESPACE='swebench'")
    expect(verified).not.toContain(F4_ONBOX_PREFIX)
    const live = buildBenchCommand(chunkParams("live"), DEFAULT_CHUNK_PATHS)
    expect(live).toContain("QUANTA_SWEBENCH_NAMESPACE='starryzhang'")
    const pro = buildBenchCommand(chunkParams("pro"), DEFAULT_CHUNK_PATHS)
    expect(pro).toContain("QUANTA_SWEBENCH_PRO_HARNESS_DIR")
  })

  test("layer 3c (on-box bootstrap) — bootstrapBox's callee runs family4's setupBox", async () => {
    const seen: string[] = []
    await setupBoxForFamily({
      family: F4,
      ssh: async (cmd: string) => {
        seen.push(cmd)
        return { code: 0, stdout: "", stderr: "" }
      },
      log: () => {},
    })
    expect(seen).toContain(F4_SETUP_CMD)
    // paired control: verified/live bootstrap issues NO family setup command,
    // pro still clones the Scale harness
    const verifiedSeen: string[] = []
    await setupBoxForFamily({
      family: "verified",
      ssh: async (cmd: string) => {
        verifiedSeen.push(cmd)
        return { code: 0, stdout: "", stderr: "" }
      },
      log: () => {},
    })
    expect(verifiedSeen).toEqual([])
    const proSeen: string[] = []
    await setupBoxForFamily({
      family: "pro",
      ssh: async (cmd: string) => {
        proSeen.push(cmd)
        return { code: 0, stdout: "", stderr: "" }
      },
      log: () => {},
    })
    expect(proSeen.some((c) => c.includes("swebench-pro"))).toBe(true)
  })

  test("layer 4 (preflight) — the full-remote/pool callee runs family4's shape check", () => {
    const bad = writeDataset("bad-family4.jsonl", [{ instance_id: "a", repo: "r" }])
    expect(() =>
      assertDatasetGradeableForFamily({ datasetPath: bad, surface: "t", family: F4 }),
    ).toThrow(/family4 preflight refused/)
    const ok = writeDataset("ok-family4.jsonl", [{ instance_id: "a", repo: "r" }])
    expect(() =>
      assertDatasetGradeableForFamily({ datasetPath: ok, surface: "t", family: F4 }),
    ).not.toThrow()
    // paired control: family4's rule does NOT apply to the built-ins, and pro's
    // own rule still fires on a pro-malformed dataset
    for (const family of ["verified", "live"] as const) {
      expect(() =>
        assertDatasetGradeableForFamily({ datasetPath: bad, surface: "t", family }),
      ).not.toThrow()
    }
    expect(() =>
      assertDatasetGradeableForFamily({ datasetPath: ok, surface: "t", family: "pro" }),
    ).toThrow(/Scale-harness-required/)
  })

  test("layer 5 (remote default preset) — family4 gets its own default, explicit still wins", () => {
    expect(resolveRemoteBenchExecutionPreset({ family: F4, envVars: {} })).toBe(F4_PRESET)
    expect(
      resolveRemoteBenchExecutionPreset({ family: F4, envVars: {}, argvPreset: "operator-choice" }),
    ).toBe("operator-choice")
    // paired control: pro keeps agentless-v1, verified keeps the base profile
    expect(resolveRemoteBenchExecutionPreset({ family: "pro", envVars: {} })).toBe("agentless-v1")
    expect(resolveRemoteBenchExecutionPreset({ family: "verified", envVars: {} })).not.toBe(
      F4_PRESET,
    )
  })

  test("registration is the ONLY seam — re-registering an existing family is refused", () => {
    expect(() => registerDatasetFamilyProfile(family4Profile)).toThrow(/already registered/i)
  })
})

describe("T4 dependency direction — the profile layer does not import its consumers", () => {
  // aug-22 HIGH-4: `profiles/registry.ts` imported `buildProEnvPrefix`,
  // `assertProDatasetShape` and `resolveSwebenchPipSpec`/`Namespace` back OUT of
  // `remote/box-session*` — from the very modules that were supposed to consume
  // it. Those bodies now live in profile-owned leaves. This scans the WHOLE
  // profile layer (not just registry.ts), so moving the offending import one file
  // sideways does not evade it.
  const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs")
  const layerFiles = readdirSync(import.meta.dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .sort()

  /** Modules that OWN family behavior and therefore must never be imported by the
   *  profile layer. */
  const CONSUMER_MODULES = ["box-session", "ec2-lifecycle", "dataset-preflight", "/preset"]
  /** Pure utilities the profile layer MAY import from under `remote/`, each with
   *  its reason. They contain no family logic and no import back into profiles/. */
  const SANCTIONED_LEAVES: Record<string, string> = {
    "../remote/box-session/shell": "shq() shell-quoting util — no family logic",
    "../remote/box-session/dataset-rows":
      "JSONL row reader + preflight error class — no family logic",
  }

  const importsOf = (file: string): string[] =>
    [...readFileSync(join(import.meta.dir, file), "utf8").matchAll(/from\s+"([^"]+)"/g)].map(
      (m) => m[1] as string,
    )

  test("known-item floor — the scan sees the real layer and its real imports", () => {
    expect(layerFiles).toContain("registry.ts")
    expect(layerFiles).toContain("types.ts")
    expect(layerFiles.length).toBeGreaterThanOrEqual(6)
    // the scanner actually extracts specifiers (a dead regex would pass vacuously)
    expect(importsOf("registry.ts")).toContain("./types")
    expect(importsOf("pro-env-prefix.ts")).toContain("../remote/box-session/shell")
  })

  test("no profile-layer module imports a family-owning consumer", () => {
    const offenders: string[] = []
    for (const file of layerFiles) {
      for (const spec of importsOf(file)) {
        if (spec in SANCTIONED_LEAVES) continue
        if (CONSUMER_MODULES.some((m) => spec.includes(m))) offenders.push(`${file} → ${spec}`)
      }
    }
    expect(
      offenders,
      "the profile layer imports family logic FROM its consumers:\n  " +
        offenders.join("\n  ") +
        "\nThe family-agnostic body belongs in a leaf the consumer imports, not the reverse.",
    ).toEqual([])
  })

  test("the detector is live — it fires on the exact imports this repair removed", () => {
    const regressed = [
      '../remote/box-session"',
      "../remote/box-session/ec2-lifecycle",
      "../remote/box-session/dataset-preflight",
    ]
    for (const spec of regressed) {
      expect(
        CONSUMER_MODULES.some((m) => spec.includes(m)),
        `detector missed ${spec}`,
      ).toBe(true)
      expect(spec in SANCTIONED_LEAVES).toBe(false)
    }
    // …and does NOT fire on the sanctioned leaves
    for (const spec of Object.keys(SANCTIONED_LEAVES)) {
      expect(spec in SANCTIONED_LEAVES).toBe(true)
    }
  })
})

// House-keeping: the registry is process-global by design, so drop the synthetic
// family as soon as this FILE is done rather than at process exit — a sibling
// suite sharing the process must never observe family4.
afterAll(() => {
  unregisterF4()
})
