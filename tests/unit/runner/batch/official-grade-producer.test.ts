/**
 * HELLGATE — residual debt #3: something must actually PRODUCE
 * `meta.officialGrade`.
 *
 * PMX-05 landed the totals type, the aggregation, the per-instance receipt, the
 * dashboard family view and the `BatchArtifactMeta.officialGrade` field — and no
 * writer at all. A ProMax report would therefore render an empty official-grade
 * section forever, and the covering-partition guard would never once run on real
 * campaign numbers.
 *
 * The gap had TWO halves, and both are closed here:
 *   • there was no document a grader phase could hand the report layer;
 *   • `run-main-helpers.writeArtifacts` NARROWED its `meta` parameter to five
 *     fields, so even a caller holding the section could not pass it through.
 *
 * OBSERVABLE: the REAL `writeArtifacts` → `buildReport` → `writeReport` chain,
 * and the persisted report JSON read back off disk. Nothing here re-asserts the
 * aggregator in isolation.
 *
 * ⚠️ LIVE-DATA: `writeReport` mirrors into the operator's bench results SSOT;
 * `tests/setup.ts` redirects `QUANTA_BENCH_RESULTS_DIR` for every test.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  OFFICIAL_GRADE_INGEST_ENV,
  resolveOfficialGradeReportInput,
} from "@/apps/bench/official-grade-ingest-source"
import { buildSwebenchArtifactMeta, writeArtifacts } from "@/apps/bench/run-main-helpers"
import type {
  OfficialGradeDisposition,
  OfficialGradeEvaluatorMeta,
} from "@/runner/batch/eval/official-grade"
import { buildOfficialGradeReceipt } from "@/runner/batch/eval/official-grade"
import {
  parseOfficialGradeIngestDocument,
  serializeOfficialGradeIngestDocument,
} from "@/runner/batch/official-grade-ingest"
import {
  assertOfficialGradeCoveringPartition,
  type OfficialGradeSection,
} from "@/runner/batch/report-official-grade"

const DIRS: string[] = []
afterAll(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true })
})
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "og-producer-"))
  DIRS.push(dir)
  return dir
}

const ARTIFACT = { path: "/box/pass_rate.json", sha256: "c".repeat(64), byteLength: 40 }

const EVALUATOR: OfficialGradeEvaluatorMeta = {
  evaluatorId: "swe-bench-promax",
  upstreamCommit: "77041028bc4e2135644b63b504aa961a68aafbb6",
  evaluatorPath: "/opt/quanta/promax/upstream/src/evaluation/test_run.py",
  evaluatorSha256: "d".repeat(64),
  argv: ["python", "test_run.py", "--workers", "1"],
  cwd: "/opt/quanta/promax/upstream",
  exitCode: 0,
  stdout: "",
  stderr: "",
  outputArtifact: ARTIFACT,
}

const disp = (
  instanceId: string,
  state: OfficialGradeDisposition["state"],
  reason: OfficialGradeDisposition["reason"],
): OfficialGradeDisposition => ({
  instanceId,
  state,
  reason,
  gradingValid: state === "resolved" || state === "model_miss",
  rawArtifact: ARTIFACT,
  evaluator: { passed: state === "resolved", model: null, golden: null },
})

/** Four assigned instances: one of each state — plus a FIFTH that is `missing`,
 *  so the covering partition has something to prove. */
const ASSIGNED = ["go-1", "go-2", "rust-1", "rust-2", "python-1"] as const
const DISPOSITIONS = [
  disp("go-1", "resolved", "official_resolved"),
  disp("go-2", "model_miss", "test_failed"),
  disp("rust-1", "infra_invalid", "golden_apply_failed"),
  disp("rust-2", "ambiguous", "upstream_need_human_review"),
]

const LANGUAGE_BY_ID: Record<string, string> = {
  "go-1": "go",
  "go-2": "go",
  "rust-1": "rust",
  "rust-2": "rust",
  "python-1": "python",
}

const receipt = () => {
  const built = buildOfficialGradeReceipt({
    assignedInstanceIds: [...ASSIGNED],
    dispositions: DISPOSITIONS,
    evaluator: EVALUATOR,
  })
  if (!built.ok) throw new Error(`fixture refused: ${JSON.stringify(built.failures)}`)
  return built.receipt
}

