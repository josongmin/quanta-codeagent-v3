/**
 * PMX-02 — the ProMax corpus adapter and the two-artifact NO-LEAK boundary.
 *
 * What this file proves, against REAL module behavior (no source scanning):
 *  1. the OFFICIAL JSON-array corpus decodes (the JSONL reader sees zero rows in
 *     it), all seven language counts match, and every malformed-corpus mode the
 *     ticket names is REFUSED;
 *  2. trusted preparation emits TWO artifacts and the agent-side one carries
 *     none of `patch` / `test_patch` / `eval_script` / `image_name` / golden
 *     output — asserted on the SERIALIZED bytes, not on a field-by-field peek;
 *  3. the agent-side task type is NARROW: it has no `raw` escape hatch, and the
 *     runner `Instance` built from it carries no `goldPatch` / test patch / eval
 *     script and no path to the grader bundle;
 *  4. the grader resolves all 170 private views by instanceId from a bundle that
 *     lives outside the agent root.
 */
import { describe, expect, test } from "bun:test"
import {
  buildProMaxArtifacts,
  decodeProMaxOfficialCorpus,
  openProMaxGraderBundle,
  PROMAX_PUBLIC_TASKS_FILE,
  parseProMaxPublicTasksArtifact,
  readProMaxPublicTasks,
  serializeProMaxGraderBundle,
  serializeProMaxPublicTasks,
} from "@/apps/bench/promax/corpus"
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance"
import { publicTaskToInstance } from "@/runner/batch/corpus/public-task"
import {
  buildSyntheticProMaxCorpus,
  EVAL_SCRIPT_MARKER,
  GOLD_PATCH_MARKER,
  GOLD_TEST_PATCH_MARKER,
  PROMAX_LANGUAGE_COUNTS,
} from "./promax-corpus-fixture"

const SOURCE = {
  manifestSha256: "f".repeat(64),
  upstreamGitCommit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
  hfDatasetRevision: PROMAX_V1_SNAPSHOT.hf_dataset_revision,
  datasetSha256: PROMAX_V1_SNAPSHOT.dataset_sha256,
  evalSha256: PROMAX_V1_SNAPSHOT.eval_sha256,
} as const

const decodeOrThrow = (corpus: { datasetText: string; evalText: string }) => {
  const decoded = decodeProMaxOfficialCorpus(corpus)
  if (!decoded.ok) throw new Error(`expected ok, got: ${decoded.failures.map((f) => f.code)}`)
  return decoded
}

describe("PMX-02 — the OFFICIAL JSON array decodes (the JSONL reader cannot)", () => {
  const corpus = buildSyntheticProMaxCorpus()

  test("170 records load from the official JSON-ARRAY shape", () => {
    const decoded = decodeOrThrow(corpus)
    expect(decoded.agentTasks).toHaveLength(170)
    expect(decoded.graderTasks).toHaveLength(170)
    // KNOWN-ITEM FLOOR: the ids are the real fixture ids, in dataset order.
    expect(decoded.instanceIds).toEqual(corpus.instanceIds)
    expect(decoded.instanceIds[0]).toBe(corpus.instanceIds[0])
  })

  test("PAIRED CONTROL — the JSONL-only reader really does see ZERO rows in it", async () => {
    const { parseSwebenchJsonl } = await import("@/runner/batch/corpus/dataset")
    expect(parseSwebenchJsonl(corpus.datasetText)).toHaveLength(0)
  })

  test("all seven language counts match the manifest", () => {
    const decoded = decodeOrThrow(corpus)
    expect(decoded.languageCounts).toEqual(PROMAX_LANGUAGE_COUNTS)
    expect(Object.values(decoded.languageCounts).reduce((a, b) => a + b, 0)).toBe(170)
    // and the agent views carry the SAME language distribution
    const observed: Record<string, number> = {}
    for (const task of decoded.agentTasks)
      observed[task.language] = (observed[task.language] ?? 0) + 1
    expect(observed).toEqual(PROMAX_LANGUAGE_COUNTS)
  })

  test("upstream SHAPE facts a naive reader breaks on are tolerated", () => {
    const decoded = decodeOrThrow(corpus)
    // `created_at` is an INTEGER and rows are NOT key-uniform — a decoder that
    // required a string date, or required `pull_number`/`issue_numbers`, would
    // reject the real corpus. The fixture reproduces both.
    const withPull = corpus.rows.filter((r) => r.pull_number !== undefined).length
    const withIssues = corpus.rows.filter((r) => r.issue_numbers !== undefined).length
    expect(withPull).toBeGreaterThan(0)
    expect(withPull).toBeLessThan(corpus.rows.length)
    expect(withIssues).toBeGreaterThan(0)
    expect(withIssues).toBeLessThan(withPull)
    expect(typeof corpus.rows[0]?.created_at).toBe("number")
    expect(decoded.agentTasks).toHaveLength(170)
  })
})

