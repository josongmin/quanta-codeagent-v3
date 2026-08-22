/**
 * HELLGATE — PMX-06 / aug-22 residual G4: the sample manifest is the SELECTION
 * AUTHORITY, not decoration.
 *
 * `prepare-corpus.ts --samples-out` has emitted `PMX-7 / PMX-14 / PMX-40 /
 * PMX-170` since PMX-02 and NOTHING read them back, so a campaign that claimed
 * "the seven PMX-7 ids" was running whatever `--instance` happened to say and no
 * artifact could contradict it.
 *
 * Everything below drives the REAL production selector — `filterSwebenchTasks`,
 * the function `run-main.ts` calls to decide which tasks execute — through the
 * REAL `DatasetFamilyProfile.resolveSelection` port, against manifests written by
 * the REAL `buildProMaxSampleFamily`. The three ticket gates are each asserted:
 *
 *   • selecting PMX-7 yields exactly the manifest's 7 ids, IN ORDER;
 *   • a manifest/dataset-revision mismatch FAILS CLOSED (never "run everything");
 *   • the ordering is byte-identical across regeneration.
 *
 * Plus the byte-identical control (no manifest ⇒ the historical `--instance`
 * filter, unchanged, for promax AND for the JSONL families) and the
 * two-authorities refusal.
 *
 * ⚠️ No provisioning, no network, no report: local dataset text + temp files.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFamilyCorpusText } from "@/apps/bench/profiles/corpus-read"
import { runnableTasksOf } from "@/apps/bench/profiles/corpus-row"
import { resolveDatasetFamilyProfile } from "@/apps/bench/profiles/registry"
import { DatasetSelectionConflictError } from "@/apps/bench/profiles/selection"
import {
  buildProMaxSampleFamily,
  PROMAX_SAMPLE_ENV,
  ProMaxSampleError,
  type ProMaxSampleManifest,
  selectProMaxSampleIds,
} from "@/apps/bench/promax/corpus"
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance/frozen-snapshot"
import { filterSwebenchTasks, type SwebenchRunnableRow } from "@/apps/bench/run-main-helpers"

const REVISION = PROMAX_V1_SNAPSHOT.hf_dataset_revision
/** The seven upstream ProMax languages — PMX-7 is one instance per language. */
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
const CORPUS_TEXT = JSON.stringify(ROWS)

const candidates = (): Array<{ instanceId: string; language: string }> =>
  ROWS.map((r) => ({ instanceId: String(r.instance_id), language: String(r.language) }))

const buildFamily = (over: { seed?: string; datasetRevision?: string } = {}) =>
  buildProMaxSampleFamily({
    candidates: candidates(),
    datasetRevision: over.datasetRevision ?? REVISION,
    ...(over.seed !== undefined ? { seed: over.seed } : {}),
    specs: [
      { name: "PMX-7", quotas: {}, perLanguage: 1 },
      { name: "PMX-14", quotas: {}, perLanguage: 2 },
    ],
  })

const named = (family: readonly ProMaxSampleManifest[], name: string): ProMaxSampleManifest => {
  const found = family.find((m) => m.name === name)
  if (found === undefined) throw new Error(`fixture: no ${name} manifest`)
  return found
}

const DIRS: string[] = []
afterAll(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true })
})
const writeManifest = (manifest: unknown, name = "PMX-7.manifest.json"): string => {
  const dir = mkdtempSync(join(tmpdir(), "pmx-g4-"))
  DIRS.push(dir)
  const path = join(dir, name)
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return path
}

const promaxRows = (): SwebenchRunnableRow[] => [
  ...runnableTasksOf(readFamilyCorpusText(CORPUS_TEXT, "promax")),
]

/** Drive the REAL production selector with a controlled argv + env. */
const ORIGINAL_ARGV = process.argv
beforeEach(() => {
  process.argv = ["bun", "bench"]
})
afterEach(() => {
  process.argv = ORIGINAL_ARGV
})

const select = (
  env: NodeJS.ProcessEnv,
  rows: SwebenchRunnableRow[] = promaxRows(),
): SwebenchRunnableRow[] => filterSwebenchTasks(rows, { family: "promax", env })

