/**
 * HELLGATE — PMX-02: ONE corpus reader, no bypass parser.
 *
 * The ticket's DoD says "corpus parse … has exactly one implementation owner",
 * and the way that claim rots is invisible: a surface keeps its own line splitter
 * and merely HAPPENS to agree, until a family arrives whose corpus is not one
 * JSON object per line. Before PMX-02 there were three such splitters, and for an
 * official JSON ARRAY two of them silently produced ZERO rows — which reads as
 * "empty dataset", not as an error.
 *
 * So this file does two things, both against real production entry points:
 *
 *  1. AGREEMENT — a JSON-ARRAY corpus resolves the SAME ordered instance ids
 *     through the local run path, the local dry-run (a real CLI child process),
 *     the full-remote launch preflight, the pool launch preflight, the pool chunk
 *     slicer, and the instance-id enumerator.
 *  2. BYPASS PROOF — replacing that ONE profile reader with a FAILING FAKE makes
 *     every one of those surfaces fail, before any repository is prepared and
 *     before any box is provisioned (asserted on the recorded AWS calls, not
 *     assumed). A surface that kept a private parser would stay green here.
 *
 * ⚠️ SPEND SAFETY: every remote case injects a recording spawn and asserts
 * `run-instances` was never issued. The child-process cases are `--dry-run` only.
 * ⚠️ LIVE-DATA: nothing here reaches `writeReport`; the dry-run root exits before
 * any artifact write and the remote cases never get past preflight. The parent's
 * before/after `~/.quanta/bench/results` count is the check.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DatasetFamily } from "@/apps/bench/dataset-family-token"
import { readFamilyCorpusText } from "@/apps/bench/profiles/corpus-read"
import type { FamilyCorpusReader } from "@/apps/bench/profiles/corpus-row"
import { promaxFamilyCorpusReader } from "@/apps/bench/profiles/promax-corpus"
import { registerDatasetFamilyProfile } from "@/apps/bench/profiles/registry"
import type { DatasetFamilyProfile } from "@/apps/bench/profiles/types"
import {
  assertDatasetGradeableForFamily,
  assertRemoteDatasetLaunchable,
  assertRemoteDatasetSelectionExists,
  readDatasetInstanceIds,
} from "@/apps/bench/remote/box-session/dataset-preflight"
import { createFullRemoteBackend } from "@/apps/bench/remote/full"
import { runPool } from "@/apps/bench/remote/pool"
import { readSwebenchTasks } from "@/apps/bench/run-main-helpers"
import { planMicrochunks } from "@/apps/bench/slicing/microchunk"
import { __resetRuntimeConfig } from "@/shared"
import { createSpawnRecorder, ok, whenArgsInclude, whenCmd } from "../../../bench-spawn-testkit"
import { buildSyntheticProMaxCorpus, PROMAX_LANGUAGE_COUNTS } from "./promax-corpus-fixture"

const TEMP_DIRS: string[] = []
const alloc = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}
/**
 * REDIRECT the bench home. These cases drive real code that resolves
 * `benchRunsRoot()` and the token-budget store, so without this every run left
 * two empty `run-<ts>/` directories plus `~/.quanta/bench-token-budget` in the
 * OPERATOR's home — measured, 7,892 of them accumulated there, and the count
 * moved by exactly 2 per run of this file.
 *
 * RESTORED, not deleted: bun shares one process across every test file, so a
 * deleted variable stays deleted for everything scheduled afterwards —
 * including the fence `tests/setup.ts` installs.
 */
