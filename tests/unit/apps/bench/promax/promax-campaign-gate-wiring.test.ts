/**
 * PMX-06 — the gates have a PRODUCTION CALLER, and it reads BYTES.
 *
 * The previous stage of this packet learned the lesson the hard way: every piece
 * of the image-provenance chain was unit-tested and NONE of it had a production
 * caller. *"A gate with no caller is not a gate — it is a document that
 * describes one."* So PMX-06's gates get the same treatment: an operator command
 * in the existing `tools/bench-promax/` family, driven here through its REAL
 * entry point over REAL artefact files in a temp directory.
 *
 * Reading bytes is the load-bearing part. Inside one process the gates would be
 * checking data the same process just built; from disk, the record and the
 * evidence have no privileged history — which is what makes
 * "this campaign was frozen before it ran" a checkable claim.
 *
 * ⚠️ SPEND SAFETY: the CLI takes NO process/spawn port at all, and a rail below
 * proves its source contains no spawn/exec/docker/aws token. It cannot
 * provision, pull, upload, or bill. Artefacts are written to `mkdtemp` and
 * removed; `~/.quanta` is never touched.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProMaxImageFreezeReceipt } from "@/apps/bench/harness/promax"
import { buildProMaxOfficialGradeReceipt } from "@/apps/bench/harness/promax"
import {
  type CampaignCliPorts,
  decodeProMaxStageEvidence,
  type FreezeProMaxCampaignInput,
  freezeProMaxCampaignRecord,
  PROMAX_OWNER_AUDIT_BASELINE,
  type ProMaxFrozenCampaignRecord,
  runProMaxCampaignCli,
  serializeProMaxCampaignRecord,
} from "@/apps/bench/promax/campaign"
import { buildProMaxSampleFamily } from "@/apps/bench/promax/corpus"
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance"
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
const DIR = mkdtempSync(join(tmpdir(), "pmx06-cli-"))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

const CORPUS = buildSyntheticProMaxCorpus()
const SAMPLES = buildProMaxSampleFamily({
  candidates: CORPUS.rows.map((row) => ({
    instanceId: String(row.instance_id),
    language: String(row.language),
  })),
  datasetRevision: PROMAX_V1_SNAPSHOT.hf_dataset_revision,
})
const PMX7 = SAMPLES[0]?.instanceIds ?? []

const CAMPAIGN_ID = "pmx-cli-2026-08-22"
const FROZEN_AT = "2026-08-22T00:00:00.000Z"

const input = (): FreezeProMaxCampaignInput => ({
  campaignId: CAMPAIGN_ID,
  frozenAt: FROZEN_AT,
  quanta: { sha: "a".repeat(40), dirty: false },
  upstream: PROMAX_V1_SNAPSHOT,
  samples: SAMPLES,
  arms: [
    { role: "control", name: "control", preset: "agentless-v1", knobs: { lsp: "1" } },
    {
      role: "candidate",
      name: "candidate",
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
  budgets: { maxTurns: 40, maxTokens: 400_000, wallClockMs: 1_800_000 },
  concurrency: { patchGeneration: 4, grading: 1 },
  continuationRule: {
    declaredAt: "2026-08-20T00:00:00.000Z",
    text: "+3 resolved for at most +$40",
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
  ownerAudit: {
    ok: true,
    digest: "b".repeat(64),
    unclassified: [],
    baseline: PROMAX_OWNER_AUDIT_BASELINE,
    final: { ...PROMAX_OWNER_AUDIT_BASELINE },
  },
})

const RECORD: ProMaxFrozenCampaignRecord = (() => {
  const r = freezeProMaxCampaignRecord(input())
  if (!r.ok) throw new Error(`fixture gap: ${r.failures.map((f) => f.code).join(",")}`)
  return r.record
})()

const goldReceipt = (overrides: Partial<RowSpec> = {}) => {
  const text = officialDocument(
    PMX7.map((instanceId, i) =>
      officialRow({
        instanceId,
        golden: "success",
        model: "apply_failed",
        ...(i === 0 ? overrides : {}),
      }),
    ),
  )
  const r = buildProMaxOfficialGradeReceipt({
    assignedInstanceIds: PMX7,
    evaluator: evaluatorIdentity(),
    run: { exitCode: 0, stdout: "", stderr: "", outputJsonText: text, outputPath: OUTPUT_PATH },
  })
  if (!r.ok) throw new Error("fixture gap")
  return r.receipt
}

const imageFreeze = (): ProMaxImageFreezeReceipt => ({
  receipt_version: 1,
  campaign_id: CAMPAIGN_ID,
  upstream_git_commit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
  required_platform: { os: "linux", architecture: "amd64" },
  golden_source: { path: "/c/source.json", sha256: "c".repeat(64) },
  golden_derived: { path: "/c/derived.json", sha256: "d".repeat(64) },
  images: PMX7.map((instanceId, i) => ({
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

const evidenceDoc = (receipt = goldReceipt()) => ({
  frozenRecordSha256: RECORD.sha256,
  observedAt: "2026-08-23T00:00:00.000Z",
  quanta: { sha: RECORD.quanta.sha, dirty: false },
  receipt: JSON.parse(serializeOfficialGradeReceipt(receipt)) as unknown,
  imageFreeze: imageFreeze(),
})

// ── the ports: pure filesystem + a log sink, nothing else ───────────────────

const linesOf = (): { readonly lines: string[]; readonly ports: CampaignCliPorts } => {
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

const write = (name: string, value: unknown): string => {
  const path = join(DIR, name)
  writeFileSync(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`)
  return path
}

const RECORD_PATH = write("campaign-record.json", serializeProMaxCampaignRecord(RECORD))

describe("PMX-06 CLI — preflight is the production caller of the audit and the rails", () => {
  test("REACHABILITY: preflight runs the owner audit, the rails and the record, and exits 0", () => {
    const { lines, ports } = linesOf()
    const code = runProMaxCampaignCli(["preflight", "--record", RECORD_PATH], ports)
    expect({ code, lines: lines.length > 0 }).toEqual({ code: 0, lines: true })
    const out = lines.join("\n")
    // non-vacuous: it reports what it actually saw, not just "ok"
    expect(out).toMatch(/owner-audit/)
    expect(out).toMatch(/rails/)
    expect(out).toContain(RECORD.campaign_id)
    expect(out).toContain(RECORD.sha256)
  })

  test("REFUSES a campaign with no frozen record — the record is a PRECONDITION", () => {
    const { lines, ports } = linesOf()
    const code = runProMaxCampaignCli(["preflight"], ports)
    expect(code).not.toBe(0)
    expect(lines.join("\n")).toMatch(/--record/)
  })

  test("REFUSES an EDITED record (the bytes, not the process memory, are the authority)", () => {
    const doc = JSON.parse(serializeProMaxCampaignRecord(RECORD)) as Record<string, unknown>
    ;(doc.continuation_rule as Record<string, unknown>).minResolvedDelta = 0
    const edited = write("edited-record.json", doc)
    const { lines, ports } = linesOf()
    const code = runProMaxCampaignCli(["preflight", "--record", edited], ports)
    expect(code).not.toBe(0)
    expect(lines.join("\n")).toContain("record_digest_mismatch")
  })

  test("REFUSES an unreadable record path rather than continuing without one", () => {
    const { lines, ports } = linesOf()
    const code = runProMaxCampaignCli(["preflight", "--record", join(DIR, "absent.json")], ports)
    expect(code).not.toBe(0)
    expect(lines.join("\n")).toMatch(/could not be read/i)
  })
})

describe("PMX-06 CLI — a gate evaluated from artefact bytes", () => {
  test("gate 1 PASSES on a healthy sentinel run and writes its result receipt", () => {
    const evidence = write("gate1-evidence.json", evidenceDoc())
    const out = join(DIR, "gate1.result.json")
    const { lines, ports } = linesOf()
    const code = runProMaxCampaignCli(
      [
        "gate",
        "--gate",
        "gate1_pmx7_gold",
        "--record",
        RECORD_PATH,
        "--evidence",
        evidence,
        "--out",
        out,
      ],
      ports,
    )
    expect({ code, log: lines.join("\n") }).toEqual({ code: 0, log: lines.join("\n") })
    const receipt = JSON.parse(readFileSync(out, "utf8")) as {
      gate: string
      ok: boolean
      coverage?: { assigned: number; valid: number; exceptions: number }
    }
    expect(receipt.gate).toBe("gate1_pmx7_gold")
    expect(receipt.ok).toBe(true)
    expect(receipt.coverage).toEqual({ assigned: 7, valid: 7, exceptions: 0 })
    // campaign readiness reports BOTH numbers, never a bare rate
    expect(lines.join("\n")).toMatch(/assigned=7/)
  })

  test("gate 1 REFUSES a run whose golden side failed, naming the code, and exits non-zero", () => {
    const evidence = write(
      "gate1-broken.json",
      evidenceDoc(goldReceipt({ golden: "timeout_eval" })),
    )
    const { lines, ports } = linesOf()
    const code = runProMaxCampaignCli(
      ["gate", "--gate", "gate1_pmx7_gold", "--record", RECORD_PATH, "--evidence", evidence],
      ports,
    )
    expect(code).not.toBe(0)
    expect(lines.join("\n")).toContain("golden_not_success")
  })

  test("gate 6 REFUSES when the earlier gates' result receipts are absent", () => {
    const evidence = write("gate6-evidence.json", {
      ...evidenceDoc(),
      preset: "agentless-v1",
      model: { provider: "openai", model: "gpt-5.4", reasoningEffortDelivered: "high" },
      budgets: { maxTurns: 40, maxTokens: 400_000, wallClockMs: 1_800_000 },
      leakageChecks: [
        "dataset_shape_gold_absent",
        "grader_bundle_outside_agent_root",
        "agent_phase_bootstrap_gold_absent",
      ],
      chunks: [{ chunkId: "c0", assignedInstanceIds: PMX7, attempts: 1, delivered: true }],
    })
    const { lines, ports } = linesOf()
    const code = runProMaxCampaignCli(
      ["gate", "--gate", "gate6_pmx170_model", "--record", RECORD_PATH, "--evidence", evidence],
      ports,
    )
    expect(code).not.toBe(0)
    expect(lines.join("\n")).toContain("prior_gate_not_passed")
  })

  test("an unknown gate id is refused, not defaulted to a cheaper gate", () => {
    const evidence = write("gate-any.json", evidenceDoc())
    const { lines, ports } = linesOf()
    const code = runProMaxCampaignCli(
      ["gate", "--gate", "gate9_free_money", "--record", RECORD_PATH, "--evidence", evidence],
      ports,
    )
    expect(code).not.toBe(0)
    expect(lines.join("\n")).toMatch(/gate9_free_money/)
  })
})

describe("PMX-06 evidence decoding is fail-closed and faithful", () => {
  test("a stage decoded FROM BYTES yields the same assigned set and dispositions", () => {
    const decoded = decodeProMaxStageEvidence(evidenceDoc())
    expect(decoded.ok).toBe(true)
    if (!decoded.ok) throw new Error("unreachable")
    expect(decoded.evidence.receipt.assignedInstanceIds).toEqual(PMX7)
    expect(decoded.evidence.receipt.dispositionsByInstanceId.size).toBe(7)
    expect(decoded.evidence.imageFreeze.images.length).toBe(7)
    expect(decoded.evidence.frozenRecordSha256).toBe(RECORD.sha256)
  })

  test("REFUSES evidence with a malformed receipt, image freeze, or missing binding", () => {
    for (const [label, doc] of [
      ["not an object", 42],
      ["no receipt", { ...evidenceDoc(), receipt: undefined }],
      ["receipt not a receipt", { ...evidenceDoc(), receipt: { nope: true } }],
      ["image freeze is raw docker text", { ...evidenceDoc(), imageFreeze: "REPOSITORY TAG" }],
      ["no record binding", { ...evidenceDoc(), frozenRecordSha256: "" }],
      ["no observedAt", { ...evidenceDoc(), observedAt: "" }],
      ["no quanta", { ...evidenceDoc(), quanta: undefined }],
    ] as const) {
      const decoded = decodeProMaxStageEvidence(doc)
      expect({ label, ok: decoded.ok }).toEqual({ label, ok: false })
    }
  })
})

describe("PMX-06 CLI — spend safety", () => {
  test("the operator command has NO process, docker, aws or network surface", () => {
    const source = readFileSync(join(REPO, "tools", "bench-promax", "campaign-gates.ts"), "utf8")
    const code = source
      .split("\n")
      .filter((line) => {
        const t = line.trim()
        return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"))
      })
      .join("\n")
    for (const forbidden of [
      "spawn",
      "execSync",
      "Bun.$",
      "docker",
      "run-instances",
      "aws ",
      "fetch(",
    ]) {
      expect({ forbidden, present: code.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      })
    }
    // non-vacuity: the detector DOES fire on a line that would introduce one
    expect(`${code}\nconst x = spawn("aws")`.includes("spawn")).toBe(true)
  })
})
