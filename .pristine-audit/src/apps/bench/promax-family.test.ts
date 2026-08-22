/**
 * HELLGATE — PMX-01: `promax` as a first-class SWE dataset family.
 *
 * WHAT THIS FILE IS. The ticket's acceptance bar, executed against REAL
 * production entry points:
 *   - the composition roots (`resolveBenchmarkRunConfig` / the real `cli.ts`
 *     child process), never a hand-rolled parser;
 *   - the ONE T4 registry (`resolveDatasetFamilyProfile`), never a
 *     `family === "promax"` compare;
 *   - the real corpus parse (`parseTasksForFamily` → `toInstance`), the real
 *     grade seam (`gradeEvaluatorForFamily`, `buildPythonSwebench`), the real
 *     preflight callee (`assertDatasetGradeableForFamily`) and the real box
 *     bootstrap callee (`setupBoxForFamily`).
 *
 * NON-VACUITY. Every ProMax assertion is PAIRED with the same production call on
 * `verified` / `live` / `pro`, so an implementation that ignored the family and
 * returned a constant fails the pair. The full four-family union flows through
 * the selector, the wire encoder and the registry.
 *
 * ⚠️ SPEND SAFETY. Every child process here is `--dry-run` or an argument
 * refusal. `box up` is NEVER spawned (a previous session's hellgate provisioned
 * ten live EC2 boxes that way); `runCli` hard-refuses an `up` action.
 *
 * ⚠️ LIVE-DATA. Nothing here reaches `writeReport`/`mirrorReportToSsot`: the
 * dry-run roots return before any artifact write, and the in-process cases call
 * pure resolvers/ports. `~/.quanta/bench/results` is asserted untouched by the
 * parent's before/after count.
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  decodeBenchRunConfig,
  isBenchmarkSuite,
  resolveBenchmarkRunConfig,
} from "./benchmark-suite"
import { gradeEvaluatorForFamily } from "./dataset-family"
import { DATASET_FAMILIES, type DatasetFamily } from "./dataset-family-token"
import { resolveRemoteBenchExecutionPreset } from "./preset"
import { loadFamilyCorpusRowsOrThrow, readFamilyCorpusText } from "./profiles/corpus-read"
import type { FamilyCorpusRow } from "./profiles/corpus-row"
import { assertProMaxDatasetShape } from "./profiles/promax-dataset-shape"
import {
  DATASET_FAMILY_PROFILES,
  registerDatasetFamilyProfile,
  resolveDatasetFamilyProfile,
} from "./profiles/registry"
import type { DatasetFamilyProfile } from "./profiles/types"
import { PROMAX_V1_SNAPSHOT } from "./promax/provenance"
import { PROMAX_BUNDLE_ROOT_ENV, PROMAX_PYTHON_ENV, resolveProMaxSettings } from "./promax/settings"
import { assertDatasetGradeableForFamily } from "./remote/box-session/dataset-preflight"
import { setupBoxForFamily } from "./remote/box-session/ec2-lifecycle"
import { buildSubprocessFamilyEnv, resolveBenchRunConfig } from "./run-config"
import type { Instance } from "./types"

const FAMILY_KEY = "QUANTA_SWEBENCH_DATASET_FAMILY"
const CLI = join(import.meta.dir, "cli.ts")
const SPAWN_BUDGET_MS = 240_000

/** The four-family union AFTER PMX-01. Spelled out (not derived from
 *  `DATASET_FAMILIES`) so a registry that silently LOST a family fails here
 *  rather than shrinking the test with itself. */
const ALL_FAMILIES = ["verified", "live", "pro", "promax"] as const
const BUILTINS_BEFORE_PROMAX = ["verified", "live", "pro"] as const

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A REAL-SHAPED ProMax row (field spec from PMX-00's `corpus-identity.ts`,
 *  verified against all 170 upstream rows). `patch` / `test_patch` are the
 *  grader-only, gold-bearing fields invariant 3 forbids on agent surfaces. */
const promaxRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  instance_id: "key4127__promax-1",
  repo: "acme/widget",
  base_commit: "a".repeat(40),
  environment_setup_commit: "b".repeat(40),
  language: "rust",
  image_name: "promax/acme-widget:pinned",
  working_dir: "/testbed",
  problem_statement: "the widget does not widget",
  hints_text: "",
  patch: "diff --git a/src/lib.rs b/src/lib.rs\n+GOLD PATCH BODY\n",
  test_patch: "diff --git a/tests/t.rs b/tests/t.rs\n+GOLD TEST BODY\n",
  created_at: 1_700_000_000,
  ...over,
})

