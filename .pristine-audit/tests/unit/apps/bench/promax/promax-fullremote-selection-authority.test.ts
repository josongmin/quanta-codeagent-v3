/**
 * HELLGATE — residual debt #1: on the FULL-REMOTE path the sample manifest must
 * BE the selection authority.
 *
 * PMX-06 wired `resolveSelection` into the LOCAL runner (`filterSwebenchTasks`)
 * and nowhere else. `grade --mode full` built its `expected` set from
 * `--instance` or "every id in the dataset file", so a remote campaign that
 * called itself PMX-7 was running whatever `--instance` happened to say, and the
 * artifact could not contradict it.
 *
 * Everything below drives the REAL `cmdGradeFullRemote` composition root through
 * an INJECTED backend port. The observable is the launch config the command
 * actually hands the backend factory — not a re-assertion of the resolver.
 *
 * 🔴 SPEND SAFETY. `createFullRemoteBackend` is NEVER constructed here. The
 * injected port both records and REPLACES it, and the refusal cases assert the
 * port was never reached at all (so a regression that "fails open" into
 * provisioning fails this file instead of billing). No AWS, no ssh, no docker.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  cmdGradeFullRemote,
  resolveFullRemoteExpectedInstanceIds,
} from "@/apps/bench/commands/grade"
import { DATASET_FAMILIES } from "@/apps/bench/dataset-family-token"
import { DatasetSelectionConflictError } from "@/apps/bench/profiles/selection"
import {
  buildProMaxSampleFamily,
  PROMAX_SAMPLE_ENV,
  ProMaxSampleError,
  type ProMaxSampleManifest,
} from "@/apps/bench/promax/corpus"
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance/frozen-snapshot"
import type { FullRemoteConfig, FullRemoteResult } from "@/apps/bench/remote/box-session"

const REVISION = PROMAX_V1_SNAPSHOT.hf_dataset_revision
const LANGUAGES = ["c", "c++", "go", "java", "python", "rust", "typescript"] as const
const PER_LANGUAGE = 3

const row = (language: string, n: number): Record<string, unknown> => ({
  instance_id: `promax__${language.replace("+", "p")}-${n}`,
  repo: `promax-org/${language.replace("+", "p")}-lib`,
  base_commit: "0".repeat(40),
  problem_statement: `PROBLEM ${language} ${n}`,
  language,
})

const ROWS = LANGUAGES.flatMap((language) =>
  Array.from({ length: PER_LANGUAGE }, (_, i) => row(language, i)),
)

const DIRS: string[] = []
afterAll(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true })
})

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pmx-fullremote-"))
  DIRS.push(dir)
  return dir
}

const writeFixture = (name: string, text: string): string => {
  const path = join(scratch(), name)
  writeFileSync(path, text)
  return path
}

const PROMAX_DATASET = writeFixture("promax.json", JSON.stringify(ROWS))
const VERIFIED_DATASET = writeFixture(
  "verified.jsonl",
  `${["alpha__a-1", "beta__b-2", "gamma__c-3"]
    .map((id) =>
      JSON.stringify({
        instance_id: id,
        repo: "o/r",
        base_commit: "1".repeat(40),
        problem_statement: "P",
        patch: "",
      }),
    )
    .join("\n")}\n`,
)

const sampleFamily = (over: { datasetRevision?: string } = {}): readonly ProMaxSampleManifest[] =>
  buildProMaxSampleFamily({
    candidates: ROWS.map((r) => ({
      instanceId: String(r.instance_id),
      language: String(r.language),
    })),
    datasetRevision: over.datasetRevision ?? REVISION,
    specs: [
      { name: "PMX-7", quotas: {}, perLanguage: 1 },
      { name: "PMX-14", quotas: {}, perLanguage: 2 },
    ],
  })

const manifestNamed = (
  family: readonly ProMaxSampleManifest[],
  name: string,
): ProMaxSampleManifest => {
  const found = family.find((m) => m.name === name)
  if (found === undefined) throw new Error(`fixture: no ${name} manifest`)
  return found
}

const writeManifest = (manifest: ProMaxSampleManifest): string =>
  writeFixture(`${manifest.name}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`)

const PMX7 = manifestNamed(sampleFamily(), "PMX-7")
const PMX7_PATH = writeManifest(PMX7)
const PMX7_IDS = [...PMX7.instanceIds]

/** A manifest sealed against a DIFFERENT dataset revision — the fail-closed case.
 *  Its OWN self-digest is valid (it was built by the real builder), so what the
 *  selector refuses is genuinely the revision, not a corrupted document. */
const PMX7_DRIFTED_PATH = writeManifest(
  manifestNamed(sampleFamily({ datasetRevision: "deadbeefdeadbeefdeadbeefdeadbeef" }), "PMX-7"),
)

// ── the injected backend port (the ONLY thing that stands in for provisioning) ──

interface Recorded {
  readonly configs: FullRemoteConfig[]
}

const recordingPort = (
  rec: Recorded,
): ((cfg: FullRemoteConfig) => { run: () => Promise<FullRemoteResult> }) => {
  return (cfg) => {
    rec.configs.push(cfg)
    return {
      run: async (): Promise<FullRemoteResult> => ({ dryRun: true, plan: ["[fake] no launch"] }),
    }
  }
}