describe("PMX-02 — malformed corpora are REFUSED (fail-closed)", () => {
  const failureCodes = (mutate: Parameters<typeof buildSyntheticProMaxCorpus>[1]): string[] => {
    const corpus = buildSyntheticProMaxCorpus(PROMAX_LANGUAGE_COUNTS, mutate)
    const decoded = decodeProMaxOfficialCorpus(corpus)
    if (decoded.ok) return []
    return decoded.failures.map((f) => f.code)
  }

  test("a data/eval ID-set mismatch fails (both directions)", () => {
    expect(
      failureCodes((_rows, evalMap) => {
        delete evalMap["promax__c-001"]
      }),
    ).toContain("id_set_unequal")
    expect(
      failureCodes((_rows, evalMap) => {
        evalMap["promax__ghost-999"] = { instance_id: "promax__ghost-999", eval_script: "x" }
      }),
    ).toContain("id_set_unequal")
  })

  test("a duplicate instance id fails", () => {
    const codes = failureCodes((rows) => {
      rows.push({ ...rows[0] })
    })
    expect(codes).toContain("instance_id_duplicated")
  })

  test("a missing image fails — absent, null, AND blank", () => {
    for (const bad of [undefined, null, "", "   "]) {
      const codes = failureCodes((rows) => {
        const row = rows[0]
        if (row === undefined) return
        if (bad === undefined) delete row.image_name
        else row.image_name = bad
      })
      expect(codes, `image_name=${JSON.stringify(bad)} must be refused`).toContain(
        "dataset_field_invalid",
      )
    }
  })

  test("an empty eval script fails — absent, blank, AND whitespace-only", () => {
    for (const bad of [undefined, "", "   \n"]) {
      const codes = failureCodes((_rows, evalMap) => {
        const record = evalMap["promax__c-001"] as Record<string, unknown>
        if (bad === undefined) delete record.eval_script
        else record.eval_script = bad
      })
      expect(codes, `eval_script=${JSON.stringify(bad)} must be refused`).toContain(
        "eval_script_missing",
      )
    }
  })

  test("PAIRED CONTROL — the untouched fixture is accepted, so the refusals discriminate", () => {
    expect(decodeProMaxOfficialCorpus(buildSyntheticProMaxCorpus()).ok).toBe(true)
  })

  test("a refusal never echoes a gold body", () => {
    const corpus = buildSyntheticProMaxCorpus(PROMAX_LANGUAGE_COUNTS, (rows) => {
      const row = rows[0]
      if (row !== undefined) row.image_name = ""
    })
    const decoded = decodeProMaxOfficialCorpus(corpus)
    expect(decoded.ok).toBe(false)
    const text = JSON.stringify(decoded)
    expect(text).not.toContain(GOLD_PATCH_MARKER)
    expect(text).not.toContain(GOLD_TEST_PATCH_MARKER)
    expect(text).not.toContain(EVAL_SCRIPT_MARKER)
  })
})

