/**
 * PMX-06 — THE SIX STAGED GATES.
 *
 * Each gate below is driven as a PURE PREDICATE over the LANDED receipt types
 * (`OfficialGradeReceipt` from PMX-03, `ProMaxImageFreezeReceipt` from PMX-04,
 * the frozen campaign record). Executing a gate against a live evaluator, Docker
 * or EC2 is deliberately out of scope — the point of building the predicates
 * first is that a live run becomes a thin driver over exactly these functions.
 *
 * THE TWO RAILS THAT MATTER MOST, both proven in BOTH directions:
 *
 *  1. `passed` IS NEVER TRUSTED. A receipt whose every row FORGES `passed: true`
 *     while the golden side failed must be REFUSED; a receipt whose `passed` is
 *     forged `false` while both nested verdicts are correct must be ACCEPTED.
 *     One direction alone would be satisfied by a gate that ignores the receipt.
 *  2. THE CONTINUATION RULE IS PREDECLARED. Results that predate the frozen
 *     record are refused, because a rule written after the numbers exist can be
 *     written to fit them.
 *
 * ⚠️ HERMETIC / SPEND-SAFE: no Docker, no EC2, no network, no `~/.quanta` write.
 */
import { describe, expect, test } from "bun:test"
import type { ProMaxImageFreezeReceipt, ProMaxImageRecord } from "@/apps/bench/harness/promax"
import { buildProMaxOfficialGradeReceipt } from "@/apps/bench/harness/promax"
import {
  admitProMaxFullRun,
  evaluateProMaxCanaryGate,
  evaluateProMaxGoldGate,
  evaluateProMaxModelSmokeGate,
  evaluateProMaxPairedGate,
  type FreezeProMaxCampaignInput,
  freezeProMaxCampaignRecord,
  PROMAX_GATE_FAILURE_CODES,
  PROMAX_GATE_ORDER,
  PROMAX_GATE_SAMPLE,
  PROMAX_LEAKAGE_CHECK_IDS,
  PROMAX_LEAKAGE_CHECKS,
  PROMAX_OWNER_AUDIT_BASELINE,
  type ProMaxArmEvidence,
  type ProMaxChunkEvidence,
  type ProMaxFrozenCampaignRecord,
  type ProMaxGateFailureCode,
  type ProMaxGateResult,
  type ProMaxModelStageEvidence,
  type ProMaxStageEvidence,
} from "@/apps/bench/promax/campaign"
import { buildProMaxSampleFamily, type ProMaxSampleManifest } from "@/apps/bench/promax/corpus"
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance"
import { buildSyntheticProMaxCorpus } from "./promax-corpus-fixture"
import {
  evaluatorIdentity,
  OUTPUT_PATH,
  officialDocument,
  officialRow,
  type RowSpec,
} from "./promax-official-fixtures"

// ── fixtures ────────────────────────────────────────────────────────────────

const CORPUS = buildSyntheticProMaxCorpus()
const SAMPLES: readonly ProMaxSampleManifest[] = buildProMaxSampleFamily({
  candidates: CORPUS.rows.map((row) => ({
    instanceId: String(row.instance_id),
    language: String(row.language),
  })),
  datasetRevision: PROMAX_V1_SNAPSHOT.hf_dataset_revision,
})
const sample = (name: string): readonly string[] =>
  SAMPLES.find((s) => s.name === name)?.instanceIds ?? []

const PMX7 = sample("PMX-7")
const PMX14 = sample("PMX-14")
const PMX40 = sample("PMX-40")
const PMX170 = sample("PMX-170")

const CAMPAIGN_ID = "pmx-2026-08-22-a"
const FROZEN_AT = "2026-08-22T00:00:00.000Z"
const OBSERVED_AT = "2026-08-23T00:00:00.000Z"
/** ONE budget literal, shared by the record and by every stage's evidence — so a
 *  passing fixture cannot drift into agreeing with a record it never froze. */
const BUDGETS = { maxTurns: 40, maxTokens: 400_000, wallClockMs: 1_800_000 } as const

const recordInput = (): FreezeProMaxCampaignInput => ({
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
  const r = freezeProMaxCampaignRecord(recordInput())
  if (!r.ok) throw new Error(`fixture gap: ${r.failures.map((f) => f.code).join(", ")}`)
  return r.record
})()

const receiptOf = (specs: readonly RowSpec[], assigned: readonly string[]) => {
  const text = officialDocument(specs.map(officialRow))
  const r = buildProMaxOfficialGradeReceipt({
    assignedInstanceIds: assigned,
    evaluator: evaluatorIdentity(),
    run: { exitCode: 0, stdout: "", stderr: "", outputJsonText: text, outputPath: OUTPUT_PATH },
  })
  if (!r.ok) throw new Error(`fixture gap: ${r.failures.map((f) => f.code).join(",")}`)
  return r.receipt
}

/** The sentinel run: model apply-fails everywhere, golden succeeds everywhere. */
const goldReceipt = (ids: readonly string[], overrides: Partial<RowSpec>[] = []) =>
  receiptOf(
    ids.map((instanceId, i) => ({
      instanceId,
      golden: "success",
      model: "apply_failed",
      ...(overrides[i] ?? {}),
    })),
    ids,
  )