const ingestDocumentText = (over: { instanceMetaId?: string } = {}): string =>
  serializeOfficialGradeIngestDocument({
    receipt: receipt(),
    instanceMeta: new Map(
      ASSIGNED.map((id) => [
        over.instanceMetaId !== undefined && id === "go-1" ? over.instanceMetaId : id,
        {
          language: LANGUAGE_BY_ID[id],
          image: {
            sourceRef: `promax/${id}:latest`,
            registryDigest: `sha256:${"e".repeat(64)}`,
            localImageId: `sha256:${"f".repeat(64)}`,
            platform: "linux/amd64",
          },
        },
      ]),
    ),
    campaign: {
      quantaSha: "9".repeat(40),
      quantaDirty: false,
      provider: "openai",
      model: "gpt-5.4",
      preset: "agentless-v1",
      turnBudget: 60,
      runId: "promax-pmx7",
    },
  })

const parsedInput = (text = ingestDocumentText()) => {
  const parsed = parseOfficialGradeIngestDocument(JSON.parse(text))
  if (!parsed.ok) throw new Error(`ingest refused: ${JSON.stringify(parsed.failures)}`)
  return parsed.input
}

const writeAndReadReport = async (
  officialGrade: ReturnType<typeof parsedInput> | undefined,
): Promise<{ readonly officialGrade?: OfficialGradeSection } & Record<string, unknown>> => {
  const dir = scratch()
  const reportPath = join(dir, "report.json")
  await writeArtifacts(join(dir, "predictions.jsonl"), reportPath, [], {
    provider: "openai",
    model: "gpt-5.4",
    n: 1,
    datasetFamily: "promax",
    ...(officialGrade !== undefined ? { officialGrade } : {}),
  })
  return JSON.parse(readFileSync(reportPath, "utf8")) as {
    readonly officialGrade?: OfficialGradeSection
  } & Record<string, unknown>
}

describe("END-TO-END — receipt document → writeArtifacts → persisted totals", () => {
  test("the persisted section is a covering partition with all three rates adjacent", async () => {
    const report = await writeAndReadReport(parsedInput())
    const section = report.officialGrade
    expect(section).toBeDefined()
    if (section === undefined) throw new Error("unreachable")

    const t = section.totals
    expect(t.assigned).toBe(5)
    expect(t.resolved + t.model_miss + t.infra_invalid + t.ambiguous + t.missing).toBe(t.assigned)
    expect(t.missing).toBe(1)
    expect(section.missing_instance_ids).toEqual(["python-1"])
    // Rates present TOGETHER — a flattered valid rate can never appear alone.
    expect(t.official_valid_rate).toBeCloseTo(1 / 2, 12)
    expect(t.coverage).toBeCloseTo(2 / 5, 12)
    expect(t.raw_rate).toBeCloseTo(1 / 5, 12)
    // …and the guard itself accepts what was written (it also runs at decode).
    expect(() => assertOfficialGradeCoveringPartition(t)).not.toThrow()
  })

  test("per-language rows carry the language — INCLUDING the missing row's", async () => {
    const report = await writeAndReadReport(parsedInput())
    const byLanguage = report.officialGrade?.totals.by_language ?? {}
    expect(Object.keys(byLanguage).sort()).toEqual(["go", "python", "rust"])
    expect(byLanguage.go?.resolved).toBe(1)
    expect(byLanguage.rust?.infra_invalid).toBe(1)
    // the never-graded instance is NOT quietly excluded from its language
    expect(byLanguage.python?.assigned).toBe(1)
    expect(byLanguage.python?.missing).toBe(1)
    // "measured, and nothing was validly graded" (coverage 0/1) is a DIFFERENT
    // claim from "there was no denominator" (valid rate null) — both are said.
    expect(byLanguage.python?.coverage).toBe(0)
    expect(byLanguage.python?.official_valid_rate).toBeNull()
  })

  test("per-instance receipts carry image + evaluator provenance verbatim", async () => {
    const report = await writeAndReadReport(parsedInput())
    const row = (report.officialGrade?.instances ?? []).find((i) => i.instance_id === "go-1")
    expect(row?.image?.registry_digest).toBe(`sha256:${"e".repeat(64)}`)
    expect(row?.image?.platform).toBe("linux/amd64")
    expect(row?.evaluator.upstream_commit).toBe(EVALUATOR.upstreamCommit)
    expect(row?.reason).toBe("official_resolved")
  })

  test("BYTE-IDENTICAL CONTROL — no section ⇒ the key is absent from the report", async () => {
    const report = await writeAndReadReport(undefined)
    expect("officialGrade" in report).toBe(false)
    expect(JSON.stringify(report)).not.toContain("officialGrade")
  })
})