describe("G4 — the port is REGISTERED and reachable from the live selector", () => {
  test("KNOWN-ITEM FLOOR — only promax declares a selection authority", () => {
    expect(resolveDatasetFamilyProfile("promax").resolveSelection).toBeDefined()
    for (const family of ["verified", "live", "pro"] as const) {
      expect(
        resolveDatasetFamilyProfile(family).resolveSelection,
        `${family} unexpectedly grew a selection authority`,
      ).toBeUndefined()
    }
    // …and the fixture really is a 7-language, 21-row promax corpus.
    expect(promaxRows()).toHaveLength(LANGUAGES.length * PER_LANGUAGE)
  })

  test("BYTE-IDENTICAL CONTROL — with no manifest the historical filter is unchanged", () => {
    const all = promaxRows()
    expect(select({}).map((r) => r.instanceId)).toEqual(all.map((r) => r.instanceId))
    // …and the `--instance` substring filter still works exactly as before.
    process.argv = ["bun", "bench", "--instance", "rust"]
    expect(select({}).map((r) => r.instanceId)).toEqual(
      all.filter((r) => r.instanceId.includes("rust")).map((r) => r.instanceId),
    )
    // …and a family with NO port is untouched even when the knob is set.
    const verifiedRows = [
      ...runnableTasksOf(
        readFamilyCorpusText(
          `${JSON.stringify({ instance_id: "django__django-1", repo: "d/d", base_commit: "1".repeat(40), problem_statement: "P", patch: "" })}\n`,
          "verified",
        ),
      ),
    ]
    process.argv = ["bun", "bench"]
    expect(
      filterSwebenchTasks(verifiedRows, {
        family: "verified",
        env: { [PROMAX_SAMPLE_ENV]: "/nonexistent/PMX-7.manifest.json" },
      }).map((r) => r.instanceId),
    ).toEqual(["django__django-1"])
  })
})

describe("G4 gate 1 — selecting PMX-7 yields exactly the manifest's 7 ordered ids", () => {
  test("the live selector returns the manifest's ids, in the manifest's order", () => {
    const manifest = named(buildFamily(), "PMX-7")
    expect(manifest.instanceIds).toHaveLength(7)
    const path = writeManifest(manifest)
    const selected = select({ [PROMAX_SAMPLE_ENV]: path }).map((r) => r.instanceId)
    expect(selected).toEqual([...manifest.instanceIds])
    // ORDER is load-bearing, not just membership: the corpus is grouped by
    // language while the manifest is in the algorithm's global (hash) order, so
    // a set-equal-but-reordered implementation fails here.
    expect(selected).not.toEqual([...manifest.instanceIds].sort())
    // one instance per language, as PMX-7 is defined
    expect(new Set(selected.map((id) => id.split("-")[0]))).toHaveLength(LANGUAGES.length)
  })

  test("PMX-14 selects the strictly larger nested sample through the same path", () => {
    const family = buildFamily()
    const seven = named(family, "PMX-7")
    const fourteen = named(family, "PMX-14")
    const selected14 = select({
      [PROMAX_SAMPLE_ENV]: writeManifest(fourteen, "PMX-14.manifest.json"),
    }).map((r) => r.instanceId)
    expect(selected14).toEqual([...fourteen.instanceIds])
    expect(selected14).toHaveLength(14)
    // PMX-7 ⊂ PMX-14 survives the round trip through the selector
    for (const id of seven.instanceIds) expect(selected14).toContain(id)
  })
})