/** A model run: `resolvedCount` instances resolve, the rest are honest misses. */
const modelReceipt = (
  ids: readonly string[],
  resolvedCount: number,
  extra: Partial<RowSpec>[] = [],
) =>
  receiptOf(
    ids.map((instanceId, i) => ({
      instanceId,
      golden: "success",
      model: i < resolvedCount ? "success" : "non zero exit",
      ...(extra[i] ?? {}),
    })),
    ids,
  )

const imageRecord = (instanceId: string, i: number): ProMaxImageRecord => ({
  instance_id: instanceId,
  source_image_name: `swebench-promax/${instanceId}:v1`,
  // EXACTLY 64 lowercase hex — a shorter or longer digest is not digest-pinned,
  // and the launch gate would (correctly) refuse the whole freeze.
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

const stage = (
  ids: readonly string[],
  receipt = goldReceipt(ids),
  patch: Partial<ProMaxStageEvidence> = {},
): ProMaxStageEvidence => ({
  frozenRecordSha256: RECORD.sha256,
  observedAt: OBSERVED_AT,
  receipt,
  imageFreeze: imageFreeze(ids),
  quanta: { sha: RECORD.quanta.sha, dirty: false },
  ...patch,
})

const modelStage = (
  ids: readonly string[],
  receipt = modelReceipt(ids, 3),
  patch: Partial<ProMaxModelStageEvidence> = {},
): ProMaxModelStageEvidence => ({
  ...stage(ids, receipt),
  preset: "agentless-v1",
  model: { provider: "openai", model: "gpt-5.4", reasoningEffortDelivered: "high" },
  budgets: { ...BUDGETS },
  leakageChecks: [...PROMAX_LEAKAGE_CHECK_IDS],
  ...patch,
})

const codes = (result: ProMaxGateResult): readonly ProMaxGateFailureCode[] =>
  result.failures.map((f) => f.code)

// ── gate 1 — PMX-7 gold ─────────────────────────────────────────────────────

describe("Gate 1 — PMX-7 gold sentinel", () => {
  test("PASSES on 7/7 attempted, 7/7 apply_failed model, 7/7 success golden, 7/7 images", () => {
    const result = evaluateProMaxGoldGate({
      record: RECORD,
      sampleName: "PMX-7",
      evidence: stage(PMX7),
    })
    expect({ ok: result.ok, failures: codes(result) }).toEqual({ ok: true, failures: [] })
    expect(result.summary?.assigned).toBe(7)
  })

  test("REFUSES when the frozen record is absent — recording it is a PRECONDITION", () => {
    const result = evaluateProMaxGoldGate({
      record: undefined,
      sampleName: "PMX-7",
      evidence: stage(PMX7),
    })
    expect(codes(result)).toContain("record_absent")
    expect(result.ok).toBe(false)
  })

  test("REFUSES evidence bound to a DIFFERENT frozen record", () => {
    const result = evaluateProMaxGoldGate({
      record: RECORD,
      sampleName: "PMX-7",
      evidence: stage(PMX7, goldReceipt(PMX7), { frozenRecordSha256: "0".repeat(64) }),
    })
    expect(codes(result)).toContain("record_digest_mismatch")
  })

  test("REFUSES a set that is not the frozen PMX-7 ids, in order", () => {
    const shuffled = [PMX7[1], PMX7[0], ...PMX7.slice(2)] as string[]
    expect(
      codes(
        evaluateProMaxGoldGate({
          record: RECORD,
          sampleName: "PMX-7",
          evidence: stage(shuffled, goldReceipt(shuffled)),
        }),
      ),
    ).toContain("sample_mismatch")

    const short = PMX7.slice(0, 6)
    expect(
      codes(
        evaluateProMaxGoldGate({
          record: RECORD,
          sampleName: "PMX-7",
          evidence: stage(short, goldReceipt(short)),
        }),
      ),
    ).toContain("sample_mismatch")
  })

  test("REFUSES an instance the evaluator never reported on (7/7 ATTEMPTED)", () => {
    const receipt = receiptOf(
      PMX7.slice(0, 6).map((instanceId) => ({
        instanceId,
        golden: "success",
        model: "apply_failed",
      })),
      PMX7,
    )
    const result = evaluateProMaxGoldGate({
      record: RECORD,
      sampleName: "PMX-7",
      evidence: stage(PMX7, receipt),
    })
    expect(codes(result)).toContain("attempt_incomplete")
  })

  test("REFUSES a golden that did not succeed, and a sentinel that did not apply-fail", () => {
    expect(
      codes(
        evaluateProMaxGoldGate({
          record: RECORD,
          sampleName: "PMX-7",
          evidence: stage(PMX7, goldReceipt(PMX7, [{ golden: "non zero exit" }])),
        }),
      ),
    ).toContain("golden_not_success")

    expect(
      codes(
        evaluateProMaxGoldGate({
          record: RECORD,
          sampleName: "PMX-7",
          evidence: stage(PMX7, goldReceipt(PMX7, [{ model: "success" }])),
        }),
      ),
    ).toContain("sentinel_not_apply_failed")
  })

  test("does NOT trust top-level `passed` — proven in BOTH directions", () => {
    // (a) every row FORGES passed:true while golden failed ⇒ still refused.
    const forgedTrue = goldReceipt(
      PMX7,
      PMX7.map(() => ({ golden: "non zero exit" as const, passed: true })),
    )
    const refused = evaluateProMaxGoldGate({
      record: RECORD,
      sampleName: "PMX-7",
      evidence: stage(PMX7, forgedTrue),
    })
    expect(refused.ok).toBe(false)
    expect(codes(refused)).toContain("golden_not_success")

    // (b) every row FORGES passed:false while the nested verdicts are correct ⇒
    // still accepted. Without this, "ignore the receipt entirely" would pass (a).
    const forgedFalse = goldReceipt(
      PMX7,
      PMX7.map(() => ({ passed: false as const })),
    )
    const accepted = evaluateProMaxGoldGate({
      record: RECORD,
      sampleName: "PMX-7",
      evidence: stage(PMX7, forgedFalse),
    })
    expect({ ok: accepted.ok, failures: codes(accepted) }).toEqual({ ok: true, failures: [] })
  })

  test("REFUSES an image freeze that does not cover the assigned set or is not digest-pinned", () => {
    const short = imageFreeze(PMX7.slice(0, 6))
    expect(
      codes(
        evaluateProMaxGoldGate({
          record: RECORD,
          sampleName: "PMX-7",
          evidence: stage(PMX7, goldReceipt(PMX7), { imageFreeze: short }),
        }),
      ),
    ).toContain("image_provenance_incomplete")

    const tagged: ProMaxImageFreezeReceipt = {
      ...imageFreeze(PMX7),
      images: imageFreeze(PMX7).images.map((r, i) =>
        i === 0 ? { ...r, registry_repo_digest: r.source_image_name } : r,
      ),
    }
    expect(
      codes(
        evaluateProMaxGoldGate({
          record: RECORD,
          sampleName: "PMX-7",
          evidence: stage(PMX7, goldReceipt(PMX7), { imageFreeze: tagged }),
        }),
      ),
    ).toContain("image_provenance_incomplete")
  })

  test("REFUSES an evaluator or image freeze pinned to another upstream commit", () => {
    const drifted: ProMaxImageFreezeReceipt = {
      ...imageFreeze(PMX7),
      upstream_git_commit: "0".repeat(40),
    }
    expect(
      codes(
        evaluateProMaxGoldGate({
          record: RECORD,
          sampleName: "PMX-7",
          evidence: stage(PMX7, goldReceipt(PMX7), { imageFreeze: drifted }),
        }),
      ),
    ).toContain("upstream_provenance_mismatch")
  })
})

// ── gate 2 — PMX-7 model smoke ──────────────────────────────────────────────

describe("Gate 2 — the same PMX-7 model smoke", () => {
  test("PASSES on 7/7 assigned, attempted and grading-valid, with full provenance", () => {
    const result = evaluateProMaxModelSmokeGate({
      record: RECORD,
      sampleName: "PMX-7",
      evidence: modelStage(PMX7),
    })
    expect({ ok: result.ok, failures: codes(result) }).toEqual({ ok: true, failures: [] })
  })

  test("SCORE IS DIAGNOSTIC: a 0/7 resolved smoke still passes the integration gate", () => {
    const result = evaluateProMaxModelSmokeGate({
      record: RECORD,
      sampleName: "PMX-7",
      evidence: modelStage(PMX7, modelReceipt(PMX7, 0)),
    })
    expect(result.ok).toBe(true)
    expect(result.summary?.resolved).toBe(0)
    expect(result.summary?.gradingValid).toBe(7)
  })

  test("REFUSES any infra-invalid, ambiguous or missing row", () => {
    const infra = modelReceipt(PMX7, 3, [{ golden: "timeout_eval" }])
    expect(
      codes(
        evaluateProMaxModelSmokeGate({
          record: RECORD,
          sampleName: "PMX-7",
          evidence: modelStage(PMX7, infra),
        }),
      ),
    ).toContain("grading_invalid_present")

    const ambiguous = modelReceipt(PMX7, 3, [
      { golden: "need_human_review", model: "need_human_review" },
    ])
    expect(
      codes(
        evaluateProMaxModelSmokeGate({
          record: RECORD,
          sampleName: "PMX-7",
          evidence: modelStage(PMX7, ambiguous),
        }),
      ),
    ).toContain("grading_invalid_present")
  })

  test("REFUSES a run with the leakage check disabled", () => {
    const result = evaluateProMaxModelSmokeGate({
      record: RECORD,
      sampleName: "PMX-7",
      evidence: modelStage(PMX7, modelReceipt(PMX7, 3), { leakageChecks: [] }),
    })
    expect(codes(result)).toContain("leakage_check_disabled")
    // it names WHICH check is absent, not just "a check"
    expect(result.failures.map((f) => f.message).join(" ")).toContain(
      String(PROMAX_LEAKAGE_CHECK_IDS[0]),
    )
  })

  test("every declared leakage check names a REAL production guard", () => {
    // Non-vacuity for the flag: a check id that maps to no shipped symbol would
    // make "leakage check enabled" an unfalsifiable claim.
    expect(PROMAX_LEAKAGE_CHECK_IDS.length).toBeGreaterThan(0)
    for (const id of PROMAX_LEAKAGE_CHECK_IDS) {
      expect(typeof PROMAX_LEAKAGE_CHECKS[id].symbol).toBe("string")
      expect(PROMAX_LEAKAGE_CHECKS[id].symbol.length).toBeGreaterThan(0)
    }
  })

  test("REFUSES incomplete model / quanta provenance", () => {
    expect(
      codes(
        evaluateProMaxModelSmokeGate({
          record: RECORD,
          sampleName: "PMX-7",
          evidence: modelStage(PMX7, modelReceipt(PMX7, 3), {
            model: { provider: "openai", model: "gpt-4o", reasoningEffortDelivered: "high" },
          }),
        }),
      ),
    ).toContain("provenance_incomplete")

    expect(
      codes(
        evaluateProMaxModelSmokeGate({
          record: RECORD,
          sampleName: "PMX-7",
          evidence: modelStage(PMX7, modelReceipt(PMX7, 3), {
            model: { provider: "openai", model: "gpt-5.4", reasoningEffortDelivered: "low" },
          }),
        }),
      ),
    ).toContain("provenance_incomplete")

    expect(
      codes(
        evaluateProMaxModelSmokeGate({
          record: RECORD,
          sampleName: "PMX-7",
          evidence: modelStage(PMX7, modelReceipt(PMX7, 3), { preset: "agentless-v3-thin-strict" }),
        }),
      ),
    ).toContain("provenance_incomplete")

    expect(
      codes(
        evaluateProMaxModelSmokeGate({
          record: RECORD,
          sampleName: "PMX-7",
          evidence: modelStage(PMX7, modelReceipt(PMX7, 3), {
            quanta: { sha: RECORD.quanta.sha, dirty: true },
          }),
        }),
      ),
    ).toContain("quanta_dirty")
  })
})

// ── gate 3 — PMX-14 canary ──────────────────────────────────────────────────

describe("Gate 3 — PMX-14 canary", () => {
  test("PASSES on 14/14 grading-valid with no unknown outcome reason", () => {
    const result = evaluateProMaxCanaryGate({
      record: RECORD,
      evidence: modelStage(PMX14, modelReceipt(PMX14, 5)),
    })
    expect({ ok: result.ok, failures: codes(result) }).toEqual({ ok: true, failures: [] })
    expect(result.summary?.assigned).toBe(14)
  })

  test("is accountable for the PMX-14 sample specifically", () => {
    expect(PROMAX_GATE_SAMPLE.gate3_pmx14_canary).toBe("PMX-14")
    const result = evaluateProMaxCanaryGate({
      record: RECORD,
      evidence: modelStage(PMX7, modelReceipt(PMX7, 2)),
    })
    expect(codes(result)).toContain("sample_mismatch")
  })

  test("REFUSES an outcome the pinned schema does not define", () => {
    // upstream's unlisted fallback: an unmapped reason becomes a lowercased slug
    const unknown = receiptOf(
      PMX14.map((instanceId, i) => ({
        instanceId,
        golden: "success",
        model: i === 0 ? "some_new_upstream_state" : "success",
      })),
      PMX14,
    )
    const result = evaluateProMaxCanaryGate({
      record: RECORD,
      evidence: modelStage(PMX14, unknown),
    })
    expect(codes(result)).toContain("outcome_reason_unknown")
  })
})

// ── gate 4 — PMX-40 paired ──────────────────────────────────────────────────

const arm = (
  armName: string,
  preset: string,
  resolvedCount: number,
  costEach: number,
  patch: Partial<ProMaxArmEvidence> = {},
): ProMaxArmEvidence => ({
  armName,
  preset,
  evidence: modelStage(PMX40, modelReceipt(PMX40, resolvedCount), { preset }),
  rows: PMX40.map((instanceId, i) => ({
    instanceId,
    state: i < resolvedCount ? ("resolved" as const) : ("model_miss" as const),
    costUsd: costEach,
    turns: 12,
    wallMs: 60_000,
  })),
  ...patch,
})

describe("Gate 4 — PMX-40 paired experiment", () => {
  const control = () => arm("control-v1", "agentless-v1", 10, 1)
  const candidate = () => arm("candidate-v1", "agentless-v1", 14, 1.2)

  test("PASSES when the arms are paired and the predeclared rule says continue", () => {
    const result = evaluateProMaxPairedGate({
      record: RECORD,
      control: control(),
      candidate: candidate(),
    })
    expect({ ok: result.ok, failures: codes(result) }).toEqual({ ok: true, failures: [] })
    expect(result.continuation?.resolvedDelta).toBe(4)
    expect(result.continuation?.continue).toBe(true)
  })

  test("STOPS when the rule's own threshold is not met — no searching for a favorable aggregate", () => {
    const weak = arm("candidate-v1", "agentless-v1", 11, 1.2) // +1 resolved, rule wants +3
    const result = evaluateProMaxPairedGate({ record: RECORD, control: control(), candidate: weak })
    expect(codes(result)).toContain("continuation_rule_stop")
    expect(result.continuation?.continue).toBe(false)
  })

  test("STOPS when the cost delta exceeds the predeclared ceiling", () => {
    const pricey = arm("candidate-v1", "agentless-v1", 14, 3) // +$80 over 40 instances
    const result = evaluateProMaxPairedGate({
      record: RECORD,
      control: control(),
      candidate: pricey,
    })
    expect(codes(result)).toContain("continuation_rule_stop")
    expect(result.continuation?.costUsdDelta).toBeGreaterThan(
      RECORD.continuation_rule.maxCostUsdDelta,
    )
  })

  test("REFUSES results that PREDATE the frozen record — the rule must come first", () => {
    const stale = arm("candidate-v1", "agentless-v1", 14, 1.2, {
      evidence: modelStage(PMX40, modelReceipt(PMX40, 14), {
        preset: "agentless-v1",
        observedAt: "2026-08-01T00:00:00.000Z",
      }),
    })
    const result = evaluateProMaxPairedGate({
      record: RECORD,
      control: control(),
      candidate: stale,
    })
    expect(codes(result)).toContain("continuation_rule_not_predeclared")
  })

  test("REFUSES arms that did not run the same ordered manifest", () => {
    const others = [...PMX40].reverse()
    const reordered = arm("candidate-v1", "agentless-v1", 14, 1.2, {
      evidence: modelStage(others, modelReceipt(others, 14), { preset: "agentless-v1" }),
      rows: others.map((instanceId) => ({
        instanceId,
        state: "model_miss" as const,
        costUsd: 1,
        turns: 1,
        wallMs: 1,
      })),
    })
    expect(
      codes(evaluateProMaxPairedGate({ record: RECORD, control: control(), candidate: reordered })),
    ).toContain("paired_manifest_mismatch")
  })

  test("REFUSES arms that ran different IMAGES for the same instance", () => {
    const repinned = imageFreeze(PMX40)
    const swapped: ProMaxImageFreezeReceipt = {
      ...repinned,
      images: repinned.images.map((r, i) =>
        i === 0
          ? {
              ...r,
              registry_repo_digest: `${r.source_image_name.split(":")[0]}@sha256:${"9".repeat(64)}`,
            }
          : r,
      ),
    }
    const other = arm("candidate-v1", "agentless-v1", 14, 1.2, {
      evidence: modelStage(PMX40, modelReceipt(PMX40, 14), {
        preset: "agentless-v1",
        imageFreeze: swapped,
      }),
    })
    expect(
      codes(evaluateProMaxPairedGate({ record: RECORD, control: control(), candidate: other })),
    ).toContain("paired_image_mismatch")
  })

  test("REFUSES an arm whose preset is not the one the record froze for its role", () => {
    const wrong = arm("candidate-v1", "everything-v1", 14, 1.2)
    expect(
      codes(evaluateProMaxPairedGate({ record: RECORD, control: control(), candidate: wrong })),
    ).toContain("paired_config_mismatch")
  })

  test("REFUSES dropped pairs and missing per-ID cost / turns / wall time", () => {
    const dropped = arm("candidate-v1", "agentless-v1", 14, 1.2, {
      rows: PMX40.slice(0, 39).map((instanceId) => ({
        instanceId,
        state: "resolved" as const,
        costUsd: 1,
        turns: 1,
        wallMs: 1,
      })),
    })
    expect(
      codes(evaluateProMaxPairedGate({ record: RECORD, control: control(), candidate: dropped })),
    ).toContain("paired_row_missing")

    const metricless = arm("candidate-v1", "agentless-v1", 14, 1.2, {
      rows: PMX40.map((instanceId) => ({
        instanceId,
        state: "resolved" as const,
        costUsd: Number.NaN,
        turns: 1,
        wallMs: 1,
      })),
    })
    expect(
      codes(
        evaluateProMaxPairedGate({ record: RECORD, control: control(), candidate: metricless }),
      ),
    ).toContain("paired_metric_missing")
  })
})

// ── gates 5 + 6 — Gold-170 then Full-170 ────────────────────────────────────

const chunksOf = (
  ids: readonly string[],
  size: number,
  attempts = 1,
  delivered = true,
): ProMaxChunkEvidence[] => {
  const out: ProMaxChunkEvidence[] = []
  for (let i = 0; i < ids.length; i += size) {
    out.push({
      chunkId: `chunk-${out.length}`,
      assignedInstanceIds: ids.slice(i, i + size),
      attempts,
      delivered,
    })
  }
  return out
}

describe("Gate 5 — PMX-170 gold preflight", () => {
  test("PASSES on 170/170 attempts, images and golden success", () => {
    const result = evaluateProMaxGoldGate({
      record: RECORD,
      sampleName: "PMX-170",
      evidence: stage(PMX170),
    })
    expect({ ok: result.ok, failures: codes(result) }).toEqual({ ok: true, failures: [] })
    expect(result.summary?.assigned).toBe(170)
    expect(result.coverage).toEqual({ assigned: 170, valid: 170, exceptions: 0 })
  })

  test("REFUSES a shortfall with NO exception manifest", () => {
    const broken = goldReceipt(PMX170, [{ golden: "timeout_eval" }])
    const result = evaluateProMaxGoldGate({
      record: RECORD,
      sampleName: "PMX-170",
      evidence: stage(PMX170, broken),
    })
    expect(codes(result)).toContain("exception_manifest_required")
    expect(result.ok).toBe(false)
  })

  test("ACCEPTS a shortfall covered by a versioned exception manifest, and keeps 170 assigned", () => {
    const broken = goldReceipt(PMX170, [{ golden: "timeout_eval" }])
    const result = evaluateProMaxGoldGate({
      record: RECORD,
      sampleName: "PMX-170",
      evidence: stage(PMX170, broken),
      exceptions: {
        manifest_version: 1,
        campaign_id: CAMPAIGN_ID,
        upstream_git_commit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
        exceptions: [
          {
            instance_id: PMX170[0] as string,
            raw_receipt: '{"instance_id":"…","golden":{"final_result":"timeout_eval"}}',
            upstream_reference: "https://github.com/key4127/SWE-Bench-ProMax/issues/1",
            owner: "songmin",
            disposition: "upstream_defect",
            recorded_at: OBSERVED_AT,
          },
        ],
      },
    })
    expect({ ok: result.ok, failures: codes(result) }).toEqual({ ok: true, failures: [] })
    // the exception is NEVER deleted from assigned — both numbers are reported
    expect(result.coverage).toEqual({ assigned: 170, valid: 169, exceptions: 1 })
  })

  test("REFUSES an exception for an instance that is NOT failing (no pre-emptive excuses)", () => {
    const result = evaluateProMaxGoldGate({
      record: RECORD,
      sampleName: "PMX-170",
      evidence: stage(PMX170),
      exceptions: {
        manifest_version: 1,
        campaign_id: CAMPAIGN_ID,
        upstream_git_commit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
        exceptions: [
          {
            instance_id: PMX170[0] as string,
            raw_receipt: "{}",
            upstream_reference: "https://example.invalid/issue",
            owner: "songmin",
            disposition: "upstream_defect",
            recorded_at: OBSERVED_AT,
          },
        ],
      },
    })
    expect(codes(result)).toContain("exception_unjustified")
  })

  test("REFUSES an exception with no owner, reference, raw receipt or version", () => {
    const broken = goldReceipt(PMX170, [{ golden: "timeout_eval" }])
    const result = evaluateProMaxGoldGate({
      record: RECORD,
      sampleName: "PMX-170",
      evidence: stage(PMX170, broken),
      exceptions: {
        manifest_version: 0,
        campaign_id: CAMPAIGN_ID,
        upstream_git_commit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
        exceptions: [
          {
            instance_id: PMX170[0] as string,
            raw_receipt: "  ",
            upstream_reference: "",
            owner: "",
            disposition: "upstream_defect",
            recorded_at: OBSERVED_AT,
          },
        ],
      },
    })
    expect(codes(result)).toContain("exception_manifest_invalid")
  })
})

describe("Gate 6 — PMX-170 model run", () => {
  const priors = (): readonly ProMaxGateResult[] => [
    evaluateProMaxGoldGate({ record: RECORD, sampleName: "PMX-7", evidence: stage(PMX7) }),
    evaluateProMaxModelSmokeGate({
      record: RECORD,
      sampleName: "PMX-7",
      evidence: modelStage(PMX7),
    }),
    evaluateProMaxCanaryGate({
      record: RECORD,
      evidence: modelStage(PMX14, modelReceipt(PMX14, 5)),
    }),
    evaluateProMaxPairedGate({
      record: RECORD,
      control: arm("control-v1", "agentless-v1", 10, 1),
      candidate: arm("candidate-v1", "agentless-v1", 14, 1.2),
    }),
    evaluateProMaxGoldGate({ record: RECORD, sampleName: "PMX-170", evidence: stage(PMX170) }),
  ]

  test("PASSES only after gates 1-5, on a clean SHA with complete chunk coverage", () => {
    const result = admitProMaxFullRun({
      record: RECORD,
      priorGates: priors(),
      evidence: modelStage(PMX170, modelReceipt(PMX170, 60)),
      chunks: chunksOf(PMX170, 20),
    })
    expect({ ok: result.ok, failures: codes(result) }).toEqual({ ok: true, failures: [] })
  })

  test("REFUSES when ANY prior gate did not pass — one at a time", () => {
    for (let i = 0; i < 5; i += 1) {
      const damaged = priors().map((g, j) =>
        j === i
          ? {
              ...g,
              ok: false,
              failures: [
                ...g.failures,
                { gate: g.gate, code: "sample_mismatch" as const, message: "injected" },
              ],
            }
          : g,
      )
      const result = admitProMaxFullRun({
        record: RECORD,
        priorGates: damaged,
        evidence: modelStage(PMX170, modelReceipt(PMX170, 60)),
        chunks: chunksOf(PMX170, 20),
      })
      expect({ i, codes: codes(result).includes("prior_gate_not_passed") }).toEqual({
        i,
        codes: true,
      })
    }
  })

  test("REFUSES when a prior gate is simply ABSENT (an unrun gate is not a passed gate)", () => {
    const result = admitProMaxFullRun({
      record: RECORD,
      priorGates: priors().slice(0, 4),
      evidence: modelStage(PMX170, modelReceipt(PMX170, 60)),
      chunks: chunksOf(PMX170, 20),
    })
    expect(codes(result)).toContain("prior_gate_not_passed")
  })

  test("REFUSES a dirty or mismatched Quanta tree", () => {
    expect(
      codes(
        admitProMaxFullRun({
          record: RECORD,
          priorGates: priors(),
          evidence: modelStage(PMX170, modelReceipt(PMX170, 60), {
            quanta: { sha: RECORD.quanta.sha, dirty: true },
          }),
          chunks: chunksOf(PMX170, 20),
        }),
      ),
    ).toContain("quanta_dirty")

    expect(
      codes(
        admitProMaxFullRun({
          record: RECORD,
          priorGates: priors(),
          evidence: modelStage(PMX170, modelReceipt(PMX170, 60), {
            quanta: { sha: "f".repeat(40), dirty: false },
          }),
          chunks: chunksOf(PMX170, 20),
        }),
      ),
    ).toContain("quanta_sha_mismatch")
  })

  test("REFUSES chunk coverage that does not partition the assigned set", () => {
    expect(
      codes(
        admitProMaxFullRun({
          record: RECORD,
          priorGates: priors(),
          evidence: modelStage(PMX170, modelReceipt(PMX170, 60)),
          chunks: chunksOf(PMX170.slice(0, 150), 20),
        }),
      ),
    ).toContain("chunk_coverage_incomplete")

    const overlapping = [
      ...chunksOf(PMX170, 20),
      { chunkId: "dup", assignedInstanceIds: PMX170.slice(0, 5), attempts: 1, delivered: true },
    ]
    expect(
      codes(
        admitProMaxFullRun({
          record: RECORD,
          priorGates: priors(),
          evidence: modelStage(PMX170, modelReceipt(PMX170, 60)),
          chunks: overlapping,
        }),
      ),
    ).toContain("chunk_overlap")
  })

  test("a LOST chunk must be retried to exhaustion, and its rows stay `missing` — never model misses", () => {
    const delivered = PMX170.slice(0, 150)
    const lost = PMX170.slice(150)
    const receipt = receiptOf(
      delivered.map((instanceId, i) => ({
        instanceId,
        golden: "success",
        model: i < 60 ? "success" : "non zero exit",
      })),
      PMX170,
    )
    const chunks: ProMaxChunkEvidence[] = [
      ...chunksOf(delivered, 20),
      { chunkId: "lost", assignedInstanceIds: lost, attempts: 2, delivered: false },
    ]
    const exhausted = admitProMaxFullRun({
      record: RECORD,
      priorGates: priors(),
      evidence: modelStage(PMX170, receipt),
      chunks,
    })
    // aug-22 F1: exhausting the FROZEN attempt policy explains the loss but does
    // not license it. The campaign's `maxUngradedAssigned` is the ceiling, and
    // this record declares 0, so a 20-row attributed loss is REFUSED — the audit
    // found gate 6 passing a Full-170 that graded 1 of 170 on exactly this path.
    expect({ ok: exhausted.ok, failures: codes(exhausted) }).toEqual({
      ok: false,
      failures: ["attempt_incomplete"],
    })
    expect(exhausted.summary?.missing).toBe(lost.length)

    // …but a chunk that gave up EARLY is refused.
    const early = admitProMaxFullRun({
      record: RECORD,
      priorGates: priors(),
      evidence: modelStage(PMX170, receipt),
      chunks: chunks.map((c) => (c.chunkId === "lost" ? { ...c, attempts: 1 } : c)),
    })
    expect(codes(early)).toContain("retry_not_exhausted")
  })

  test("REFUSES a lost chunk whose rows were nevertheless SCORED (a miss fabricated from a hole)", () => {
    const lost = PMX170.slice(150)
    const scoredAnyway = receiptOf(
      PMX170.map((instanceId, i) => ({
        instanceId,
        golden: "success",
        model: i < 60 ? "success" : "non zero exit",
      })),
      PMX170,
    )
    const result = admitProMaxFullRun({
      record: RECORD,
      priorGates: priors(),
      evidence: modelStage(PMX170, scoredAnyway),
      chunks: [
        ...chunksOf(PMX170.slice(0, 150), 20),
        { chunkId: "lost", assignedInstanceIds: lost, attempts: 2, delivered: false },
      ],
    })
    expect(codes(result)).toContain("exhausted_row_not_missing")
  })
})

// ── the gate vocabulary itself ──────────────────────────────────────────────

describe("PMX-06 gate vocabulary", () => {
  test("the order is the ticket's order and every gate names its sample", () => {
    expect(PROMAX_GATE_ORDER).toEqual([
      "gate1_pmx7_gold",
      "gate2_pmx7_model",
      "gate3_pmx14_canary",
      "gate4_pmx40_paired",
      "gate5_pmx170_gold",
      "gate6_pmx170_model",
    ])
    expect(PROMAX_GATE_ORDER.map((g) => PROMAX_GATE_SAMPLE[g])).toEqual([
      "PMX-7",
      "PMX-7",
      "PMX-14",
      "PMX-40",
      "PMX-170",
      "PMX-170",
    ])
  })

  test("every declared failure code is REACHABLE (no decorative codes)", () => {
    const seen = new Set<string>()
    const collect = (r: ProMaxGateResult): void => {
      for (const f of r.failures) seen.add(f.code)
    }
    // gate 1/5 clauses
    collect(
      evaluateProMaxGoldGate({ record: undefined, sampleName: "PMX-7", evidence: stage(PMX7) }),
    )
    collect(
      evaluateProMaxGoldGate({
        record: RECORD,
        sampleName: "PMX-7",
        evidence: stage(PMX7.slice(0, 6), goldReceipt(PMX7.slice(0, 6)), {
          frozenRecordSha256: "0".repeat(64),
          imageFreeze: { ...imageFreeze(PMX7.slice(0, 5)), upstream_git_commit: "0".repeat(40) },
        }),
      }),
    )
    collect(
      evaluateProMaxGoldGate({
        record: RECORD,
        sampleName: "PMX-7",
        evidence: stage(
          PMX7,
          receiptOf(
            PMX7.slice(0, 6).map((instanceId, i) => ({
              instanceId,
              golden: i === 0 ? "timeout_eval" : "success",
              model: i === 1 ? "success" : "apply_failed",
            })),
            PMX7,
          ),
        ),
      }),
    )
    // gate 5 exception clauses
    const broken = goldReceipt(PMX170, [{ golden: "timeout_eval" }])
    collect(
      evaluateProMaxGoldGate({
        record: RECORD,
        sampleName: "PMX-170",
        evidence: stage(PMX170, broken),
      }),
    )
    collect(
      evaluateProMaxGoldGate({
        record: RECORD,
        sampleName: "PMX-170",
        evidence: stage(PMX170, broken),
        exceptions: {
          manifest_version: 0,
          campaign_id: CAMPAIGN_ID,
          upstream_git_commit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
          exceptions: [
            {
              instance_id: PMX170[1] as string,
              raw_receipt: "",
              upstream_reference: "",
              owner: "",
              disposition: "upstream_defect",
              recorded_at: OBSERVED_AT,
            },
          ],
        },
      }),
    )
    // an exception naming an instance the campaign no longer assigns
    collect(
      evaluateProMaxGoldGate({
        record: RECORD,
        sampleName: "PMX-170",
        evidence: stage(PMX170, broken),
        exceptions: {
          manifest_version: 1,
          campaign_id: CAMPAIGN_ID,
          upstream_git_commit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
          exceptions: [
            {
              instance_id: "promax__never-assigned-001",
              raw_receipt: "{}",
              upstream_reference: "https://example.invalid/issue",
              owner: "songmin",
              disposition: "upstream_defect",
              recorded_at: OBSERVED_AT,
            },
          ],
        },
      }),
    )
    // gate 2/3 clauses
    collect(
      evaluateProMaxModelSmokeGate({
        record: RECORD,
        sampleName: "PMX-7",
        evidence: modelStage(PMX7, modelReceipt(PMX7, 3, [{ golden: "timeout_eval" }]), {
          leakageChecks: [],
          preset: "everything-v1",
          quanta: { sha: RECORD.quanta.sha, dirty: true },
        }),
      }),
    )
    collect(
      evaluateProMaxCanaryGate({
        record: RECORD,
        evidence: modelStage(
          PMX14,
          receiptOf(
            PMX14.map((instanceId, i) => ({
              instanceId,
              golden: "success",
              model: i === 0 ? "brand_new_state" : "success",
            })),
            PMX14,
          ),
        ),
      }),
    )
    // gate 4 clauses
    const controlArm = arm("control-v1", "agentless-v1", 10, 1)
    collect(
      evaluateProMaxPairedGate({
        record: RECORD,
        control: controlArm,
        candidate: arm("candidate-v1", "everything-v1", 10, 5, {
          rows: PMX40.slice(0, 30).map((instanceId) => ({
            instanceId,
            state: "resolved" as const,
            costUsd: Number.NaN,
            turns: 1,
            wallMs: 1,
          })),
          evidence: modelStage(PMX40.slice(0, 30), modelReceipt(PMX40.slice(0, 30), 5), {
            preset: "everything-v1",
            observedAt: "2026-08-01T00:00:00.000Z",
            imageFreeze: imageFreeze(PMX40.slice(0, 30)),
          }),
        }),
      }),
    )
    collect(
      evaluateProMaxPairedGate({
        record: RECORD,
        control: controlArm,
        candidate: arm("candidate-v1", "agentless-v1", 14, 1.2, {
          evidence: modelStage(PMX40, modelReceipt(PMX40, 14), {
            preset: "agentless-v1",
            imageFreeze: {
              ...imageFreeze(PMX40),
              images: imageFreeze(PMX40).images.map((r, i) =>
                i === 0 ? { ...r, registry_repo_digest: `x@sha256:${"9".repeat(64)}` } : r,
              ),
            },
          }),
        }),
      }),
    )
    // gate 6 clauses
    collect(
      admitProMaxFullRun({
        record: RECORD,
        priorGates: [],
        evidence: modelStage(PMX170, modelReceipt(PMX170, 60), {
          quanta: { sha: "f".repeat(40), dirty: true },
        }),
        chunks: [
          ...chunksOf(PMX170.slice(0, 150), 20),
          {
            chunkId: "lost",
            assignedInstanceIds: PMX170.slice(150),
            attempts: 1,
            delivered: false,
          },
          { chunkId: "dup", assignedInstanceIds: PMX170.slice(0, 3), attempts: 1, delivered: true },
        ],
      }),
    )
    collect(
      admitProMaxFullRun({
        record: RECORD,
        priorGates: [],
        evidence: modelStage(PMX170.slice(0, 100), modelReceipt(PMX170.slice(0, 100), 10)),
        chunks: chunksOf(PMX170.slice(0, 100), 20),
      }),
    )

    const orphan = PROMAX_GATE_FAILURE_CODES.filter((c) => !seen.has(c))
    expect(orphan).toEqual([])
  })
})
