/**
 * PMX-06 — the campaign gates must FAIL CLOSED on artefacts they did not write.
 *
 * The six gates and the frozen record are proven elsewhere against evidence this
 * process constructed. This file attacks the other half: what happens when the
 * bytes on disk are NOT what the producer would have emitted. A campaign record,
 * an exception manifest and a gate-result receipt all travel between machines and
 * sit on disk while results are produced, so "malformed" is the ordinary case,
 * not the adversarial one.
 *
 * Four defects, each confirmed against real bytes before this file was written:
 *
 *  F1 `parseProMaxCampaignRecord` returned `ok` for any document whose `sha256`
 *     matched its own body — including a body with no `samples`. The gate then
 *     died with `undefined is not an object (evaluating 'record.samples.find')`,
 *     i.e. the operator command CRASHED where it promises an exit code.
 *  F2 `validateExceptionManifest` iterated `manifest.exceptions` unguarded, and
 *     the CLI cast the parsed JSON straight to the manifest type. A manifest with
 *     no `exceptions` key crashed gate 5 instead of refusing it.
 *  F3 `decodeProMaxGateResults` accepted a gate receipt claiming `ok: true` while
 *     carrying its own failures — so gate 6 could admit a Full-170 model run on a
 *     receipt that names the refusals it is supposed to be blocked by.
 *  F4 gate 4 never compared BUDGETS, although the ticket requires "the same
 *     ordered manifest, images, model, reasoning effort, and budgets" and
 *     `gates.ts`'s own header advertised the clause.
 *
 * ⚠️ SPEND-SAFE / HERMETIC: the CLI's ports are read-a-file, write-a-file,
 * log-a-line — there is no process, Docker or network surface to reach. Artefacts
 * go to `mkdtemp` and are removed; `~/.quanta` is never touched.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProMaxImageFreezeReceipt } from "@/apps/bench/harness/promax"
import { buildProMaxOfficialGradeReceipt } from "@/apps/bench/harness/promax"
import {
  auditProMaxSourceOwners,
  type CampaignCliPorts,
  collectOwnerAuditSources,
  decodeProMaxGateResults,
  decodeProMaxModelStageEvidence,
  evaluateProMaxModelSmokeGate,
  evaluateProMaxPairedGate,
  type FreezeProMaxCampaignInput,
  freezeProMaxCampaignRecord,
  PROMAX_LEAKAGE_CHECK_IDS,
  PROMAX_OWNER_AUDIT_BASELINE,
  type ProMaxArmEvidence,
  type ProMaxExceptionManifest,
  type ProMaxFrozenCampaignRecord,
  type ProMaxGateResult,
  type ProMaxModelStageEvidence,
  type ProMaxStageEvidence,
  parseProMaxCampaignRecord,
  runProMaxCampaignCli,
  serializeProMaxCampaignRecord,
  validateExceptionManifest,
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
const DIR = mkdtempSync(join(tmpdir(), "pmx06-failclosed-"))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

// ── fixtures ────────────────────────────────────────────────────────────────

const CORPUS = buildSyntheticProMaxCorpus()
const SAMPLES = buildProMaxSampleFamily({
  candidates: CORPUS.rows.map((row) => ({
    instanceId: String(row.instance_id),
    language: String(row.language),
  })),
  datasetRevision: PROMAX_V1_SNAPSHOT.hf_dataset_revision,
})
const idsOf = (name: string): readonly string[] =>
  SAMPLES.find((s) => s.name === name)?.instanceIds ?? []

const PMX7 = idsOf("PMX-7")
const PMX40 = idsOf("PMX-40")
const PMX170 = idsOf("PMX-170")

const CAMPAIGN_ID = "pmx-failclosed-2026-08-22"
const FROZEN_AT = "2026-08-22T00:00:00.000Z"
const OBSERVED_AT = "2026-08-23T00:00:00.000Z"
const BUDGETS = { maxTurns: 40, maxTokens: 400_000, wallClockMs: 1_800_000 } as const
/** The audit's ratchet counters, exactly as a real receipt reports them. */
const AUDIT_COUNTERS = {
  baseline: PROMAX_OWNER_AUDIT_BASELINE,
  final: { ...PROMAX_OWNER_AUDIT_BASELINE },
} as const

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
  retryPolicy: { maxChunkAttempts: 2, exhaustedDisposition: "missing" },
  exceptionPolicy: {
    manifestVersion: 1,
    requiresOwner: true,
    requiresUpstreamReference: true,
    deletesFromAssigned: false,
  },
  ownerAudit: { ok: true, digest: "c".repeat(64), unclassified: [], ...AUDIT_COUNTERS },
})

