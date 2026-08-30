/**
 * PMX-06 — THE GATES MUST ACTUALLY GATE, ON THE DEFAULT PRODUCTION PATH.
 *
 * An adversarial audit proved the staged gates admitted the most expensive run
 * in the packet on essentially no evidence:
 *
 *  G-A  gate 6 admitted a Full-170 whose evaluator reported on 1 of 170 rows
 *       (169 `missing`) while publishing a 100% valid rate.
 *  G-B  gate 6 REQUIRED `ProMaxModelStageEvidence` (preset, model, delivered
 *       reasoning effort, leakage checks) and read NONE of it.
 *  G-C  gate 4's continuation number — the one that authorizes the Full-170
 *       spend — was computed entirely from caller-supplied `rows`, never
 *       reconciled against the arm's own official-grade receipt.
 *  G-D  gate 4's "same images" clause compared `undefined === undefined` when
 *       BOTH freezes omitted an instance, and gate 4 never ran the freeze
 *       readiness assertion at all.
 *
 * ⚠️ EVERY case below is driven through {@link runProMaxCampaignCli} — the same
 * entry point `tools/bench-promax/campaign-gates.ts` binds — over artefact BYTES
 * written to a temp dir. Nothing here constructs a gate input by hand, so a
 * clause that only fires on a hand-built object cannot make this file green.
 *
 * ⚠️ SPEND SAFETY: the CLI has three ports (read, write, log). No process port,
 * no Docker, no network, no `~/.quanta` write.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProMaxImageFreezeReceipt, ProMaxImageRecord } from "@/apps/bench/harness/promax"
import { buildProMaxOfficialGradeReceipt } from "@/apps/bench/harness/promax"
import {
  type CampaignCliPorts,
  type FreezeProMaxCampaignInput,
  freezeProMaxCampaignRecord,
  PROMAX_LEAKAGE_CHECK_IDS,
  PROMAX_OWNER_AUDIT_BASELINE,
  type ProMaxFrozenCampaignRecord,
  runProMaxCampaignCli,
  serializeProMaxCampaignRecord,
} from "@/apps/bench/promax/campaign"
import { buildProMaxSampleFamily, canonicalJson } from "@/apps/bench/promax/corpus"
import { PROMAX_V1_SNAPSHOT, sha256Hex } from "@/apps/bench/promax/provenance"
import { serializeOfficialGradeReceipt } from "@/runner/batch/eval/official-grade"
import { buildSyntheticProMaxCorpus } from "./promax-corpus-fixture"
import {
  evaluatorIdentity,
  OUTPUT_PATH,
  officialDocument,
  officialRow,
  type RowSpec,
} from "./promax-official-fixtures"

const REPO = join(import.meta.dir, "..", "..", "..", "..", "..")
const DIR = mkdtempSync(join(tmpdir(), "pmx06-teeth-"))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

const CORPUS = buildSyntheticProMaxCorpus()
const SAMPLES = buildProMaxSampleFamily({
  candidates: CORPUS.rows.map((row) => ({
    instanceId: String(row.instance_id),
    language: String(row.language),
  })),
  datasetRevision: PROMAX_V1_SNAPSHOT.hf_dataset_revision,
})
const sample = (name: string): readonly string[] =>
  SAMPLES.find((s) => s.name === name)?.instanceIds ?? []
const PMX40 = sample("PMX-40")
const PMX170 = sample("PMX-170")

const CAMPAIGN_ID = "pmx-teeth-2026-08-22"
const FROZEN_AT = "2026-08-22T00:00:00.000Z"
const OBSERVED_AT = "2026-08-23T00:00:00.000Z"
const BUDGETS = { maxTurns: 40, maxTokens: 400_000, wallClockMs: 1_800_000 } as const

const input = (): FreezeProMaxCampaignInput => ({
  campaignId: CAMPAIGN_ID,
  frozenAt: FROZEN_AT,
  quanta: { sha: "b".repeat(40), dirty: false },
  upstream: PROMAX_V1_SNAPSHOT,
  samples: SAMPLES,
  arms: [
    { role: "control", name: "control-v1", preset: "agentless-v1", knobs: { lsp: "1" } },
    {
      role: "candidate",
      name: "candidate-v1",
      preset: "agentless-v1",
      knobs: { lsp: "1", subagent: "1" },
    },
  ],
  model: {
    provider: "openai",
    model: "gpt-5.4",
    surface: "openai-responses",
    reasoningEffortRequested: "high",
  },
  budgets: { ...BUDGETS },
  concurrency: { patchGeneration: 4, grading: 1 },
  continuationRule: {
    declaredAt: "2026-08-21T00:00:00.000Z",
    text: "continue only on +3 resolved for at most +$40",
    minPairedInstances: 40,
    minResolvedDelta: 3,
    maxCostUsdDelta: 40,
  },
  retryPolicy: { maxChunkAttempts: 2, exhaustedDisposition: "missing", maxUngradedAssigned: 0 },
  exceptionPolicy: {
    manifestVersion: 1,
    requiresOwner: true,
    requiresUpstreamReference: true,
    deletesFromAssigned: false,
  },
  ownerAudit: {
    ok: true,
    digest: "c".repeat(64),
    unclassified: [],
    baseline: PROMAX_OWNER_AUDIT_BASELINE,
    final: { ...PROMAX_OWNER_AUDIT_BASELINE },
  },
})

const RECORD: ProMaxFrozenCampaignRecord = (() => {
  const r = freezeProMaxCampaignRecord(input())
  if (!r.ok) throw new Error(`fixture gap: ${r.failures.map((f) => f.code).join(", ")}`)
  return r.record
})()

// ── artefact builders (bytes, never gate inputs) ────────────────────────────

const receiptOf = (specs: readonly RowSpec[], assigned: readonly string[]) => {
  const r = buildProMaxOfficialGradeReceipt({
    assignedInstanceIds: assigned,
    evaluator: evaluatorIdentity(),
    run: {
      exitCode: 0,
      stdout: "",
      stderr: "",
      outputJsonText: officialDocument(specs.map(officialRow)),
      outputPath: OUTPUT_PATH,
    },
  })
  if (!r.ok) throw new Error(`fixture gap: ${r.failures.map((f) => f.code).join(",")}`)
  return r.receipt
}

/** `resolvedCount` resolve; the rest are honest misses. Reports on ALL of `ids`. */
const modelReceipt = (ids: readonly string[], resolvedCount: number) =>
  receiptOf(
    ids.map((instanceId, i) => ({
      instanceId,
      golden: "success",
      model: i < resolvedCount ? "success" : "non zero exit",
    })),
    ids,
  )