describe("the ingest document fails closed", () => {
  const failures = (value: unknown): readonly string[] => {
    const parsed = parseOfficialGradeIngestDocument(value)
    if (parsed.ok) throw new Error("expected a refusal")
    return parsed.failures.map((f) => f.code)
  }

  test("instance metadata for an UNASSIGNED id is refused", () => {
    expect(
      failures(JSON.parse(ingestDocumentText({ instanceMetaId: "not-in-the-campaign" }))),
    ).toContain("instance_meta_unassigned")
  })

  test("a drifted receipt (unknown state) is refused by the PMX-03 parser", () => {
    const doc = JSON.parse(ingestDocumentText()) as {
      receipt: { dispositions: Record<string, unknown>[] }
    }
    const first = doc.receipt.dispositions[0]
    if (first === undefined) throw new Error("fixture")
    first.state = "flaky"
    expect(failures(doc)).toContain("receipt_rejected")
  })

  test("campaign identity without a quanta sha is refused", () => {
    const doc = JSON.parse(ingestDocumentText()) as { campaign: Record<string, unknown> }
    doc.campaign.quantaSha = ""
    expect(failures(doc)).toContain("campaign_meta_invalid")
  })

  test("a future schema version is refused rather than half-read", () => {
    const doc = JSON.parse(ingestDocumentText()) as { schema_version: number }
    doc.schema_version = 99
    expect(failures(doc)).toContain("schema_version_unsupported")
  })

  test("non-object garbage is refused", () => {
    expect(failures("not a document")).toContain("document_unparseable")
    expect(failures(null)).toContain("document_unparseable")
  })
})

describe("the SWE composition root's artifact meta", () => {
  const metaFor = (env: NodeJS.ProcessEnv) =>
    buildSwebenchArtifactMeta({
      provider: "openai",
      model: "gpt-5.4",
      n: 1,
      datasetFamily: "promax",
      env,
    })

  test("the root composes the section and the REAL writer persists it", async () => {
    const path = join(scratch(), "official-grade.json")
    writeFileSync(path, ingestDocumentText())
    const meta = metaFor({ [OFFICIAL_GRADE_INGEST_ENV]: path })
    expect(meta.officialGrade).toBeDefined()

    const dir = scratch()
    const reportPath = join(dir, "report.json")
    await writeArtifacts(join(dir, "predictions.jsonl"), reportPath, [], meta)
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      officialGrade?: OfficialGradeSection
    }
    expect(report.officialGrade?.totals.assigned).toBe(5)
    expect(report.officialGrade?.missing_instance_ids).toEqual(["python-1"])
  })

  test("PAIRED CONTROL — same root, no grader document ⇒ the field is OMITTED", () => {
    const meta = metaFor({})
    expect("officialGrade" in meta).toBe(false)
    expect(meta.datasetFamily).toBe("promax")
  })

  test("the root FAILS CLOSED on a named-but-broken document", () => {
    expect(() => metaFor({ [OFFICIAL_GRADE_INGEST_ENV]: "/nonexistent/og.json" })).toThrow(
      /official-grade/i,
    )
  })
})

describe("the composition-root source", () => {
  const withEnv = <T>(value: string | undefined, fn: () => T): T => {
    const before = process.env[OFFICIAL_GRADE_INGEST_ENV]
    if (value === undefined) delete process.env[OFFICIAL_GRADE_INGEST_ENV]
    else process.env[OFFICIAL_GRADE_INGEST_ENV] = value
    try {
      return fn()
    } finally {
      if (before === undefined) delete process.env[OFFICIAL_GRADE_INGEST_ENV]
      else process.env[OFFICIAL_GRADE_INGEST_ENV] = before
    }
  }

  test("absent ⇒ undefined (the byte-identical default for every family)", () => {
    withEnv(undefined, () => {
      expect(resolveOfficialGradeReportInput(process.env)).toBeUndefined()
    })
  })

  test("present + valid ⇒ the aggregation input, with the receipt intact", () => {
    const path = join(scratch(), "official-grade.json")
    writeFileSync(path, ingestDocumentText())
    withEnv(path, () => {
      const input = resolveOfficialGradeReportInput(process.env)
      expect(input?.receipt.assignedInstanceIds).toEqual([...ASSIGNED])
      expect(input?.campaign.model).toBe("gpt-5.4")
    })
  })

  test("present + BROKEN ⇒ THROWS — never a silently-omitted section", () => {
    const path = join(scratch(), "broken.json")
    writeFileSync(path, "{ not json")
    withEnv(path, () => {
      expect(() => resolveOfficialGradeReportInput(process.env)).toThrow(/official-grade/i)
    })
    withEnv("/nonexistent/official-grade.json", () => {
      expect(() => resolveOfficialGradeReportInput(process.env)).toThrow(/official-grade/i)
    })
  })
})