/** A port that must never be reached. Reaching it is the spend regression. */
const spendGuardPort = (): ((cfg: FullRemoteConfig) => {
  run: () => Promise<FullRemoteResult>
}) => {
  return () => {
    throw new Error("SPEND GUARD: the full-remote backend was constructed after a refusal")
  }
}

const ORIGINAL_ARGV = process.argv
const TOUCHED_ENV = [PROMAX_SAMPLE_ENV] as const
const savedEnv = new Map<string, string | undefined>()
beforeEach(() => {
  for (const key of TOUCHED_ENV) savedEnv.set(key, process.env[key])
})
afterEach(() => {
  process.argv = ORIGINAL_ARGV
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
})

const argvFor = (args: readonly string[]): void => {
  process.argv = [
    "bun",
    "quanta-bench",
    "grade",
    "--mode",
    "full",
    "--allow-remote-secrets",
    ...args,
  ]
}

const runFullRemote = async (
  args: readonly string[],
  port: (cfg: FullRemoteConfig) => { run: () => Promise<FullRemoteResult> },
): Promise<void> => {
  argvFor(["--dry-run", ...args])
  await cmdGradeFullRemote({ makeFullRemoteBackend: port })
}

describe("the FULL-REMOTE expected set — manifest authority", () => {
  test("PMX-7 selects exactly the manifest's 7 ids, IN ORDER, on the real command", async () => {
    process.env[PROMAX_SAMPLE_ENV] = PMX7_PATH
    const rec: Recorded = { configs: [] }
    await runFullRemote(
      ["--dataset", PROMAX_DATASET, "--dataset-family", "promax"],
      recordingPort(rec),
    )
    expect(rec.configs).toHaveLength(1)
    expect(PMX7_IDS).toHaveLength(7)
    expect(rec.configs[0]?.instanceIds).toEqual(PMX7_IDS)
  })

  test("NON-VACUITY — without the manifest the SAME argv selects all 21 corpus ids", async () => {
    delete process.env[PROMAX_SAMPLE_ENV]
    const rec: Recorded = { configs: [] }
    await runFullRemote(
      ["--dataset", PROMAX_DATASET, "--dataset-family", "promax"],
      recordingPort(rec),
    )
    expect(rec.configs[0]?.instanceIds).toHaveLength(LANGUAGES.length * PER_LANGUAGE)
  })

  test("a dataset-REVISION mismatch fails closed and never reaches provisioning", async () => {
    process.env[PROMAX_SAMPLE_ENV] = PMX7_DRIFTED_PATH
    await expect(
      runFullRemote(["--dataset", PROMAX_DATASET, "--dataset-family", "promax"], spendGuardPort()),
    ).rejects.toBeInstanceOf(ProMaxSampleError)
  })

  test("TWO AUTHORITIES (--instance + manifest) are refused before any backend exists", async () => {
    process.env[PROMAX_SAMPLE_ENV] = PMX7_PATH
    await expect(
      runFullRemote(
        [
          "--dataset",
          PROMAX_DATASET,
          "--dataset-family",
          "promax",
          "--instance",
          PMX7_IDS[0] ?? "x",
        ],
        spendGuardPort(),
      ),
    ).rejects.toBeInstanceOf(DatasetSelectionConflictError)
  })

  test("BYTE-IDENTICAL CONTROL — verified is untouched by the manifest knob", async () => {
    process.env[PROMAX_SAMPLE_ENV] = PMX7_PATH
    const rec: Recorded = { configs: [] }
    await runFullRemote(["--dataset", VERIFIED_DATASET], recordingPort(rec))
    expect(rec.configs[0]?.instanceIds).toEqual(["alpha__a-1", "beta__b-2", "gamma__c-3"])

    const filtered: Recorded = { configs: [] }
    await runFullRemote(
      ["--dataset", VERIFIED_DATASET, "--instance", "beta__b-2,gamma__c-3"],
      recordingPort(filtered),
    )
    expect(filtered.configs[0]?.instanceIds).toEqual(["beta__b-2", "gamma__c-3"])
  })
})

describe("the pure resolver — full union, both directions", () => {
  test("every family resolves without a manifest; only promax narrows with one", () => {
    // The FULL union flows through, so a resolver that hard-coded one family fails.
    for (const family of DATASET_FAMILIES) {
      const ids = resolveFullRemoteExpectedInstanceIds({
        datasetPath: family === "promax" ? PROMAX_DATASET : VERIFIED_DATASET,
        family,
        env: {},
        surface: "full-remote",
      })
      expect(ids.length, `${family} produced an empty expected set`).toBeGreaterThan(0)
    }
    for (const family of DATASET_FAMILIES) {
      const withManifest = resolveFullRemoteExpectedInstanceIds({
        datasetPath: family === "promax" ? PROMAX_DATASET : VERIFIED_DATASET,
        family,
        env: { [PROMAX_SAMPLE_ENV]: PMX7_PATH },
        surface: "full-remote",
      })
      if (family === "promax") expect(withManifest).toEqual(PMX7_IDS)
      else expect(withManifest).toEqual(["alpha__a-1", "beta__b-2", "gamma__c-3"])
    }
  })

  test("an unreadable dataset keeps the historical `--instance` behaviour", () => {
    expect(
      resolveFullRemoteExpectedInstanceIds({
        datasetPath: "/nonexistent/instances.jsonl",
        family: "verified",
        env: {},
        instanceFilter: " a , b ,,",
        surface: "full-remote",
      }),
    ).toEqual(["a", "b"])
  })
})