const writeJsonl = (name: string, rows: Array<Record<string, unknown>>): string => {
  const dir = mkdtempSync(join(tmpdir(), "pmx01-"))
  const path = join(dir, name)
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n"))
  return path
}

const INSTANCE: Instance = {
  id: "key4127__promax-1",
  repoPath: "/tmp",
  problemStatement: "x",
  testCmd: "true",
  swebench: { instanceId: "key4127__promax-1", repo: "acme/widget", baseCommit: "a".repeat(40) },
}

interface CliResult {
  readonly code: number
  readonly out: string
}

/** Spawn the REAL CLI. Refuses to spawn anything that could provision a box. */
const runCli = (args: readonly string[], env: Record<string, string> = {}): CliResult => {
  if (args.includes("up")) {
    throw new Error("SPEND GUARD: this suite must never spawn a box-provisioning action")
  }
  const childEnv: Record<string, string | undefined> = { ...process.env, ...env }
  if (!(FAMILY_KEY in env)) delete childEnv[FAMILY_KEY]
  if (!(PROMAX_BUNDLE_ROOT_ENV in env)) delete childEnv[PROMAX_BUNDLE_ROOT_ENV]
  if (!(PROMAX_PYTHON_ENV in env)) delete childEnv[PROMAX_PYTHON_ENV]
  const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: childEnv as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: proc.exitCode ?? -1, out: `${proc.stdout.toString()}${proc.stderr.toString()}` }
}

const cliFixtures = (() => {
  const dataset = writeJsonl("ds.jsonl", [
    {
      instance_id: "demo__pkg-1",
      repo: "demo/pkg",
      base_commit: "0".repeat(40),
      problem_statement: "fix it",
      patch: "",
      test_patch: "",
      FAIL_TO_PASS: "[]",
      PASS_TO_PASS: "[]",
    },
  ])
  return { dataset }
})()

const planLine = (out: string, key: string): string | undefined =>
  new RegExp(`^.*\\b${key}: *(.*)$`, "m").exec(out)?.[1]?.trim()

const planToken = (out: string, key: string): string | undefined =>
  new RegExp(`\\b${key}=([^\\s,)]+)`).exec(out)?.[1]

const runPlan = (family: string | undefined, env: Record<string, string> = {}): CliResult =>
  runCli(
    [
      "run",
      "--swebench",
      cliFixtures.dataset,
      "--dry-run",
      ...(family !== undefined ? ["--dataset-family", family] : []),
    ],
    env,
  )

const fullRemotePlan = (family: string | undefined, env: Record<string, string> = {}): CliResult =>
  runCli(
    [
      "grade",
      "--mode",
      "full",
      "--allow-remote-secrets",
      "--dataset",
      cliFixtures.dataset,
      "--dry-run",
      ...(family !== undefined ? ["--dataset-family", family] : []),
    ],
    env,
  )

const poolPlan = (family: string | undefined, env: Record<string, string> = {}): CliResult =>
  runCli(
    [
      "pool",
      "--allow-remote-secrets",
      "--datasets",
      cliFixtures.dataset,
      "--dry-run",
      ...(family !== undefined ? ["--dataset-family", family] : []),
    ],
    env,
  )