const BENCH_HOME = mkdtempSync(join(tmpdir(), "pmx-one-reader-home-"))
TEMP_DIRS.push(BENCH_HOME)
const PRIOR_BENCH_HOME = process.env.QUANTA_BENCH_HOME
// The token-budget store is governed by its OWN knob, not by
// `QUANTA_BENCH_HOME` — `token-budget.ts:137` resolves
// `quantaHomePath("bench-token-budget")` unless this is set. So the bench-home
// redirect alone still left `~/.quanta/bench-token-budget` and its
// `.lease-state` sibling in the operator's home. Measured.
const PRIOR_TOKEN_BUDGET_DIR = process.env.QUANTA_BENCH_TOKEN_BUDGET_DIR
process.env.QUANTA_BENCH_HOME = BENCH_HOME
process.env.QUANTA_BENCH_TOKEN_BUDGET_DIR = join(BENCH_HOME, "token-budget")
__resetRuntimeConfig()

afterAll(() => {
  if (PRIOR_BENCH_HOME === undefined) delete process.env.QUANTA_BENCH_HOME
  else process.env.QUANTA_BENCH_HOME = PRIOR_BENCH_HOME
  if (PRIOR_TOKEN_BUDGET_DIR === undefined) delete process.env.QUANTA_BENCH_TOKEN_BUDGET_DIR
  else process.env.QUANTA_BENCH_TOKEN_BUDGET_DIR = PRIOR_TOKEN_BUDGET_DIR
  __resetRuntimeConfig()
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

// A SMALL official-shaped corpus: 12 rows across the seven languages, already
// PROJECTED (no gold), because these cases are about the reader/format axis and a
// gold-bearing chunk would be refused by the promax preflight for a different and
// unrelated reason.
const SMALL_COUNTS = { c: 2, "c++": 2, go: 2, java: 2, python: 2, rust: 1, typescript: 1 } as const
const CORPUS = buildSyntheticProMaxCorpus(SMALL_COUNTS)
const PUBLIC_ROWS = CORPUS.rows.map((row) => ({
  instance_id: row.instance_id,
  repo: row.repo,
  base_commit: row.base_commit,
  problem_statement: row.problem_statement,
  language: row.language,
}))
/** The OFFICIAL on-disk form: a pretty-printed JSON ARRAY. */
const ARRAY_TEXT = `${JSON.stringify(PUBLIC_ROWS, null, 2)}\n`
const EXPECTED_IDS = CORPUS.instanceIds.slice(0, PUBLIC_ROWS.length)

const DATASET = join(alloc("pmx02-ds-"), "public-tasks.json")
writeFileSync(DATASET, ARRAY_TEXT)

// ── the two probe families ──────────────────────────────────────────────────
// `pmx02ok` differs from the real `promax` in exactly ONE way: its preflight does
// not refuse the (not-yet-wired) remote lane. Everything else — the reader above
// all — is the real ProMax wiring, so the remote surfaces below exercise the real
// JSON-array reader rather than a stand-in.
const probeProfile = (family: string, readCorpus: FamilyCorpusReader): DatasetFamilyProfile => ({
  family: family as DatasetFamily,
  reportPartitionKey: family,
  gradesWithProHarness: false,
  readCorpus,
  // The preflight MUST consult the reader — that is what makes the failing-fake
  // case observable at this seam (the real ProMax preflight does the same).
  preflight: (input) => {
    void input.readRows()
  },
  gradeEvaluator: () => async () => ({ resolved: false, gradingCompleted: false, log: "" }),
  harnessSpec: () => ({ pipSpec: "swebench", namespace: "swebench" }),
  onBoxEnvPrefix: () => "",
  admitBox: () => {},
  setupBox: async () => {},
})

const FAIL_MARKER = "PMX02-FAKE-READER-REFUSED"
const failingReader: FamilyCorpusReader = () => {
  throw new Error(FAIL_MARKER)
}

const OK: DatasetFamily = "pmx02ok" as DatasetFamily
const FAIL: DatasetFamily = "pmx02fail" as DatasetFamily
const disposers = [
  registerDatasetFamilyProfile(probeProfile("pmx02ok", promaxFamilyCorpusReader)),
  registerDatasetFamilyProfile(probeProfile("pmx02fail", failingReader)),
]
afterAll(() => {
  for (const dispose of disposers) dispose()
})

const AUTH = JSON.stringify({
  access_token: "ACCESS-xyz",
  refresh_token: "r",
  id_token: "i",
  account_id: "acct",
  expires_at: "2099-01-01T00:00:00Z",
})

/** A spawn recorder that answers the pre-provision probes and would answer a
 *  launch — so "no run-instances" means the code REFUSED, not that the fake
 *  could not have launched. */
const spawnRecorder = () =>
  createSpawnRecorder(
    whenArgsInclude("describe-security-groups", ok("sg-abc")),
    whenCmd("curl", ok("9.9.9.9")),
    whenArgsInclude("run-instances", ok("i-deadbeef")),
    whenArgsInclude("describe-instances", ok("1.2.3.4")),
  )

const fullRemote = (family: DatasetFamily, spawn: ReturnType<typeof spawnRecorder>) =>
  createFullRemoteBackend({
    repoDir: "/tmp/fake-repo",
    authJson: AUTH,
    datasetPath: DATASET,
    singleBoxGuardDir: join(alloc("pmx02-guard-"), "guard"),
    tokenBudgetDir: alloc("pmx02-budget-"),
    tokenBudgetWaitMs: 5_000,
    tokenBudgetPollMs: 10,
    sleep: async () => {},
    maxReadyPolls: 1,
    ami: "ami-0testtesttesttest",
    spawn: spawn.fn,
    swebenchDatasetFamily: family,
  })

const poolConfig = (family: DatasetFamily, spawn: ReturnType<typeof spawnRecorder>) => ({
  provision: {
    repoDir: "/tmp/fake-repo",
    authJson: AUTH,
    datasetPath: DATASET,
    singleBoxGuardDir: join(alloc("pmx02-pool-guard-"), "guard"),
    tokenBudgetDir: alloc("pmx02-pool-budget-"),
    sleep: async () => {},
    maxReadyPolls: 1,
    ami: "ami-0testtesttesttest",
    spawn: spawn.fn,
    swebenchDatasetFamily: family,
  },
  workers: 1,
  preset: "agentless-v1",
  model: "gpt-5",
  concurrency: 1,
  authJsonProvider: () => AUTH,
})

const launchedInstances = (spawn: ReturnType<typeof spawnRecorder>): number =>
  spawn.calls.filter((c) => c.args.includes("run-instances")).length

/** Spawn the REAL bench CLI. Only `run --dry-run` is used here: that root prints
 *  the plan and exits BEFORE building an LLM port or writing any artifact, so no
 *  model call, no box, and no `~/.quanta/bench/results` write can occur. */
const CLI = join(import.meta.dir, "../../../../../src/apps/bench/cli.ts")
const runCliDryRun = (args: readonly string[]): { code: number; out: string } => {
  if (!args.includes("--dry-run")) throw new Error("spend guard: --dry-run is mandatory here")
  const childEnv: Record<string, string | undefined> = { ...process.env }
  delete childEnv.QUANTA_SWEBENCH_DATASET_FAMILY
  delete childEnv.QUANTA_SWEBENCH_DATASET
  const proc = Bun.spawnSync([process.execPath, CLI, "run", ...args], {
    env: childEnv as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: proc.exitCode ?? -1, out: `${proc.stdout.toString()}${proc.stderr.toString()}` }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 — AGREEMENT: every surface resolves the same ordered ids
// ─────────────────────────────────────────────────────────────────────────────
describe("PMX-02 — local, dry-run, full, pool and the chunk slicer share ONE reader", () => {
  test("KNOWN-ITEM FLOOR — the fixture really is an official JSON ARRAY, not JSONL", () => {
    expect(ARRAY_TEXT.trimStart().startsWith("[")).toBe(true)
    expect(EXPECTED_IDS.length).toBe(12)
    expect(new Set(Object.keys(SMALL_COUNTS))).toEqual(new Set(Object.keys(PROMAX_LANGUAGE_COUNTS)))
  })

  test("the LOCAL run path resolves the ordered ids", () => {
    expect(readSwebenchTasks(DATASET, "promax").map((r) => r.instanceId)).toEqual([...EXPECTED_IDS])
  })

  test("the CHUNK SLICER resolves the same ordered ids (one per slice)", () => {
    const planned = planMicrochunks(ARRAY_TEXT, "ds", 1, (t) => readFamilyCorpusText(t, "promax"))
    expect(planned.flatMap((p) => p.instanceIds)).toEqual([...EXPECTED_IDS])
    // …and each slice's bytes are JSONL that the SAME reader reads back
    const roundTrip = planned.flatMap((p) =>
      readFamilyCorpusText(p.lines.join("\n"), "promax").map((r) => r.instanceId),
    )
    expect(roundTrip).toEqual([...EXPECTED_IDS])
  })

  test("the REAL CLI local DRY-RUN plans the same ordered ids", () => {
    const r = runCliDryRun(["--swebench", DATASET, "--dataset-family", "promax", "--dry-run"])
    expect(r.code).toBe(0)
    // KNOWN-ITEM FLOOR — it really is the dataset dry-run plan
    expect(r.out).toContain("dry-run plan (NO LLM will be called)")
    expect(r.out).toContain(`dataset: ${DATASET}`)
    expect(r.out).toContain("dataset family: promax")
    expect(r.out).toContain(`instances: ${EXPECTED_IDS.length} loaded`)
    for (const id of EXPECTED_IDS.slice(0, 3)) expect(r.out).toContain(id)
    // PAIRED CONTROL — the SAME file under a JSONL family plans ZERO instances,
    // which is exactly the silent failure the one-reader design removes.
    const verified = runCliDryRun([
      "--swebench",
      DATASET,
      "--dataset-family",
      "verified",
      "--dry-run",
    ])
    expect(verified.out).not.toContain(`instances: ${EXPECTED_IDS.length} loaded`)
  }, 120_000)

  test("the INSTANCE-ID enumerator resolves the same ordered ids", () => {
    expect(readDatasetInstanceIds(DATASET, "promax")).toEqual([...EXPECTED_IDS])
  })

  test("the FULL-REMOTE and POOL launch preflights accept the JSON array", () => {
    expect(() =>
      assertRemoteDatasetLaunchable({ datasetPath: DATASET, surface: "full-remote", family: OK }),
    ).not.toThrow()
    expect(() =>
      assertRemoteDatasetSelectionExists({
        datasetPath: DATASET,
        instanceIds: [EXPECTED_IDS[0] ?? "@@none@@"],
        surface: "full-remote",
        family: OK,
      }),
    ).not.toThrow()
    expect(() =>
      assertDatasetGradeableForFamily({
        datasetPath: DATASET,
        surface: "pool chunk c1",
        family: OK,
      }),
    ).not.toThrow()
  })

  test("PAIRED CONTROL — a JSONL family sees ZERO rows in the SAME file", () => {
    // This is the regression the one-reader design exists to prevent: the old
    // JSONL-only preflight would have called this dataset unreadable/empty.
    for (const family of ["verified", "live", "pro"] as const) {
      expect(readFamilyCorpusText(ARRAY_TEXT, family)).toHaveLength(0)
      expect(() =>
        assertRemoteDatasetLaunchable({ datasetPath: DATASET, surface: "t", family }),
      ).toThrow(/no parseable task rows/)
    }
  })

  test("PAIRED CONTROL — a JSONL corpus still works for the JSONL families", () => {
    const jsonl = join(alloc("pmx02-jsonl-"), "instances.jsonl")
    writeFileSync(jsonl, `${PUBLIC_ROWS.map((r) => JSON.stringify(r)).join("\n")}\n`)
    for (const family of ["verified", "live", "pro"] as const) {
      expect(readDatasetInstanceIds(jsonl, family)).toEqual([...EXPECTED_IDS])
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2 — BYPASS PROOF: a failing fake reader reddens every surface
// ─────────────────────────────────────────────────────────────────────────────
describe("PMX-02 — replacing the ONE reader with a failing fake fails EVERY surface", () => {
  test("the LOCAL run path fails before repository preparation", () => {
    expect(() => readSwebenchTasks(DATASET, FAIL)).toThrow(FAIL_MARKER)
  })

  test("the CHUNK SLICER fails", () => {
    expect(() =>
      planMicrochunks(ARRAY_TEXT, "ds", 1, (t) => readFamilyCorpusText(t, FAIL)),
    ).toThrow(FAIL_MARKER)
  })

  test("the launchable / selection / gradeable preflights all fail", () => {
    expect(() =>
      assertRemoteDatasetLaunchable({ datasetPath: DATASET, surface: "t", family: FAIL }),
    ).toThrow(FAIL_MARKER)
    expect(() =>
      assertRemoteDatasetSelectionExists({
        datasetPath: DATASET,
        instanceIds: [EXPECTED_IDS[0] ?? "@@none@@"],
        surface: "t",
        family: FAIL,
      }),
    ).toThrow(FAIL_MARKER)
    expect(() =>
      assertDatasetGradeableForFamily({ datasetPath: DATASET, surface: "t", family: FAIL }),
    ).toThrow(FAIL_MARKER)
  })

  test("the REAL full-remote backend fails BEFORE provisioning a box", async () => {
    const spawn = spawnRecorder()
    let message = ""
    await fullRemote(FAIL, spawn)
      .run()
      .catch((err: unknown) => {
        message = err instanceof Error ? err.message : String(err)
      })
    expect(message).toContain(FAIL_MARKER)
    expect(launchedInstances(spawn), "a box was provisioned despite the reader refusing").toBe(0)
  }, 60_000)

  // NOTE, stated rather than quietly omitted: there is NO child-process case for
  // the failing fake. A probe family is registered at RUNTIME in this process, and
  // a freshly spawned CLI has no registration seam through which to learn it — the
  // child refuses `--dataset-family pmx02fail` at the composition root, which is
  // correct behavior but proves nothing about the reader. The local path is
  // covered IN-PROCESS above (`readSwebenchTasks`), and the CLI's local dry-run is
  // covered POSITIVELY by the real `promax` family plus its paired verified
  // control, which together show the CLI really does route through the profile
  // reader.

  test("the REAL pool fails BEFORE provisioning a box", async () => {
    const spawn = spawnRecorder()
    let message = ""
    await runPool([{ runId: "c1", datasetPath: DATASET }], poolConfig(FAIL, spawn) as never).catch(
      (err: unknown) => {
        message = err instanceof Error ? err.message : String(err)
      },
    )
    expect(message).toContain(FAIL_MARKER)
    expect(launchedInstances(spawn), "a box was provisioned despite the reader refusing").toBe(0)
  }, 60_000)

  test("PAIRED CONTROL — the same drives get PAST preflight for the working reader", async () => {
    const spawn = spawnRecorder()
    let message = ""
    await runPool([{ runId: "c1", datasetPath: DATASET }], poolConfig(OK, spawn) as never).catch(
      (err: unknown) => {
        message = err instanceof Error ? err.message : String(err)
      },
    )
    // It still fails later (the fake spawn does not model a whole box lifecycle),
    // but it must NOT fail with the reader's refusal — which is what proves the
    // FAIL cases above were stopped by the READER and not by the fixture.
    expect(message).not.toContain(FAIL_MARKER)
    // …and it REACHED provisioning, which is what makes the FAIL cases'
    // `run-instances === 0` a real observation rather than a fixture artifact.
    expect(launchedInstances(spawn)).toBeGreaterThan(0)
  }, 60_000)
})