const RECORD: ProMaxFrozenCampaignRecord = (() => {
  const r = freezeProMaxCampaignRecord(recordInput())
  if (!r.ok) throw new Error(`fixture gap: ${r.failures.map((f) => f.code).join(", ")}`)
  return r.record
})()

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

const modelReceipt = (ids: readonly string[], resolvedCount: number) =>
  receiptOf(
    ids.map((instanceId, i) => ({
      instanceId,
      golden: "success",
      model: i < resolvedCount ? "success" : "non zero exit",
    })),
    ids,
  )

const imageFreeze = (ids: readonly string[]): ProMaxImageFreezeReceipt => ({
  receipt_version: 1,
  campaign_id: CAMPAIGN_ID,
  upstream_git_commit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
  required_platform: { os: "linux", architecture: "amd64" },
  golden_source: { path: "/campaign/golden-source.json", sha256: "d".repeat(64) },
  golden_derived: { path: "/campaign/campaign-golden.json", sha256: "e".repeat(64) },
  images: ids.map((instanceId, i) => ({
    instance_id: instanceId,
    source_image_name: `swebench-promax/${instanceId}:v1`,
    registry_repo_digest: `swebench-promax/${instanceId}@sha256:${i.toString(16).padStart(4, "0")}${"a".repeat(60)}`,
    local_image_id: `sha256:${i.toString(16).padStart(4, "0")}${"b".repeat(60)}`,
    os: "linux",
    architecture: "amd64",
    resolved_at: FROZEN_AT,
  })),
  faults: [],
  ok: true,
})