describe("PMX-02 — the two-artifact runtime boundary", () => {
  const corpus = buildSyntheticProMaxCorpus()
  const built = buildProMaxArtifacts({ ...decodeOrThrow(corpus), source: SOURCE })

  test("the SERIALIZED agent artifact contains no grader-only material at all", () => {
    const bytes = serializeProMaxPublicTasks(built.publicTasks)
    for (const marker of [GOLD_PATCH_MARKER, GOLD_TEST_PATCH_MARKER, EVAL_SCRIPT_MARKER]) {
      expect(bytes).not.toContain(marker)
    }
    for (const key of [
      "patch",
      "test_patch",
      "testPatch",
      "eval_script",
      "evalScript",
      "image_name",
      "imageName",
      "golden",
    ]) {
      expect(bytes, `agent artifact leaked \`${key}\``).not.toContain(`"${key}"`)
    }
    // KNOWN-ITEM FLOOR — it really is the ProMax corpus, not an empty file.
    expect(bytes).toContain(corpus.instanceIds[0] ?? "@@none@@")
    expect(bytes).toContain("problemStatement")
  })

  test("the grader artifact carries EXACTLY the grader-only view for all 170", () => {
    const bytes = serializeProMaxGraderBundle(built.graderBundle)
    expect(built.graderBundle.tasks).toHaveLength(170)
    expect(bytes).toContain(GOLD_PATCH_MARKER)
    expect(bytes).toContain(GOLD_TEST_PATCH_MARKER)
    expect(bytes).toContain(EVAL_SCRIPT_MARKER)
    const first = built.graderBundle.tasks[0]
    expect(first?.imageName).toBeTruthy()
    expect(first?.workingDir).toBeTruthy()
    expect(first?.environmentSetupCommit).toHaveLength(40)
  })

  test("both artifacts carry source-manifest AND content digests", () => {
    for (const artifact of [built.publicTasks, built.graderBundle] as const) {
      expect(artifact.source.manifestSha256).toBe(SOURCE.manifestSha256)
      expect(artifact.source.upstreamGitCommit).toBe(SOURCE.upstreamGitCommit)
      expect(artifact.contentSha256).toMatch(/^[0-9a-f]{64}$/)
    }
    // the two content digests are DIFFERENT (they are different payloads)
    expect(built.publicTasks.contentSha256).not.toBe(built.graderBundle.contentSha256)
  })

  test("re-preparing the same bytes is BYTE-IDENTICAL", () => {
    const again = buildProMaxArtifacts({ ...decodeOrThrow(corpus), source: SOURCE })
    expect(serializeProMaxPublicTasks(again.publicTasks)).toBe(
      serializeProMaxPublicTasks(built.publicTasks),
    )
    expect(serializeProMaxGraderBundle(again.graderBundle)).toBe(
      serializeProMaxGraderBundle(built.graderBundle),
    )
  })

  test("a TAMPERED public artifact is refused on read (content digest)", () => {
    const bytes = serializeProMaxPublicTasks(built.publicTasks)
    const tampered = bytes.replace(`${corpus.instanceIds[0]}`, `${corpus.instanceIds[0]}-tampered`)
    expect(() => parseProMaxPublicTasksArtifact(tampered)).toThrow(/digest/i)
    // PAIRED CONTROL — the untampered bytes round-trip.
    expect(parseProMaxPublicTasksArtifact(bytes).tasks).toHaveLength(170)
  })

  test("the grader bundle resolves every private view BY instanceId", () => {
    const bundle = openProMaxGraderBundle(serializeProMaxGraderBundle(built.graderBundle))
    for (const id of corpus.instanceIds) {
      const view = bundle.resolve(id)
      expect(view.instanceId).toBe(id)
      expect(view.patch).toContain(GOLD_PATCH_MARKER)
      expect(view.evalScript).toContain(EVAL_SCRIPT_MARKER)
    }
    expect(() => bundle.resolve("promax__nope-000")).toThrow(/promax__nope-000/)
  })
})

describe("PMX-02 — the agent-side type is NARROW (no raw escape hatch)", () => {
  const corpus = buildSyntheticProMaxCorpus()
  const built = buildProMaxArtifacts({ ...decodeOrThrow(corpus), source: SOURCE })
  const tasks = built.publicTasks.tasks

  test("no public task exposes a broad `raw`/row object", () => {
    // ALL 170, not a sample: a projection that widens for one row shape (e.g.
    // only the rows that carry `pull_number`) would slip past a head-of-list peek.
    expect(tasks).toHaveLength(170)
    for (const task of tasks) {
      expect(Object.keys(task).sort()).toEqual([
        "baseCommit",
        "instanceId",
        "language",
        "problemStatement",
        "repo",
      ])
      const opaque = task as unknown as Record<string, unknown>
      expect(opaque.raw).toBeUndefined()
      expect(opaque.row).toBeUndefined()
      expect(opaque.graderBundlePath).toBeUndefined()
    }
  })

  test("the runner Instance built from a public task carries NO gold", () => {
    const first = tasks[0]
    if (first === undefined) throw new Error("fixture produced no tasks")
    const instance = publicTaskToInstance(first, "/tmp/repo")
    expect(instance.goldPatch).toBeUndefined()
    const serialized = JSON.stringify(instance)
    for (const marker of [GOLD_PATCH_MARKER, GOLD_TEST_PATCH_MARKER, EVAL_SCRIPT_MARKER]) {
      expect(serialized).not.toContain(marker)
    }
    // and NOTHING synthesized a local test command out of hidden eval metadata
    expect(instance.testCmd).toBe("true")
    // KNOWN-ITEM FLOOR — the instance is real, and carries the PUBLIC metadata
    expect(instance.id).toBe(first.instanceId)
    expect(instance.problemStatement).toContain("PROBLEM")
    expect(instance.swebench?.repo).toBe(first.repo)
    expect(instance.swebench?.baseCommit).toBe(first.baseCommit)
  })

  test("the agent-side READER accepts the public artifact and knows nothing of a bundle", () => {
    const bytes = serializeProMaxPublicTasks(built.publicTasks)
    const rows = readProMaxPublicTasks(bytes)
    expect(rows).toHaveLength(170)
    expect(PROMAX_PUBLIC_TASKS_FILE).toBe("public-tasks.json")
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain("grader")
    expect(serialized).not.toContain(GOLD_PATCH_MARKER)
  })
})