const imageRecord = (instanceId: string, i: number): ProMaxImageRecord => ({
  instance_id: instanceId,
  source_image_name: `swebench-promax/${instanceId}:v1`,
  registry_repo_digest: `swebench-promax/${instanceId}@sha256:${i.toString(16).padStart(4, "0")}${"a".repeat(60)}`,
  local_image_id: `sha256:${i.toString(16).padStart(4, "0")}${"b".repeat(60)}`,
  os: "linux",
  architecture: "amd64",
  resolved_at: FROZEN_AT,
})

const imageFreeze = (ids: readonly string[]): ProMaxImageFreezeReceipt => ({
  receipt_version: 1,
  campaign_id: CAMPAIGN_ID,
  upstream_git_commit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
  required_platform: { os: "linux", architecture: "amd64" },
  golden_source: { path: "/campaign/golden-source.json", sha256: "d".repeat(64) },
  golden_derived: { path: "/campaign/campaign-golden.json", sha256: "e".repeat(64) },
  images: ids.map(imageRecord),
  faults: [],
  ok: true,
})

type Json = Record<string, unknown>

const modelEvidenceDoc = (
  ids: readonly string[],
  receipt: ReturnType<typeof receiptOf>,
  patch: Json = {},
): Json => ({
  frozenRecordSha256: RECORD.sha256,
  observedAt: OBSERVED_AT,
  quanta: { sha: RECORD.quanta.sha, dirty: false },
  receipt: JSON.parse(serializeOfficialGradeReceipt(receipt)) as unknown,
  imageFreeze: imageFreeze(ids),
  arm: {
    role: "control",
    name: "control-v1",
    resolvedKnobsSha256: sha256Hex(canonicalJson(RECORD.arms[0]?.knobs ?? {})),
  },
  preset: "agentless-v1",
  model: { provider: "openai", model: "gpt-5.4", reasoningEffortDelivered: "high" },
  budgets: { ...BUDGETS },
  leakageChecks: [...PROMAX_LEAKAGE_CHECK_IDS],
  ...patch,
})