describe("G4 gate 2 — every manifest/dataset disagreement FAILS CLOSED", () => {
  const expectRefusal = (env: NodeJS.ProcessEnv, pattern: RegExp): void => {
    let thrown: unknown
    try {
      select(env)
    } catch (e) {
      thrown = e
    }
    expect(thrown, "the selector fell back instead of refusing").toBeDefined()
    expect(String((thrown as Error).message)).toMatch(pattern)
  }

  test("a DATASET-REVISION mismatch is refused (never 'run everything')", () => {
    const manifest = named(buildFamily({ datasetRevision: "f".repeat(40) }), "PMX-7")
    // control: the manifest is internally valid — it verifies against its own digest
    expect(() =>
      selectProMaxSampleIds({
        manifestText: JSON.stringify(manifest),
        manifestPath: "m.json",
        availableInstanceIds: candidates().map((c) => c.instanceId),
        datasetRevision: "f".repeat(40),
        surface: "t",
      }),
    ).not.toThrow()
    // …and is refused against THIS build's frozen revision.
    expectRefusal(
      { [PROMAX_SAMPLE_ENV]: writeManifest(manifest) },
      /drawn from dataset revision f{40} but this build's frozen ProMax corpus is/,
    )
  })

  test("a HAND-EDITED id list is refused by the self-digest", () => {
    const manifest = named(buildFamily(), "PMX-7")
    const tampered = {
      ...manifest,
      instanceIds: [...manifest.instanceIds.slice(0, 6), "promax__python-2"],
    }
    expectRefusal({ [PROMAX_SAMPLE_ENV]: writeManifest(tampered) }, /does not match its own sha256/)
  })

  test("an id the loaded corpus does not contain is refused", () => {
    // A manifest drawn from a corpus with an extra instance: internally valid,
    // digest-clean, right revision — and still not the corpus that was loaded.
    const wider = buildProMaxSampleFamily({
      candidates: [...candidates(), { instanceId: "promax__ghost-9", language: "cobol" }],
      datasetRevision: REVISION,
      specs: [{ name: "PMX-8", quotas: {}, perLanguage: 1 }],
    })
    const manifest = named(wider, "PMX-8")
    expect(manifest.instanceIds).toContain("promax__ghost-9")
    expectRefusal(
      { [PROMAX_SAMPLE_ENV]: writeManifest(manifest, "PMX-8.manifest.json") },
      /names 1 instance\(s\) the loaded corpus does not contain: promax__ghost-9/,
    )
  })

  test("a manifest drawn by a DIFFERENT ordering algorithm is refused", () => {
    const manifest = named(
      buildProMaxSampleFamily({
        candidates: candidates(),
        datasetRevision: REVISION,
        algorithmVersion: "promax-sample/v2",
        specs: [{ name: "PMX-7", quotas: {}, perLanguage: 1 }],
      }),
      "PMX-7",
    )
    expectRefusal(
      { [PROMAX_SAMPLE_ENV]: writeManifest(manifest) },
      /drawn by ordering algorithm "promax-sample\/v2"/,
    )
  })

  test("an UNREADABLE manifest is refused, not silently ignored", () => {
    expectRefusal(
      { [PROMAX_SAMPLE_ENV]: "/nonexistent/dir/PMX-7.manifest.json" },
      /could not be read.*REFUSING to fall back to the whole corpus/s,
    )
  })

  test("a manifest AND --instance is a two-authority REFUSAL", () => {
    const path = writeManifest(named(buildFamily(), "PMX-7"))
    process.argv = ["bun", "bench", "--instance", "rust"]
    expect(() => select({ [PROMAX_SAMPLE_ENV]: path })).toThrow(DatasetSelectionConflictError)
  })

  test("PAIRED CONTROL — the refusals are the CHECKS, not a broken happy path", () => {
    // The same selector, same corpus, a good manifest ⇒ green. Without this every
    // assertion above would also pass if selection were simply always-throwing.
    const path = writeManifest(named(buildFamily(), "PMX-7"))
    expect(select({ [PROMAX_SAMPLE_ENV]: path })).toHaveLength(7)
  })

  test("the manifest parser rejects structurally broken input", () => {
    for (const text of ["not json", "[]", '{"name":"PMX-7"}', '{"instanceIds":[]}']) {
      expect(() =>
        selectProMaxSampleIds({
          manifestText: text,
          manifestPath: "m.json",
          availableInstanceIds: [],
          surface: "t",
        }),
      ).toThrow(ProMaxSampleError)
    }
  })
})

describe("G4 gate 3 — the ordering is byte-identical across regeneration", () => {
  test("regenerating the family reproduces the same ids, order and digest", () => {
    const a = named(buildFamily(), "PMX-7")
    const b = named(buildFamily(), "PMX-7")
    expect(b.instanceIds).toEqual([...a.instanceIds])
    expect(b.sha256).toBe(a.sha256)
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    // …and the SELECTOR reproduces the same sequence from the regenerated file.
    const first = select({ [PROMAX_SAMPLE_ENV]: writeManifest(a) }).map((r) => r.instanceId)
    const second = select({ [PROMAX_SAMPLE_ENV]: writeManifest(b) }).map((r) => r.instanceId)
    expect(second).toEqual(first)
  })

  test("PAIRED CONTROL — a different SEED really does move the sample", () => {
    // Proves the equality above is determinism, not a constant.
    const a = named(buildFamily(), "PMX-7")
    const other = named(buildFamily({ seed: "promax-v1-alt" }), "PMX-7")
    expect(other.sha256).not.toBe(a.sha256)
    expect(other.instanceIds).not.toEqual([...a.instanceIds])
    // …and the selector follows the manifest, not a cached order.
    expect(select({ [PROMAX_SAMPLE_ENV]: writeManifest(other) }).map((r) => r.instanceId)).toEqual([
      ...other.instanceIds,
    ])
  })
})