const stage = (ids: readonly string[], receipt = goldReceipt(ids)): ProMaxStageEvidence => ({
  frozenRecordSha256: RECORD.sha256,
  observedAt: OBSERVED_AT,
  receipt,
  imageFreeze: imageFreeze(ids),
  quanta: { sha: RECORD.quanta.sha, dirty: false },
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

const arm = (
  armName: string,
  resolvedCount: number,
  costEach: number,
  patch: Partial<ProMaxModelStageEvidence> = {},
): ProMaxArmEvidence => ({
  armName,
  preset: "agentless-v1",
  evidence: modelStage(PMX40, modelReceipt(PMX40, resolvedCount), patch),
  rows: PMX40.map((instanceId, i) => ({
    instanceId,
    state: i < resolvedCount ? ("resolved" as const) : ("model_miss" as const),
    costUsd: costEach,
    turns: 12,
    wallMs: 60_000,
  })),
})

const write = (name: string, value: unknown): string => {
  const path = join(DIR, name)
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`)
  return path
}

const cli = (): { readonly lines: string[]; readonly ports: CampaignCliPorts } => {
  const lines: string[] = []
  return {
    lines,
    ports: {
      repoRoot: REPO,
      readFile: (path: string) => readFileSync(path, "utf8"),
      writeFile: (path: string, text: string) => writeFileSync(path, text),
      log: (line: string) => lines.push(line),
    },
  }
}

/** Run the CLI and report a THROW as a distinct outcome from a refusal. The
 *  distinction is the whole point: the command's contract is an exit code. */
const runCli = (
  argv: readonly string[],
): { readonly code: number | "THREW"; readonly log: string } => {
  const { lines, ports } = cli()
  try {
    return { code: runProMaxCampaignCli(argv, ports), log: lines.join("\n") }
  } catch (err) {
    return { code: "THREW", log: `${lines.join("\n")}\n${String(err)}` }
  }
}

const RECORD_PATH = write("campaign-record.json", serializeProMaxCampaignRecord(RECORD))

/** Re-hash a record body after mutilating it, so the DIGEST check cannot be what
 *  refuses the document — only a structural check can. */
const resealed = (mutate: (doc: Record<string, unknown>) => void): string => {
  const doc = JSON.parse(serializeProMaxCampaignRecord(RECORD)) as Record<string, unknown>
  const { sha256: _drop, ...rest } = doc
  const body = rest as Record<string, unknown>
  mutate(body)
  return `${JSON.stringify({ ...body, sha256: sha256Hex(canonicalJson(body)) }, null, 2)}\n`
}

// ── F1 — a resealed but structurally invalid record ─────────────────────────

/** The two mutilations every case below is built from: remove a field a gate
 *  reads, or replace it with something of the wrong shape. */
const drop =
  (field: string) =>
  (doc: Record<string, unknown>): void => {
    delete doc[field]
  }
const set =
  (field: string, value: unknown) =>
  (doc: Record<string, unknown>): void => {
    doc[field] = value
  }

describe("F1 — a record that passes its own digest but is not a record", () => {
  const MUTILATIONS: ReadonlyArray<{
    readonly label: string
    readonly mutate: (doc: Record<string, unknown>) => void
  }> = [
    { label: "no samples at all", mutate: drop("samples") },
    { label: "samples is not an array", mutate: set("samples", { "PMX-7": [] }) },
    { label: "a sample is not an object", mutate: set("samples", ["PMX-7"]) },
    { label: "a sample carries no instanceIds", mutate: set("samples", [{ name: "PMX-7" }]) },
    { label: "no arms", mutate: drop("arms") },
    { label: "arms is not an array", mutate: set("arms", "control,candidate") },
    { label: "no continuation_rule", mutate: drop("continuation_rule") },
    {
      label: "the continuation rule lost its thresholds",
      mutate: set("continuation_rule", { text: "vibes", declaredAt: FROZEN_AT }),
    },
    { label: "no retry_policy", mutate: drop("retry_policy") },
    { label: "no quanta", mutate: drop("quanta") },
    { label: "quanta.sha is a number", mutate: set("quanta", { sha: 1, dirty: false }) },
    { label: "no model", mutate: drop("model") },
    { label: "no upstream", mutate: drop("upstream") },
    { label: "no campaign_id", mutate: drop("campaign_id") },
    { label: "no frozen_at", mutate: drop("frozen_at") },
  ]

  test("PAIRED CONTROL: the intact record still parses, and the reseal is faithful", () => {
    const intact = parseProMaxCampaignRecord(serializeProMaxCampaignRecord(RECORD))
    expect(intact.ok).toBe(true)
    // the reseal helper must produce a document the digest check ACCEPTS, or
    // every case below would pass for the wrong reason.
    const untouched = parseProMaxCampaignRecord(resealed(() => {}))
    expect({ resealAccepted: untouched.ok }).toEqual({ resealAccepted: true })
  })

  test("the parser REFUSES every structurally invalid shape (digest notwithstanding)", () => {
    for (const { label, mutate } of MUTILATIONS) {
      const parsed = parseProMaxCampaignRecord(resealed(mutate))
      expect({ label, ok: parsed.ok }).toEqual({ label, ok: false })
      if (parsed.ok) continue
      expect({ label, codes: parsed.failures.map((f) => f.code) }).toEqual({
        label,
        codes: ["record_unparseable"],
      })
    }
  })

  test("REACHABILITY: the operator command REFUSES it rather than crashing", () => {
    // The defect's observable shape: a TypeError escaping `runProMaxCampaignCli`,
    // which promises an exit code and "never throws for a refusal".
    const path = write(
      "record-no-samples.json",
      resealed((d) => delete d.samples),
    )
    const preflight = runCli(["preflight", "--record", path])
    expect({ code: preflight.code }).toEqual({ code: 1 })
    expect(preflight.log).toMatch(/record_unparseable|not a usable frozen campaign record/)

    const evidence = write("f1-evidence.json", {
      ...stage(PMX7),
      receipt: JSON.parse(serializeOfficialGradeReceipt(goldReceipt(PMX7))) as unknown,
    })
    const gate = runCli([
      "gate",
      "--gate",
      "gate1_pmx7_gold",
      "--record",
      path,
      "--evidence",
      evidence,
    ])
    expect({ code: gate.code }).toEqual({ code: 1 })
    expect(gate.log).toMatch(/not a usable frozen campaign record/)
  })
})

// ── F2 — an exception manifest that is not a manifest ───────────────────────

describe("F2 — a malformed upstream-exception manifest is refused, not fatal", () => {
  const BAD: ReadonlyArray<{ readonly label: string; readonly doc: unknown }> = [
    // valid JSON, but not a manifest. (A file that is not valid JSON at all is
    // already refused by the reader, so it would prove nothing here.)
    { label: "not an object", doc: 42 },
    {
      label: "no exceptions key",
      doc: {
        manifest_version: 1,
        campaign_id: CAMPAIGN_ID,
        upstream_git_commit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
      },
    },
    {
      label: "exceptions is not an array",
      doc: {
        manifest_version: 1,
        campaign_id: CAMPAIGN_ID,
        upstream_git_commit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
        exceptions: { "instance-a": "upstream defect" },
      },
    },
    {
      label: "an exception entry is a bare string",
      doc: {
        manifest_version: 1,
        campaign_id: CAMPAIGN_ID,
        upstream_git_commit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
        exceptions: ["instance-a"],
      },
    },
  ]

  test("the validator returns PROBLEMS for every malformed shape — it never throws", () => {
    for (const { label, doc } of BAD) {
      let problems: readonly string[] | "THREW"
      try {
        problems = validateExceptionManifest({
          manifest: doc as ProMaxExceptionManifest,
          campaignId: CAMPAIGN_ID,
          upstreamGitCommit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
          requiredVersion: 1,
        })
      } catch {
        problems = "THREW"
      }
      expect({ label, threw: problems === "THREW" }).toEqual({ label, threw: false })
      expect({ label, problems: problems !== "THREW" && problems.length > 0 }).toEqual({
        label,
        problems: true,
      })
    }
  })

  test("PAIRED CONTROL: a well-formed manifest still validates clean", () => {
    const problems = validateExceptionManifest({
      manifest: {
        manifest_version: 1,
        campaign_id: CAMPAIGN_ID,
        upstream_git_commit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
        exceptions: [
          {
            instance_id: String(PMX170[0]),
            raw_receipt: '{"golden":{"final_result":"timeout_eval"}}',
            upstream_reference: "https://github.com/key4127/SWE-Bench-ProMax/issues/1",
            owner: "songmin",
            disposition: "upstream_defect",
            recorded_at: OBSERVED_AT,
          },
        ],
      },
      campaignId: CAMPAIGN_ID,
      upstreamGitCommit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
      requiredVersion: 1,
    })
    expect(problems).toEqual([])
  })

  test("REACHABILITY: gate 5 REFUSES through the real CLI rather than crashing", () => {
    const evidence = write("f2-evidence.json", {
      ...stage(PMX170, goldReceipt(PMX170, [{ golden: "timeout_eval" }])),
      receipt: JSON.parse(
        serializeOfficialGradeReceipt(goldReceipt(PMX170, [{ golden: "timeout_eval" }])),
      ) as unknown,
    })
    for (const { label, doc } of BAD) {
      const exceptions = write(`f2-exceptions-${label.replace(/\W+/g, "-")}.json`, doc)
      const run = runCli([
        "gate",
        "--gate",
        "gate5_pmx170_gold",
        "--record",
        RECORD_PATH,
        "--evidence",
        evidence,
        "--exceptions",
        exceptions,
      ])
      expect({ label, code: run.code }).toEqual({ label, code: 1 })
      expect({ label, named: /exception_manifest_invalid/.test(run.log) }).toEqual({
        label,
        named: true,
      })
      // and the shortfall is STILL uncovered — a broken manifest excuses nothing
      expect({ label, uncovered: /exception_manifest_required/.test(run.log) }).toEqual({
        label,
        uncovered: true,
      })
    }
  })
})

// ── F3 — a gate receipt that contradicts itself ─────────────────────────────

describe("F3 — a gate-result receipt whose `ok` disagrees with its own failures", () => {
  test("the decoder REFUSES `ok: true` beside a recorded failure", () => {
    const decoded = decodeProMaxGateResults([
      {
        gate: "gate3_pmx14_canary",
        ok: true,
        failures: [{ code: "grading_invalid_present", message: "3 missing row(s)" }],
      },
    ])
    expect(decoded.ok).toBe(false)
    if (decoded.ok) return
    expect(decoded.problems.join(" | ")).toMatch(/gate3_pmx14_canary/)
  })

  test("PAIRED CONTROL: both self-consistent shapes decode", () => {
    const decoded = decodeProMaxGateResults([
      { gate: "gate1_pmx7_gold", ok: true, failures: [] },
      {
        gate: "gate2_pmx7_model",
        ok: false,
        failures: [{ code: "leakage_check_disabled", message: "…" }],
      },
    ])
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) return
    expect(decoded.evidence.map((g) => `${g.gate}:${String(g.ok)}`)).toEqual([
      "gate1_pmx7_gold:true",
      "gate2_pmx7_model:false",
    ])
  })

  test("REACHABILITY: gate 6 REFUSES a prior-gate file carrying a forged pass", () => {
    const priors: readonly unknown[] = [
      { gate: "gate1_pmx7_gold", ok: true, failures: [] },
      { gate: "gate2_pmx7_model", ok: true, failures: [] },
      {
        gate: "gate3_pmx14_canary",
        ok: true,
        failures: [
          { code: "outcome_reason_unknown", message: "2 row(s) carry an unknown outcome" },
        ],
      },
      {
        gate: "gate4_pmx40_paired",
        ok: true,
        failures: [],
        continuation: { pairedInstances: 40, resolvedDelta: 4, costUsdDelta: 8, continue: true },
      },
      { gate: "gate5_pmx170_gold", ok: true, failures: [] },
    ]
    const priorPath = write("f3-priors.json", priors)
    const evidence = write("f3-evidence.json", {
      ...modelStage(PMX170, modelReceipt(PMX170, 60)),
      receipt: JSON.parse(serializeOfficialGradeReceipt(modelReceipt(PMX170, 60))) as unknown,
      chunks: [{ chunkId: "c0", assignedInstanceIds: PMX170, attempts: 1, delivered: true }],
    })
    const run = runCli([
      "gate",
      "--gate",
      "gate6_pmx170_model",
      "--record",
      RECORD_PATH,
      "--evidence",
      evidence,
      "--prior",
      priorPath,
    ])
    expect({ code: run.code }).toEqual({ code: 1 })
    expect(run.log).toMatch(/gate3_pmx14_canary/)
  })

  test("PAIRED CONTROL: the same gate 6 call is ADMITTED once the receipts agree", () => {
    // Without this, "gate 6 refuses" would also be satisfied by a gate 6 that
    // refuses everything — the forged-pass test would prove nothing.
    const priors: readonly unknown[] = [
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
    const priorPath = write("f3-priors-clean.json", priors)
    const evidence = write("f3-evidence-clean.json", {
      ...modelStage(PMX170, modelReceipt(PMX170, 60)),
      receipt: JSON.parse(serializeOfficialGradeReceipt(modelReceipt(PMX170, 60))) as unknown,
      chunks: [{ chunkId: "c0", assignedInstanceIds: PMX170, attempts: 1, delivered: true }],
    })
    const run = runCli([
      "gate",
      "--gate",
      "gate6_pmx170_model",
      "--record",
      RECORD_PATH,
      "--evidence",
      evidence,
      "--prior",
      priorPath,
    ])
    expect({ code: run.code, log: run.log }).toEqual({ code: 0, log: run.log })
  })
})

// ── F4 — the budgets clause gate 4 advertised but never checked ─────────────

describe("F4 — the frozen BUDGETS are part of the experiment", () => {
  test("gate 4 REFUSES an arm that ran a budget the record did not freeze", () => {
    const result = evaluateProMaxPairedGate({
      record: RECORD,
      control: arm("control-v1", 10, 1),
      // the realistic regression: the candidate arm is given more turns, which
      // makes any resolved delta a budget effect rather than the declared variable
      candidate: arm("candidate-v1", 14, 1.2, { budgets: { ...BUDGETS, maxTurns: 80 } }),
    })
    expect(result.failures.map((f) => f.code)).toContain("paired_config_mismatch")
    expect(result.failures.map((f) => f.message).join(" | ")).toMatch(/maxTurns/)
    expect(result.ok).toBe(false)
  })

  test("gate 4 REFUSES even when BOTH arms moved together — the record is the authority", () => {
    const budgets = { ...BUDGETS, wallClockMs: 3_600_000 }
    const result = evaluateProMaxPairedGate({
      record: RECORD,
      control: arm("control-v1", 10, 1, { budgets }),
      candidate: arm("candidate-v1", 14, 1.2, { budgets }),
    })
    expect(result.failures.map((f) => f.code)).toContain("paired_config_mismatch")
    expect(result.ok).toBe(false)
  })

  test("PAIRED CONTROL: the frozen budgets pass, in both arms", () => {
    const result = evaluateProMaxPairedGate({
      record: RECORD,
      control: arm("control-v1", 10, 1),
      candidate: arm("candidate-v1", 14, 1.2),
    })
    expect({ ok: result.ok, failures: result.failures.map((f) => f.code) }).toEqual({
      ok: true,
      failures: [],
    })
  })

  test("the model stages are held to the frozen budgets too, one field at a time", () => {
    for (const [field, value] of [
      ["maxTurns", 12],
      ["maxTokens", 40_000],
      ["wallClockMs", 600_000],
    ] as const) {
      const result = evaluateProMaxModelSmokeGate({
        record: RECORD,
        sampleName: "PMX-7",
        evidence: modelStage(PMX7, modelReceipt(PMX7, 3), {
          budgets: { ...BUDGETS, [field]: value },
        }),
      })
      expect({ field, codes: result.failures.map((f) => f.code) }).toEqual({
        field,
        codes: ["provenance_incomplete"],
      })
    }
  })

  test("evidence that names NO budgets is refused at the decoder", () => {
    const full = {
      ...modelStage(PMX7),
      receipt: JSON.parse(serializeOfficialGradeReceipt(goldReceipt(PMX7))) as unknown,
    }
    const withBudgets = decodeProMaxModelStageEvidence(full)
    expect({ withBudgets: withBudgets.ok }).toEqual({ withBudgets: true })

    for (const [label, budgets] of [
      ["absent", undefined],
      ["not an object", 40],
      ["a partial budget", { maxTurns: 40 }],
      ["a non-numeric budget", { maxTurns: "40", maxTokens: 400_000, wallClockMs: 1_800_000 }],
    ] as const) {
      const decoded = decodeProMaxModelStageEvidence({ ...full, budgets })
      expect({ label, ok: decoded.ok }).toEqual({ label, ok: false })
    }
  })
})

// ── F5 — the ratchet counters the ticket says to RECORD ─────────────────────

describe("F5 — the frozen record carries the source-owner COUNTERS, not just a verdict", () => {
  test("the record reports the baseline AND final counts the ticket enumerates", () => {
    // *"Before PMX-7, record: … baseline and final counts of raw family env
    // reads, `family === "promax"` branches outside the registered profile, and
    // legacy verdict-bucket consumers."* A digest binds those numbers, but an
    // operator reading `campaign-record.json` a month later cannot see them, and
    // a later ticket cannot show the ratchet went DOWN without them.
    expect(RECORD.owner_audit.baseline).toEqual(AUDIT_COUNTERS.baseline)
    expect(RECORD.owner_audit.final).toEqual(AUDIT_COUNTERS.final)
    expect(RECORD.owner_audit.digest).toBe("c".repeat(64))
  })

  test("the counters SURVIVE the round trip through the persisted bytes", () => {
    const reparsed = parseProMaxCampaignRecord(serializeProMaxCampaignRecord(RECORD))
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.record.owner_audit).toEqual(RECORD.owner_audit)
  })

  test("REFUSES a freeze whose audit counters ROSE above their baseline", () => {
    // The ratchet is the reason the counts are recorded at all. A campaign that
    // froze while the tree had MORE scattered family behavior than the audit's
    // baseline is not a campaign anyone can compare against later.
    const raised = freezeProMaxCampaignRecord({
      ...recordInput(),
      ownerAudit: {
        ok: true,
        digest: "c".repeat(64),
        unclassified: [],
        baseline: AUDIT_COUNTERS.baseline,
        final: { ...AUDIT_COUNTERS.final, legacyVerdictConsumers: 99 },
      },
    })
    expect(raised.ok).toBe(false)
    if (raised.ok) return
    expect(raised.failures.map((f) => f.code)).toEqual(["owner_audit_counter_rose"])
    expect(raised.failures[0]?.message).toMatch(/legacyVerdictConsumers/)
  })

  test("PAIRED CONTROL: counters that went DOWN are welcome", () => {
    const improved = freezeProMaxCampaignRecord({
      ...recordInput(),
      ownerAudit: {
        ok: true,
        digest: "c".repeat(64),
        unclassified: [],
        baseline: AUDIT_COUNTERS.baseline,
        final: { ...AUDIT_COUNTERS.final, legacyVerdictConsumers: 0 },
      },
    })
    expect({ ok: improved.ok }).toEqual({ ok: true })
  })

  test("the counters a REAL audit produces are the ones a real campaign would freeze", () => {
    // Non-vacuity: the shape above is not invented for the test — it is exactly
    // what `auditProMaxSourceOwners` reports over the live tree.
    const live = auditProMaxSourceOwners(collectOwnerAuditSources(REPO))
    const frozen = freezeProMaxCampaignRecord({ ...recordInput(), ownerAudit: live })
    expect({ ok: frozen.ok, liveOk: live.ok }).toEqual({ ok: true, liveOk: true })
    if (!frozen.ok) return
    expect(frozen.record.owner_audit.final).toEqual(live.final)
    expect(frozen.record.owner_audit.digest).toBe(live.digest)
  })
})

// ── the gate-6 admission is still reachable end to end ──────────────────────

describe("PMX-06 fail-closed repairs did not make the happy path unreachable", () => {
  test("a clean campaign still produces a PASSING gate-2 result", () => {
    const result: ProMaxGateResult = evaluateProMaxModelSmokeGate({
      record: RECORD,
      sampleName: "PMX-7",
      evidence: modelStage(PMX7, modelReceipt(PMX7, 3)),
    })
    expect({ ok: result.ok, failures: result.failures.map((f) => f.code) }).toEqual({
      ok: true,
      failures: [],
    })
    expect(result.summary?.assigned).toBe(7)
  })
})