/** Gates 1-5 as WRITTEN result receipts — exactly what `--prior` reads. */
const PRIORS_OK: readonly Json[] = [
  { gate: "gate1_pmx7_gold", ok: true, failures: [] },
  { gate: "gate2_pmx7_model", ok: true, failures: [] },
  { gate: "gate3_pmx14_canary", ok: true, failures: [] },
  {
    gate: "gate4_pmx40_paired",
    ok: true,
    failures: [],
    continuation: { pairedInstances: 40, resolvedDelta: 4, costUsdDelta: 8, continue: true },
  },
  { gate: "gate5_pmx170_gold", ok: true, failures: [] },
]

const chunksOf = (ids: readonly string[], size: number): Json[] => {
  const out: Json[] = []
  for (let i = 0; i < ids.length; i += size) {
    out.push({
      chunkId: `chunk-${out.length}`,
      assignedInstanceIds: ids.slice(i, i + size),
      attempts: 1,
      delivered: true,
    })
  }
  return out
}

// ── the CLI, over bytes ─────────────────────────────────────────────────────

let seq = 0
const write = (name: string, value: unknown): string => {
  seq += 1
  const path = join(DIR, `${seq}-${name}`)
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`)
  return path
}

const RECORD_PATH = write("campaign-record.json", serializeProMaxCampaignRecord(RECORD))
const PRIOR_PATH = write("priors.json", PRIORS_OK)

interface CliRun {
  readonly code: number
  readonly log: string
}

const runCli = (argv: readonly string[]): CliRun => {
  const lines: string[] = []
  const ports: CampaignCliPorts = {
    repoRoot: REPO,
    readFile: (path: string) => readFileSync(path, "utf8"),
    writeFile: (path: string, text: string) => writeFileSync(path, text),
    log: (line: string) => lines.push(line),
  }
  return { code: runProMaxCampaignCli(argv, ports), log: lines.join("\n") }
}

/** Gate 6, from bytes, with gates 1-5 already recorded as passing. */
/** A campaign record identical to {@link RECORD} except that it DECLARES how many
 *  assigned rows it will accept finishing without a grade. The tolerance has no
 *  default anywhere in production — the campaign must state it — so a test that
 *  wants an attributed loss admitted has to state it too.
 *
 *  RE-FROZEN, never hand-edited: the record is content-addressed and the evidence
 *  cites its digest, so patching the JSON would be refused as a tampered record
 *  (which is itself the behaviour `promax-campaign-fail-closed` pins). */
const budgetedRecord = (maxUngradedAssigned: number): ProMaxFrozenCampaignRecord => {
  const base = input()
  const r = freezeProMaxCampaignRecord({
    ...base,
    retryPolicy: { ...base.retryPolicy, maxUngradedAssigned },
  })
  if (!r.ok) throw new Error(`fixture gap: ${r.failures.map((f) => f.code).join(", ")}`)
  return r.record
}

const budgetedRecordPath = (record: ProMaxFrozenCampaignRecord): string =>
  write(
    `campaign-record-ungraded-${record.retry_policy.maxUngradedAssigned}.json`,
    serializeProMaxCampaignRecord(record),
  )

const gate6 = (name: string, evidence: Json, recordPath = RECORD_PATH): CliRun =>
  runCli([
    "gate",
    "--gate",
    "gate6_pmx170_model",
    "--record",
    recordPath,
    "--evidence",
    write(`${name}.json`, evidence),
    "--prior",
    PRIOR_PATH,
  ])

const gate4 = (name: string, control: Json, candidate: Json): CliRun =>
  runCli([
    "gate",
    "--gate",
    "gate4_pmx40_paired",
    "--record",
    RECORD_PATH,
    "--evidence",
    write(`${name}.json`, { control, candidate }),
  ])

// ── the healthy baselines (the PAIRED CONTROL for every refusal below) ──────

const HEALTHY_FULL = (): Json =>
  modelEvidenceDoc(PMX170, modelReceipt(PMX170, 60), { chunks: chunksOf(PMX170, 20) })

const armDoc = (
  armName: string,
  resolvedCount: number,
  costEach: number,
  patch: Json = {},
): Json => ({
  armName,
  preset: "agentless-v1",
  evidence: modelEvidenceDoc(PMX40, modelReceipt(PMX40, resolvedCount), {
    arm: {
      role: armName === "candidate-v1" ? "candidate" : "control",
      name: armName,
      resolvedKnobsSha256: sha256Hex(
        canonicalJson(
          RECORD.arms.find((arm) => arm.name === armName)?.knobs ?? RECORD.arms[0]?.knobs ?? {},
        ),
      ),
    },
  }),
  rows: PMX40.map((instanceId, i) => ({
    instanceId,
    state: i < resolvedCount ? "resolved" : "model_miss",
    costUsd: costEach,
    turns: 12,
    wallMs: 60_000,
  })),
  ...patch,
})

describe("PMX-06 baselines — the healthy runs still PASS (no gate is refusing everything)", () => {
  test("gate 6 admits a complete, clean Full-170", () => {
    const run = gate6("healthy-full", HEALTHY_FULL())
    expect({ code: run.code, log: run.log }).toEqual({ code: 0, log: run.log })
  })

  test("gate 4 admits a healthy paired PMX-40 and says continue", () => {
    const run = gate4(
      "healthy-paired",
      armDoc("control-v1", 10, 1),
      armDoc("candidate-v1", 14, 1.2),
    )
    expect({ code: run.code, log: run.log }).toEqual({ code: 0, log: run.log })
    expect(run.log).toContain("continue=true")
  })

  test("gate 4 REFUSES a candidate wrapper carrying the control's same-preset knob identity", () => {
    const candidate = armDoc("candidate-v1", 14, 1.2)
    const swapped: Json = {
      ...candidate,
      evidence: {
        ...(candidate.evidence as Json),
        arm: {
          role: "control",
          name: "control-v1",
          resolvedKnobsSha256: sha256Hex(canonicalJson(RECORD.arms[0]?.knobs ?? {})),
        },
      },
    }
    const run = gate4("same-preset-swapped-arm-identity", armDoc("control-v1", 10, 1), swapped)
    expect(run.code).not.toBe(0)
    expect(run.log).toContain("paired_config_mismatch")
  })
})

// ── G-A ─────────────────────────────────────────────────────────────────────

describe("G-A — gate 6 refuses a Full-170 whose coverage collapsed", () => {
  test("REFUSES 1-of-170 reported (169 missing) even though the valid rate is 100%", () => {
    const oneRow = receiptOf(
      [{ instanceId: String(PMX170[0]), golden: "success", model: "success" }],
      PMX170,
    )
    const run = gate6(
      "one-of-170",
      modelEvidenceDoc(PMX170, oneRow, { chunks: chunksOf(PMX170, 20) }),
    )
    expect(run.code).not.toBe(0)
    expect(run.log).toContain("attempt_incomplete")
    // the coverage LOSS is visible in the receipt, not hidden behind the rate
    expect(run.log).toMatch(/missing=169/)
    expect(run.log).toMatch(/valid=1\b/)
  })

  test("a lost chunk that was retried to exhaustion is still ADMITTED, rows left missing", () => {
    const delivered = PMX170.slice(0, 150)
    const receipt = receiptOf(
      delivered.map((instanceId, i) => ({
        instanceId,
        golden: "success",
        model: i < 60 ? "success" : "non zero exit",
      })),
      PMX170,
    )
    const evidence = modelEvidenceDoc(PMX170, receipt, {
      chunks: [
        ...chunksOf(delivered, 20),
        {
          chunkId: "lost",
          assignedInstanceIds: PMX170.slice(150),
          attempts: 2,
          delivered: false,
        },
      ],
    })
    const run = gate6("exhausted-chunk", evidence)
    // aug-22 F1: ATTRIBUTION IS NOT A CEILING. Under the campaign's default
    // `maxUngradedAssigned: 0` this loss is refused even though every missing row
    // is attributed to an exhausted chunk — the audit found gate 6 PASSING a
    // Full-170 that graded 1 of 170 for exactly this reason.
    expect(run.code).not.toBe(0)
    expect(run.log).toContain("attempt_incomplete")
    // ...and the loss is still REPORTED, never silently dropped from assigned.
    expect(run.log).toMatch(/missing=20/)

    // PAIRED CONTROL: a campaign that EXPLICITLY budgets the loss admits it, and
    // the rows stay `missing` rather than becoming model misses. That is the
    // original contract this test was written for; the ceiling is what is new.
    const okRecord = budgetedRecord(20)
    const admitted = gate6(
      "exhausted-chunk-budgeted",
      modelEvidenceDoc(PMX170, receipt, {
        frozenRecordSha256: okRecord.sha256,
        chunks: (evidence as Record<string, unknown>).chunks,
      }),
      budgetedRecordPath(okRecord),
    )
    expect(admitted.code).toBe(0)
    expect(admitted.log).toMatch(/missing=20/)

    // ...and one row beyond the declared budget flips it back to a refusal, so
    // the ceiling is the live variable and not a constant that happens to pass.
    const tightRecord = budgetedRecord(19)
    const tooTight = gate6(
      "exhausted-chunk-over-budget",
      modelEvidenceDoc(PMX170, receipt, {
        frozenRecordSha256: tightRecord.sha256,
        chunks: (evidence as Record<string, unknown>).chunks,
      }),
      budgetedRecordPath(tightRecord),
    )
    expect(tooTight.code).not.toBe(0)
    expect(tooTight.log).toContain("attempt_incomplete")
  })
})

// ── G-B ─────────────────────────────────────────────────────────────────────

describe("G-B — gate 6 READS the model-stage evidence it requires", () => {
  test("REFUSES a run with a leakage check disabled", () => {
    const run = gate6(
      "no-leak-checks",
      modelEvidenceDoc(PMX170, modelReceipt(PMX170, 60), {
        chunks: chunksOf(PMX170, 20),
        leakageChecks: [],
      }),
    )
    expect(run.code).not.toBe(0)
    expect(run.log).toContain("leakage_check_disabled")
  })

  test("REFUSES a preset that is neither frozen arm (the implicit-default hazard)", () => {
    const run = gate6(
      "stray-preset",
      modelEvidenceDoc(PMX170, modelReceipt(PMX170, 60), {
        chunks: chunksOf(PMX170, 20),
        preset: "everything-v1",
      }),
    )
    expect(run.code).not.toBe(0)
    expect(run.log).toContain("provenance_incomplete")
    expect(run.log).toContain("everything-v1")
  })

  test("REFUSES a different model than the campaign froze", () => {
    const run = gate6(
      "other-model",
      modelEvidenceDoc(PMX170, modelReceipt(PMX170, 60), {
        chunks: chunksOf(PMX170, 20),
        model: { provider: "anthropic", model: "claude-4", reasoningEffortDelivered: "high" },
      }),
    )
    expect(run.code).not.toBe(0)
    expect(run.log).toContain("provenance_incomplete")
  })

  test("REFUSES a run whose DELIVERED effort is not the frozen one", () => {
    const run = gate6(
      "effort-drift",
      modelEvidenceDoc(PMX170, modelReceipt(PMX170, 60), {
        chunks: chunksOf(PMX170, 20),
        model: { provider: "openai", model: "gpt-5.4", reasoningEffortDelivered: null },
      }),
    )
    expect(run.code).not.toBe(0)
    expect(run.log).toContain("provenance_incomplete")
  })

  test("REFUSES a record whose REQUESTED effort can never reach the provider (`max`)", () => {
    // A record that FREEZING would have refused (`reasoning_effort_dishonest`),
    // re-digested so it parses: requested `max` on the Responses wire is
    // `rejected`, so nothing is delivered and no run can honestly claim one.
    const doc = JSON.parse(serializeProMaxCampaignRecord(RECORD)) as Json
    const { sha256: _drop, ...body } = doc
    const dishonest = {
      ...body,
      model: {
        ...(body.model as Json),
        reasoning_effort: {
          requested: "max",
          decision: "rejected",
          delivered: null,
          surface: "openai-responses",
        },
      },
    }
    const path = write("dishonest-record.json", {
      ...dishonest,
      sha256: sha256Hex(canonicalJson(dishonest)),
    })
    const run = gate6(
      "dishonest-effort",
      modelEvidenceDoc(PMX170, modelReceipt(PMX170, 60), {
        chunks: chunksOf(PMX170, 20),
        frozenRecordSha256: sha256Hex(canonicalJson(dishonest)),
        model: { provider: "openai", model: "gpt-5.4", reasoningEffortDelivered: null },
      }),
      path,
    )
    expect(run.code).not.toBe(0)
    expect(run.log).toContain("provenance_incomplete")
    expect(run.log).toContain("max")
  })

  test("REFUSES a dirty tree (the clause that already had teeth stays)", () => {
    const run = gate6(
      "dirty",
      modelEvidenceDoc(PMX170, modelReceipt(PMX170, 60), {
        chunks: chunksOf(PMX170, 20),
        quanta: { sha: RECORD.quanta.sha, dirty: true },
      }),
    )
    expect(run.code).not.toBe(0)
    expect(run.log).toContain("quanta_dirty")
  })
})

// ── G-C ─────────────────────────────────────────────────────────────────────

describe("G-C — gate 4's continuation number is reconciled with the RECEIPT", () => {
  test("REFUSES rows that disagree with the arm's own official-grade dispositions", () => {
    // The receipt says 10 resolved; the rows CLAIM 14. Today that +4 delta is
    // what authorizes the Full-170 spend.
    const lying = armDoc("candidate-v1", 10, 1.2, {
      rows: PMX40.map((instanceId, i) => ({
        instanceId,
        state: i < 14 ? "resolved" : "model_miss",
        costUsd: 1.2,
        turns: 12,
        wallMs: 60_000,
      })),
    })
    const run = gate4("rows-lie", armDoc("control-v1", 10, 1), lying)
    expect(run.code).not.toBe(0)
    expect(run.log).toContain("paired_rows_receipt_mismatch")
  })

  test("the continuation delta is computed from the receipts, so an inflated row set cannot buy CONTINUE", () => {
    const lying = armDoc("candidate-v1", 10, 1.2, {
      rows: PMX40.map((instanceId, i) => ({
        instanceId,
        state: i < 14 ? "resolved" : "model_miss",
        costUsd: 1.2,
        turns: 12,
        wallMs: 60_000,
      })),
    })
    const run = gate4("rows-lie-delta", armDoc("control-v1", 10, 1), lying)
    expect(run.log).toContain("resolved_delta=0")
    expect(run.log).toContain("continue=false")
  })
})

// ── G-D ─────────────────────────────────────────────────────────────────────

describe("G-D — gate 4's same-images clause refuses ABSENCE, and runs the launch gate", () => {
  test("REFUSES when BOTH arms' freezes omit the same instance (undefined === undefined)", () => {
    const short = imageFreeze(PMX40).images.slice(1)
    const patchFreeze = (resolvedCount: number, cost: number, armName: string): Json => ({
      ...armDoc(armName, resolvedCount, cost),
      evidence: modelEvidenceDoc(PMX40, modelReceipt(PMX40, resolvedCount), {
        imageFreeze: { ...imageFreeze(PMX40), images: short },
      }),
    })
    const run = gate4(
      "both-omit",
      patchFreeze(10, 1, "control-v1"),
      patchFreeze(14, 1.2, "candidate-v1"),
    )
    expect(run.code).not.toBe(0)
    expect(run.log).toContain("paired_image_mismatch")
    // and the launch-readiness assertion gate 4 never ran
    expect(run.log).toContain("image_provenance_incomplete")
  })

  test("REFUSES a freeze pinned to a MUTABLE TAG rather than a digest", () => {
    const tagged = imageFreeze(PMX40)
    const mutable: ProMaxImageFreezeReceipt = {
      ...tagged,
      images: tagged.images.map((r, i) =>
        i === 0 ? { ...r, registry_repo_digest: `swebench-promax/${r.instance_id}:latest` } : r,
      ),
    }
    const withTag = (resolvedCount: number, cost: number, armName: string): Json => ({
      ...armDoc(armName, resolvedCount, cost),
      evidence: modelEvidenceDoc(PMX40, modelReceipt(PMX40, resolvedCount), {
        imageFreeze: mutable,
      }),
    })
    const run = gate4("mutable-tag", withTag(10, 1, "control-v1"), withTag(14, 1.2, "candidate-v1"))
    expect(run.code).not.toBe(0)
    expect(run.log).toMatch(/image_provenance_incomplete|MUTABLE TAG|not a digest pin/)
  })
})