// ─────────────────────────────────────────────────────────────────────────────
// 1 — the canonical family type + fail-closed selector routing
// ─────────────────────────────────────────────────────────────────────────────
describe("PMX-01 — `promax` is a member of the ONE canonical family union", () => {
  test("the token registry carries exactly the four families (drift guard, both directions)", () => {
    expect([...DATASET_FAMILIES].sort()).toEqual([...ALL_FAMILIES].sort())
    // ProMax is a FAMILY, never a SUITE (README decision).
    expect(isBenchmarkSuite("promax")).toBe(false)
  })

  test("resolved config is EXACTLY benchmarkSuite:'swe-bench' + datasetFamily:'promax'", () => {
    const cfg = resolveBenchmarkRunConfig({ subcommand: "run", argvFamily: "promax", env: {} })
    expect(cfg.benchmarkSuite).toBe("swe-bench")
    if (cfg.benchmarkSuite !== "swe-bench") throw new Error("unreachable")
    expect(cfg.datasetFamily).toBe("promax")
    expect(cfg.swe.datasetFamily).toBe("promax")
    expect(cfg.swe.familySelector).toBe("explicit")
  })

  test("CLI and env BOTH resolve promax; CLI wins per the declared precedence", () => {
    expect(resolveBenchRunConfig({ argvFamily: "promax", env: {} }).datasetFamily).toBe("promax")
    expect(
      resolveBenchRunConfig({ argvFamily: undefined, env: { [FAMILY_KEY]: "promax" } })
        .datasetFamily,
    ).toBe("promax")
    // argv beats env, in BOTH directions (a constant-returning root fails this)
    expect(
      resolveBenchRunConfig({ argvFamily: "promax", env: { [FAMILY_KEY]: "pro" } }).datasetFamily,
    ).toBe("promax")
    expect(
      resolveBenchRunConfig({ argvFamily: "pro", env: { [FAMILY_KEY]: "promax" } }).datasetFamily,
    ).toBe("pro")
    // the ONE normalization owner applies to the new token too
    for (const padded of ["  PROMAX  ", "\tPromax\n", " promax "]) {
      expect(resolveBenchRunConfig({ argvFamily: padded, env: {} }).datasetFamily).toBe("promax")
    }
  })

  test("explicit near-misses FAIL closed — `promaxx`, `pro max`, whitespace-only, env garbage", () => {
    for (const bad of ["promaxx", "promaxX", "pro max", "pro-max", "promx"]) {
      expect(() => resolveBenchRunConfig({ argvFamily: bad, env: {} })).toThrow(
        /unknown dataset family/i,
      )
      expect(() =>
        resolveBenchRunConfig({ argvFamily: undefined, env: { [FAMILY_KEY]: bad } }),
      ).toThrow(/unknown dataset family/i)
    }
    for (const blank of ["", "   ", "\t\n"]) {
      expect(() => resolveBenchRunConfig({ argvFamily: blank, env: {} })).toThrow(/is blank/i)
    }
    // …and the refusal NAMES promax as an option, so an operator can self-correct
    let message = ""
    try {
      resolveBenchRunConfig({ argvFamily: "promaxx", env: {} })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain("promaxx")
    for (const fam of ALL_FAMILIES) expect(message).toContain(fam)
  })

  test("PAIRED — no selector is STILL Verified, and its provenance is still `absent`", () => {
    const absent = resolveBenchRunConfig({ argvFamily: undefined, env: {} })
    expect(absent.datasetFamily).toBe("verified")
    expect(absent.familySelector).toBe("absent")
  })

  test("the report/wire DECODER round-trips promax and still refuses it as a SUITE", () => {
    const decoded = decodeBenchRunConfig({ benchmarkSuite: "swe-bench", datasetFamily: "promax" })
    expect(decoded.benchmarkSuite).toBe("swe-bench")
    if (decoded.benchmarkSuite !== "swe-bench") throw new Error("unreachable")
    expect(decoded.datasetFamily).toBe("promax")
    expect(() => decodeBenchRunConfig({ benchmarkSuite: "promax", datasetFamily: "pro" })).toThrow(
      /promax|suite/i,
    )
    // a terminal identity may never carry the family axis
    expect(() =>
      decodeBenchRunConfig({
        benchmarkSuite: "terminal-bench",
        benchmarkVersion: "2.1",
        datasetFamily: "promax",
      }),
    ).toThrow(/datasetFamily/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 — ONE profile registration in the T4 registry
// ─────────────────────────────────────────────────────────────────────────────
describe("PMX-01 — exactly ONE promax profile in the T4 registry", () => {
  test("the registry keys the closed union and promax resolves every port", () => {
    expect(Object.keys(DATASET_FAMILY_PROFILES).sort()).toEqual([...ALL_FAMILIES].sort())
    const p = resolveDatasetFamilyProfile("promax")
    expect(p.family).toBe("promax")
    for (const port of [
      "readCorpus",
      "gradeEvaluator",
      "harnessSpec",
      "onBoxEnvPrefix",
      "setupBox",
      "preflight",
    ] as const) {
      expect(typeof p[port], `promax profile is missing the ${port} port`).toBe("function")
    }
  })

  test("INVARIANT 1 — pro and promax never share a report partition key", () => {
    const keys = ALL_FAMILIES.map((f) => resolveDatasetFamilyProfile(f).reportPartitionKey)
    // every family partitions under its own key, and no two collide
    expect(new Set(keys).size).toBe(ALL_FAMILIES.length)
    expect(resolveDatasetFamilyProfile("pro").reportPartitionKey).not.toBe(
      resolveDatasetFamilyProfile("promax").reportPartitionKey,
    )
    expect(resolveDatasetFamilyProfile("promax").reportPartitionKey).toBe("promax")
  })

  test("the registry REFUSES a new family that claims an existing partition key", () => {
    const collider: DatasetFamilyProfile = {
      ...resolveDatasetFamilyProfile("verified"),
      family: "partition-collider" as DatasetFamily,
      reportPartitionKey: "promax",
    }
    expect(() => registerDatasetFamilyProfile(collider)).toThrow(/partition/i)
    // PAIRED CONTROL: the SAME profile with its own key registers fine, and the
    // guard is not a blanket refusal.
    const ok: DatasetFamilyProfile = { ...collider, reportPartitionKey: "partition-collider" }
    const drop = registerDatasetFamilyProfile(ok)
    try {
      expect(resolveDatasetFamilyProfile("partition-collider" as DatasetFamily).family).toBe(
        "partition-collider" as DatasetFamily,
      )
    } finally {
      drop()
    }
  })

  test("promax declares the LSP-optional remote default preset (7 languages), explicit still wins", () => {
    expect(resolveRemoteBenchExecutionPreset({ family: "promax", envVars: {} })).toBe(
      "agentless-v1",
    )
    expect(
      resolveRemoteBenchExecutionPreset({
        family: "promax",
        envVars: {},
        argvPreset: "operator-choice",
      }),
    ).toBe("operator-choice")
    // PAIRED: verified keeps the base profile
    expect(resolveRemoteBenchExecutionPreset({ family: "verified", envVars: {} })).not.toBe(
      "agentless-v1",
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3 — grader isolation (invariant 1) and no Verified/Pro fallback
// ─────────────────────────────────────────────────────────────────────────────
describe("PMX-01 — promax never reaches the Verified or Scale-Pro grader", () => {
  test("the promax grade port REFUSES rather than grading with another family's harness", async () => {
    await expect(gradeEvaluatorForFamily("promax")(INSTANCE, "diff --git a b")).rejects.toThrow(
      /promax/i,
    )
    // PAIRED CONTROL: pro still reaches the SCALE harness (its own observable),
    // and verified/live still reach the official one — promax did not change them.
    const pro = await gradeEvaluatorForFamily("pro", {})(INSTANCE, "diff --git a b")
    expect(pro.log).toContain("Pro harness not wired")
    for (const family of ["verified", "live"] as const) {
      const res = await gradeEvaluatorForFamily(family)(INSTANCE, "diff --git a b", {
        probe: async () => false,
      })
      expect(res.log).not.toContain("Pro harness not wired")
    }
  })

  test("promax does NOT take the Scale-Pro dep-builder branch", () => {
    expect(resolveDatasetFamilyProfile("promax").gradesWithProHarness).toBe(false)
    // PAIRED: pro does, verified/live do not.
    expect(resolveDatasetFamilyProfile("pro").gradesWithProHarness).toBe(true)
    for (const family of ["verified", "live"] as const) {
      expect(resolveDatasetFamilyProfile(family).gradesWithProHarness).toBe(false)
    }
  })

  test("promax names its OWN dataset, so nothing defaults it to SWE-bench Verified", () => {
    expect(resolveDatasetFamilyProfile("promax").defaultDatasetName).toContain("ProMax")
    expect(resolveDatasetFamilyProfile("promax").verifierLabel).toMatch(/promax/i)
    // PAIRED: the ScaleAI label still belongs to pro alone
    expect(resolveDatasetFamilyProfile("pro").verifierLabel).toBe("ScaleAI SWE-bench Pro harness")
    expect(resolveDatasetFamilyProfile("promax").verifierLabel).not.toBe(
      resolveDatasetFamilyProfile("pro").verifierLabel,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4 — the PUBLIC PROJECTION (invariant 3: no gold on an agent surface)
// ─────────────────────────────────────────────────────────────────────────────
describe("PMX-01 — the promax corpus parse is a PUBLIC projection", () => {
  const jsonl = JSON.stringify(promaxRow())

  // PMX-02: the projection is now observed where it MATTERS — on the runner
  // `Instance` the agent loop actually receives, and on the `sourceLine` bytes a
  // chunk slice would carry to the box. The old assertions peeked at an
  // intermediate `task.raw`, a broad row object which the ProMax public boundary
  // no longer has at all.
  const rowsFor = (family: DatasetFamily): readonly FamilyCorpusRow[] =>
    readFamilyCorpusText(jsonl, family)

  test("gold patch + test patch never reach the agent-visible Instance", () => {
    const rows = rowsFor("promax")
    expect(rows).toHaveLength(1)
    const instance = rows[0]?.task?.toInstance("/tmp")
    expect(instance).toBeDefined()
    expect(instance?.goldPatch).toBeUndefined()
    expect(JSON.stringify(instance)).not.toContain("GOLD PATCH BODY")
    expect(JSON.stringify(instance)).not.toContain("GOLD TEST BODY")
    // …and the bytes a chunk slice would ship are gold-free too
    expect(rows[0]?.sourceLine).not.toContain("GOLD PATCH BODY")
    expect(rows[0]?.sourceLine).not.toContain("GOLD TEST BODY")
  })

  test("PAIRED — the SAME row through verified/live/pro keeps the gold (promax is the projector)", () => {
    for (const family of BUILTINS_BEFORE_PROMAX) {
      const rows = rowsFor(family)
      expect(rows[0]?.task?.toInstance("/tmp").goldPatch, `${family} must not project`).toContain(
        "GOLD PATCH BODY",
      )
      // …and their slice bytes are the VERBATIM source line
      expect(rows[0]?.sourceLine).toBe(jsonl)
    }
  })

  test("the projection preserves everything the agent legitimately needs", () => {
    const instance = rowsFor("promax")[0]?.task?.toInstance("/tmp")
    expect(instance?.id).toBe("key4127__promax-1")
    expect(instance?.swebench?.repo).toBe("acme/widget")
    expect(instance?.swebench?.baseCommit).toBe("a".repeat(40))
    expect(instance?.problemStatement).toBe("the widget does not widget")
    // the PUBLIC language label survives (it is the toolchain-preflight signal)
    expect(instance?.swebench?.repoLanguage).toBe(String(promaxRow().language))
    // …while the GRADER metadata does not travel with the agent-side instance
    expect(JSON.stringify(instance)).not.toContain(String(promaxRow().image_name))
    // the profile's readCorpus IS what the real reader receives
    expect(
      resolveDatasetFamilyProfile("promax").readCorpus(jsonl)[0]?.task?.toInstance("/tmp")
        .goldPatch,
    ).toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5 — fail-closed remote bootstrap (PMX-04 owns the live wiring)
// ─────────────────────────────────────────────────────────────────────────────
describe("PMX-01 — the promax remote bootstrap specification is fail-closed", () => {
  test("promax REFUSES the swebench pip harness / image namespace, even with overrides", () => {
    const promax = resolveDatasetFamilyProfile("promax")
    expect(() => promax.harnessSpec({ datasetName: "" })).toThrow(/promax/i)
    expect(() =>
      promax.harnessSpec({
        datasetName: "SWE-bench-Live/SWE-bench-Live",
        pipSpecOverride: "swebench==9.9.9",
        namespaceOverride: "custom-ns",
      }),
    ).toThrow(/promax/i)
    // PAIRED CONTROL: the other three still resolve their own spec unchanged.
    expect(resolveDatasetFamilyProfile("verified").harnessSpec({ datasetName: "" }).pipSpec).toBe(
      "swebench",
    )
    expect(resolveDatasetFamilyProfile("live").harnessSpec({ datasetName: "" }).namespace).toBe(
      "starryzhang",
    )
    expect(resolveDatasetFamilyProfile("pro").harnessSpec({ datasetName: "" }).pipSpec).toBe(
      "swebench",
    )
  })

  test("the on-box bootstrap callee REFUSES promax and still bootstraps the others", async () => {
    const seen: string[] = []
    const ssh = async (cmd: string) => {
      seen.push(cmd)
      return { code: 0, stdout: "", stderr: "" }
    }
    await expect(setupBoxForFamily({ family: "promax", ssh, log: () => {} })).rejects.toThrow(
      /promax/i,
    )
    expect(seen, "a refused promax bootstrap must issue NO ssh").toEqual([])
    // PAIRED CONTROL: verified is still a silent no-op, pro still clones Scale.
    const verifiedSeen: string[] = []
    await setupBoxForFamily({
      family: "verified",
      ssh: async (c: string) => {
        verifiedSeen.push(c)
        return { code: 0, stdout: "", stderr: "" }
      },
      log: () => {},
    })
    expect(verifiedSeen).toEqual([])
    const proSeen: string[] = []
    await setupBoxForFamily({
      family: "pro",
      ssh: async (c: string) => {
        proSeen.push(c)
        return { code: 0, stdout: "", stderr: "" }
      },
      log: () => {},
    })
    expect(proSeen.some((c) => c.includes("swebench-pro"))).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6 — the promax preflight (real shape check + the leak guard)
// ─────────────────────────────────────────────────────────────────────────────
describe("PMX-01 — promax preflight refuses a mislabeled or gold-bearing dataset", () => {
  // PMX-02: the shape check receives ALREADY-DECODED rows from the ProMax
  // family reader — exactly what `assertDatasetGradeableForFamily` hands it.
  const promaxRows = (path: string): readonly FamilyCorpusRow[] =>
    loadFamilyCorpusRowsOrThrow({ datasetPath: path, surface: "t", family: "promax" })
  const sound = (): Record<string, unknown> => {
    const row = promaxRow()
    delete row.patch
    delete row.test_patch
    return row
  }

  test("a Verified-shaped dataset mislabeled `promax` is refused as a CORPUS problem", () => {
    const path = writeJsonl("verified-shaped.jsonl", [
      { instance_id: "a__b-1", repo: "a/b", base_commit: "0".repeat(40), problem_statement: "x" },
    ])
    let message = ""
    try {
      assertProMaxDatasetShape({ rows: promaxRows(path), surface: "t" })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/ProMax-required columns/i)
    expect(message).toContain("a__b-1")
    // PAIRED: verified/live accept it through the REAL preflight callee (their
    // profile's check is a documented no-op) — promax did not arm a global gate.
    for (const family of ["verified", "live"] as const) {
      expect(() =>
        assertDatasetGradeableForFamily({ datasetPath: path, surface: "t", family }),
      ).not.toThrow()
    }
  })

  test("a GOLD-BEARING promax chunk is REFUSED (invariant 3 at the remote boundary)", () => {
    const path = writeJsonl("leaky.jsonl", [promaxRow()])
    let message = ""
    try {
      assertProMaxDatasetShape({ rows: promaxRows(path), surface: "t" })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/GRADER-ONLY/)
    expect(message).toContain("patch")
    // the refusal must NOT echo the gold body it is refusing
    expect(message).not.toContain("GOLD PATCH BODY")
    expect(message).not.toContain("GOLD TEST BODY")
    // PAIRED: an already-projected chunk clears the corpus checks entirely.
    const clean = writeJsonl("sound.jsonl", [sound()])
    expect(() => assertProMaxDatasetShape({ rows: promaxRows(clean), surface: "t" })).not.toThrow()
  })

  test("an --instance filter scopes the promax corpus check to the SELECTED rows", () => {
    const path = writeJsonl("mixed.jsonl", [
      sound(),
      { ...promaxRow({ instance_id: "key4127__promax-2" }) },
    ])
    expect(() =>
      assertProMaxDatasetShape({
        rows: promaxRows(path),
        surface: "t",
        instanceIds: ["key4127__promax-1"],
      }),
    ).not.toThrow()
    expect(() =>
      assertProMaxDatasetShape({
        rows: promaxRows(path),
        surface: "t",
        instanceIds: ["key4127__promax-2"],
      }),
    ).toThrow(/GRADER-ONLY/)
  })

  test("SPEND GUARD — the remote lane is refused BEFORE a box, even for a sound chunk", () => {
    // `setupBox` and `harnessSpec` also refuse, but both fire AFTER RunInstances.
    // The preflight callee is the one that runs before provisioning on BOTH the
    // full-remote and pool roots, so this is what makes "ProMax cannot run
    // remotely yet" free rather than a box-priced lesson.
    const path = writeJsonl("sound-for-lane.jsonl", [sound()])
    let message = ""
    try {
      assertDatasetGradeableForFamily({
        datasetPath: path,
        surface: "full-remote",
        family: "promax",
      })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/REMOTE ProMax lane/)
    expect(message).toMatch(/PMX-04/)
    // …and it says the corpus was FINE, so the operator does not go hunting.
    expect(message).toMatch(/refusal is the LANE/)
    // PAIRED: pro's own corpus rule still fires on the same file, and
    // verified/live still pass — no global gate was armed.
    expect(() =>
      assertDatasetGradeableForFamily({ datasetPath: path, surface: "t", family: "pro" }),
    ).toThrow(/Scale-harness-required/)
    for (const family of ["verified", "live"] as const) {
      expect(() =>
        assertDatasetGradeableForFamily({ datasetPath: path, surface: "t", family }),
      ).not.toThrow()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7 — TYPED ProMax settings on the ONE generic config (no second resolver)
// ─────────────────────────────────────────────────────────────────────────────
describe("PMX-01 — ProMax settings are typed fields of the ONE bench run config", () => {
  test("the frozen upstream pin travels on the resolved config", () => {
    const cfg = resolveBenchRunConfig({ argvFamily: "promax", env: {} })
    expect(cfg.promax.upstreamCommit).toBe(PROMAX_V1_SNAPSHOT.upstream_git_commit)
    expect(cfg.promax.bundleRoot).toBeUndefined()
    expect(cfg.promax.python).toBeUndefined()
  })

  test("bundle root + python come from their OWN env keys, never QUANTA_SWEBENCH_PRO_*", () => {
    const cfg = resolveBenchRunConfig({
      argvFamily: "promax",
      env: {
        [PROMAX_BUNDLE_ROOT_ENV]: "/opt/promax/77041028",
        [PROMAX_PYTHON_ENV]: "/opt/venv/bin/python",
        QUANTA_SWEBENCH_PRO_HARNESS_DIR: "/should/not/be/read",
        QUANTA_SWEBENCH_PRO_PYTHON_BIN: "/should/not/be/read",
      },
    })
    expect(cfg.promax.bundleRoot).toBe("/opt/promax/77041028")
    expect(cfg.promax.python).toBe("/opt/venv/bin/python")
    expect(JSON.stringify(cfg.promax)).not.toContain("/should/not/be/read")
  })

  test("settings resolve GENERICALLY — same value for every family (no family branch)", () => {
    const env = { [PROMAX_BUNDLE_ROOT_ENV]: "/opt/promax/77041028" }
    for (const family of ALL_FAMILIES) {
      expect(resolveBenchRunConfig({ argvFamily: family, env }).promax.bundleRoot).toBe(
        "/opt/promax/77041028",
      )
    }
    expect(resolveBenchRunConfig({ argvFamily: undefined, env }).promax.bundleRoot).toBe(
      "/opt/promax/77041028",
    )
  })

  test("an EXPLICIT-but-unusable bundle root / python FAILS CLOSED at the composition root", () => {
    for (const bad of ["", "   ", "relative/path", "./bundle", "~/bundle"]) {
      expect(
        () =>
          resolveBenchRunConfig({ argvFamily: undefined, env: { [PROMAX_BUNDLE_ROOT_ENV]: bad } }),
        `bundle root ${JSON.stringify(bad)} must be refused`,
      ).toThrow(new RegExp(PROMAX_BUNDLE_ROOT_ENV))
    }
    expect(() =>
      resolveBenchRunConfig({ argvFamily: undefined, env: { [PROMAX_PYTHON_ENV]: "   " } }),
    ).toThrow(new RegExp(PROMAX_PYTHON_ENV))
    // PAIRED CONTROL: an absolute root and a bare interpreter name are accepted.
    expect(
      resolveProMaxSettings({
        [PROMAX_BUNDLE_ROOT_ENV]: "/opt/promax/x",
        [PROMAX_PYTHON_ENV]: "python3.11",
      }).python,
    ).toBe("python3.11")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8 — the subprocess WIRE round-trip (env serializes; nothing bridges in-process)
// ─────────────────────────────────────────────────────────────────────────────
describe("PMX-01 — promax survives a subprocess serialization round-trip", () => {
  test("explicit promax is encoded; the child re-resolves the SAME typed profile", () => {
    const cfg = resolveBenchRunConfig({ argvFamily: "  PROMAX ", env: {} })
    const envelope = buildSubprocessFamilyEnv(cfg, { HOME: "/home/x" })
    expect(envelope[FAMILY_KEY]).toBe("promax")
    // the CHILD side: argv-free re-resolution from the inherited env alone
    const child = resolveBenchRunConfig({ argvFamily: undefined, env: envelope })
    expect(child.datasetFamily).toBe("promax")
    expect(resolveDatasetFamilyProfile(child.datasetFamily).reportPartitionKey).toBe(
      resolveDatasetFamilyProfile(cfg.datasetFamily).reportPartitionKey,
    )
  })

  test("PAIRED — an ABSENT selector still emits NO family key at all", () => {
    const envelope = buildSubprocessFamilyEnv(
      resolveBenchRunConfig({ argvFamily: undefined, env: {} }),
      { HOME: "/home/x" },
    )
    expect(FAMILY_KEY in envelope).toBe(false)
    // …and the whole union round-trips
    for (const fam of ALL_FAMILIES) {
      expect(
        buildSubprocessFamilyEnv({ datasetFamily: fam, familySelector: "explicit" }, {})[
          FAMILY_KEY
        ],
      ).toBe(fam)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 9 — the REAL CLI: help, dry-run routing, fail-closed refusal
// ─────────────────────────────────────────────────────────────────────────────
describe("PMX-01 — the real CLI routes promax end to end", () => {
  test(
    "`run --dataset-family promax --dry-run` reaches the ProMax profile's decisions",
    () => {
      const promax = runPlan("promax")
      expect(promax.code).toBe(0)
      expect(planLine(promax.out, "dataset family")).toBe("promax")
      expect(planLine(promax.out, "verifier")).toMatch(/promax/i)
      expect(planLine(promax.out, "preset")).toBe("agentless-v1")
      // PAIRED: `pro` still reaches the SCALE profile, `verified` neither.
      const pro = runPlan("pro")
      expect(planLine(pro.out, "verifier")).toBe("ScaleAI SWE-bench Pro harness")
      expect(planLine(pro.out, "dataset family")).toBe("pro")
      const verified = runPlan("verified")
      expect(planLine(verified.out, "verifier")).toBe("local testCmd")
      // …and the ABSENT default is byte-identical to explicit verified.
      const absent = runPlan(undefined)
      expect(planLine(absent.out, "dataset family")).toBe("verified")
      expect(planLine(absent.out, "preset")).toBe(planLine(verified.out, "preset"))
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "the env spelling and the `=` spelling reach the same root decision",
    () => {
      expect(planLine(runPlan(undefined, { [FAMILY_KEY]: "promax" }).out, "dataset family")).toBe(
        "promax",
      )
      expect(
        planLine(
          runCli(["run", "--swebench", cliFixtures.dataset, "--dry-run", "--dataset-family=promax"])
            .out,
          "dataset family",
        ),
      ).toBe("promax")
      // argv beats a CONFLICTING env at the real root, both directions
      expect(planLine(runPlan("promax", { [FAMILY_KEY]: "pro" }).out, "dataset family")).toBe(
        "promax",
      )
      expect(planLine(runPlan("pro", { [FAMILY_KEY]: "promax" }).out, "dataset family")).toBe("pro")
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "`promaxx` is refused at every family-bearing root (argv AND env)",
    () => {
      for (const r of [
        runPlan("promaxx"),
        fullRemotePlan("promaxx"),
        poolPlan("promaxx"),
        runPlan(undefined, { [FAMILY_KEY]: "promaxx" }),
      ]) {
        expect(r.code).not.toBe(0)
        expect(r.out).toMatch(/unknown dataset family/i)
        expect(r.out).toContain("promaxx")
      }
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "the full-remote and pool plans carry the resolved promax family + its bundle pin",
    () => {
      const env = { [PROMAX_BUNDLE_ROOT_ENV]: "/opt/promax/frozen" }
      const full = fullRemotePlan("promax", env)
      expect(full.code).toBe(0)
      expect(planToken(full.out, "dataset-family")).toBe("promax")
      expect(planToken(full.out, "promax-bundle-root")).toBe("/opt/promax/frozen")
      expect(planToken(full.out, "promax-upstream-commit")).toBe(
        PROMAX_V1_SNAPSHOT.upstream_git_commit,
      )
      const pool = poolPlan("promax", env)
      expect(pool.code).toBe(0)
      expect(planToken(pool.out, "dataset-family")).toBe("promax")
      expect(planToken(pool.out, "promax-bundle-root")).toBe("/opt/promax/frozen")
      // PAIRED — a NON-promax plan carries NO promax note even with the env set
      // (byte-identical for the existing families).
      const proFull = fullRemotePlan("pro", env)
      expect(planToken(proFull.out, "dataset-family")).toBe("pro")
      expect(proFull.out).not.toContain("promax-bundle-root")
      const absentFull = fullRemotePlan(undefined, env)
      expect(absentFull.out).not.toContain("promax")
    },
    SPAWN_BUDGET_MS,
  )

  test(
    "CLI help lists the family selector INCLUDING promax (generated, not hand-listed)",
    () => {
      const help = runCli(["help"])
      expect(help.code).toBe(0)
      for (const fam of ALL_FAMILIES) {
        expect(help.out, `help does not mention the ${fam} family`).toContain(fam)
      }
      expect(help.out).toContain("--dataset-family")
      // the bestk-passk usage line is likewise generated from the registry
      const usage = runCli(["bestk-passk"], { QUANTA_BENCH_BESTK_PASSK: "1" })
      expect(usage.out).toContain("promax")
    },
    SPAWN_BUDGET_MS,
  )
})
