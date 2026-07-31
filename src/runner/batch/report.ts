/**
 * Baseline tracking artifact.
 *
 * A tiny, pure machine-readable report built from `InstanceResult[]` plus
 * run metadata. It is NOT official grading (that requires the Docker
 * harness — see swebench-dataset.ts): `resolved` here reflects the local
 * `testCmd` outcome, which is a no-op for the official-dataset path. The
 * report exists to track baseline runs over time alongside the official
 * `predictions.jsonl`.
 *
 * Knob telemetry: every report carries a `knobs` section recording the exact
 * registry state used for the run — active knob values + their source layer
 * (env / preset / config / cli / default), the optional `--knobs-preset`
 * name, and the registered-but-inactive ids. Operators reading the JSON
 * report can verify what configuration produced the resolved/total numbers,
 * which is the user-explicit requirement: a benchmark report MUST capture
 * its own knob posture so two runs are comparable. Empty registry (knob
 * files not yet imported) ⇒ all three subfields collapse to safe empties.
 *
 * Score honesty: `totals.resolved` stays the legacy pass-count headline for
 * backwards compatibility; `scoreTotals` carries the authority split so only an
 * official harness green can count as clean leaderboard score.
 */
import { createHash } from "node:crypto"
import { quantaHomePath, runtimeConfig } from "@/shared"
import {
  aggregate,
  classify,
  type FailureBreakdown,
  type FailureClassification,
} from "./corpus/failure-classifier"
import {
  type LlmEvidencePacketStage,
  type LlmEvidenceRevisionByStage,
  llmEvidencePacketCounts,
  summarizeLlmEvidenceArtifacts,
} from "./eval/llm-evidence-packet"
import { ObservationError } from "./eval/report"
import type { ReceiptEvidence, ScoreLabel } from "./eval/score-label"
import { filesFromPatch } from "./eval/selection-paths"
import type { BenchObserver, LocalizeData } from "./observe"
import { resolvedTotals, scoreTotals } from "./observe"
import type {
  BenchInstanceBudget,
  BenchReproTestTelemetry,
  GradeBreakdown,
  InstanceResult,
  InstanceUsage,
  LlmEvidenceArtifacts,
  PublicRegressionProofState,
  RepairValidationDecision,
  ReproConsensusProofState,
  ReproOracleCalibration,
  ReproVoteTelemetry,
  SelectionProofSource,
  SelectionProofState,
  SelectionProofSummary,
  SelectionTelemetry,
} from "./types"

/**
 * F1 — emit the Agentless Stage-1 file-tree build + localize outcome. Mirrors
 * `emitSandbox`/`emitVerify` (eval/report.ts): no observer ⇒ no-op (behaviour-
 * neutral), and a strict recorder failure becomes an {@link ObservationError}
 * so the driver maps it to `verdict:"degraded"`. Captures the truncation window
 * + candidate breadth so post-mortem localization RCA is no longer blind to a
 * dropped-gold-file mislocalization.
 */
export const emitLocalize = (observer: BenchObserver | undefined, data: LocalizeData): void => {
  if (observer === undefined) return
  try {
    observer.localize(data)
  } catch (e) {
    throw new ObservationError(e)
  }
}

export interface BenchReportMeta {
  model: string
  provider: string
  /** Dataset family (RFC jun-29 R4). Absent ⇒ verified. */
  datasetFamily?: "verified" | "live" | "pro"
}

/** Knob telemetry — exact registry state for the run. Cheaply serialisable
 *  (plain JSON-friendly shapes, no Maps / classes). */
export interface BenchReportKnobs {
  /** id → { value, unit, display, source }. `unit`/`display` make the number
   *  self-describing ("5 turns", "on") so a bare "5" never appears. Only knobs
   *  whose layered resolution produced a non-undefined value appear here. */
  readonly resolved: Readonly<
    Record<string, { value: unknown; unit: string | undefined; display: string; source: string }>
  >
  /** Resolved `--knobs-preset` name (or `QUANTA_KNOBS_PRESET`). Absent when
   *  no preset was selected. */
  readonly preset?: string
  /** Registered-but-inactive knob ids (no value in any layer, no default).
   *  Sorted by registry iteration order for stability. */
  readonly inactive: readonly string[]
  /** #5: env vars set to a present-but-INVALID value (parser rejected it) that
   *  silently fell through to the hardcoded default. Disjoint from `inactive`
   *  (unset): this is a MISCONFIG the operator must see — the SSOT loudness that
   *  keeps a typo'd `QUANTA_BENCH_*=<bad>` from masquerading as a clean default. */
  readonly rejected?: readonly {
    readonly id: string
    readonly envKey: string
    readonly raw: string
  }[]
}

export interface PerInstanceReport {
  id: string
  passed: boolean
  turns: number
  patchBytes: number
  modelPatchDigest?: string
  touchedFiles?: string[]
  error?: string
  /** Absolute path of the per-instance repro artifact directory when the
   *  observe-root artifact sink was bound. */
  reproArtifactPath?: string
  /** Rolled-up token usage (only when observability captured it). This is the
   *  cost-analysis SSOT (`cost.ts` path-1) — when omitted, `cost.ts` falls back
   *  to the `observe/` trajectories. Absent ⇒ byte-identical to the pre-feature
   *  report shape. */
  usage?: InstanceUsage
  /** Wall-clock instance duration in ms (only when observing). */
  durationMs?: number
  /** Structured failure classification. Omitted for passing runs. */
  failure?: FailureClassification
  /** Adaptive-timeout + retry budget. Omitted unless the driver applied the
   *  measurement-stability slice (default: omitted ⇒ byte-identical to the
   *  pre-feature JSON report shape). */
  budget?: BenchInstanceBudget
  /** Repro-test generation/install telemetry. Omitted when the knob was off. */
  reproTest?: BenchReproTestTelemetry
  /** jun-28 — repro-vote per-round outcome telemetry (vote-decided vs unavailable/
   *  inconclusive). Attached to `InstanceResult` by the driver but previously
   *  DROPPED at report serialization; now emitted so an A/B campaign can read the
   *  vote distribution. Omitted when the repro-vote validator never ran. */
  reproVoteOutcomes?: ReproVoteTelemetry
  /** jun-28 A2 — final repair-gate authority decision. Omitted when the repair
   *  path did not produce a terminal validator decision. */
  repairValidationDecision?: RepairValidationDecision
  /** jun-19 — official-grade regression-vs-didn't-fix breakdown (swebench only).
   *  Lets a run self-measure PASS_TO_PASS-break rate (regression-gate
   *  justification). Omitted for non-swebench / ungraded ⇒ byte-identical. */
  gradeBreakdown?: GradeBreakdown
  /** jun-29 — repair-loop diagnostics that existed on the typed InstanceResult but
   *  were DROPPED at report serialization, so an oracle A/B could not read whether
   *  the loop iterated or false-cleared. Emitted now; omitted when the repair path
   *  never produced them ⇒ byte-identical for non-repair runs. */
  verifyRounds?: number
  primaryFalseGreen?: boolean
  primaryFalseRed?: boolean
  /** jun-30 SOTA++ — winning acceptance rerank tier (observe-only). Preserved at
   *  serialization so a synthesis-arm A/B can read whether the ladder did real work
   *  (`repro_and_regression`/`regression_only`) or fell through to `all_patches`
   *  (no real selection). Omitted on legacy validator-rank ⇒ byte-identical. */
  acceptanceTier?: import("./eval/acceptance-rerank").RerankTier
  /** jun-29 — DERIVED post-grade diagnostic (observe-ONLY; never fed back into
   *  repair selection). True ⇒ the agent-side canonical oracle cleared the repair
   *  gate (`canonical-sidecar` issueResolved) but the OFFICIAL harness graded it
   *  unresolved — i.e. the agent's repro is WEAKER than the held-out FAIL_TO_PASS.
   *  This is the measured failure mode of agentless-v6-oracle (jun-29 pilot:
   *  django-11265 + sympy-23413, 0/2 official with canonical-sidecar resolved).
   *  Computed at serialization from already-graded fields — it CANNOT leak the
   *  official test into the loop (that would be answer-key gaming). */
  oracleGapFalseGreen?: boolean
  /** jun-20 — repro-oracle gold calibration (verify-select runs only). Lets a
   *  campaign self-measure the resolved-oracle false-negative rate (the
   *  verify-and-select bottleneck). Omitted otherwise ⇒ byte-identical. */
  reproOracleCalibration?: ReproOracleCalibration
  /** jun-20 — compact verify-select telemetry (verify-select runs only). Lets a
   *  report preserve candidate/admissibility/winner diagnosis without carrying
   *  the full patches or requiring trajectory replay. */
  selectionTelemetry?: SelectionTelemetry
  proofState?: SelectionProofState
  proofSource?: SelectionProofSource
  proofRequiredMissing?: boolean
  contractOnlySubmitted?: boolean
  contractOnlyBlocked?: boolean
  envPrepFailed?: boolean
  /** Solvability oracle (RFC jun-29): gold resolved under the verifier (true) / gold failed,
   *  verifier-broken (false) / not checked (absent). Lets the dashboard curate benchmarkable
   *  instances + never count a gold-broken instance as a model miss. */
  goldResolved?: boolean
  publicMweState?: import("./eval/mwe-proof").MweProofState
  publicRegressionState?: PublicRegressionProofState
  reproConsensusState?: ReproConsensusProofState
  repairOnlyCandidates?: number
  submittedCandidateProof?: boolean
  /** Honest score claim for a PASSING receipt. Absent on failures and legacy
   *  synthetic rows that never went through the runtime scorer. */
  scoreLabel?: ScoreLabel
  /** Executed evidence underlying {@link scoreLabel}. */
  scoreEvidence?: ReceiptEvidence
  /** OPC-07 report-only typed packets for intake / deterministic selection RCA. */
  llmEvidence?: LlmEvidenceArtifacts
  /** OPC-06/07 packet coverage — which typed evidence stages were actually emitted. */
  llmEvidenceStages?: readonly LlmEvidencePacketStage[]
  /** Packet evidence revision by emitted stage (e.g. intake-v2, selector-repair-v2). */
  llmEvidenceRevision?: LlmEvidenceRevisionByStage
  /** Union of missing-evidence kinds across all emitted packets for this instance. */
  llmEvidenceMissingKinds?: readonly string[]
}

/** `totals.resolved` stays the legacy pass-count headline for backwards
 *  compatibility. `scoreTotals` carries the strict split: only
 *  `officialHarness` counts as clean leaderboard score. */
export interface BenchScoreTotals {
  officialHarness: number
  localStructural: number
  researchContaminated: number
  unlabeledPassed: number
  officialResolvedPct: number
}

export interface BenchProofTotals {
  submittedWithProof: number
  blockedProofMissing: number
  blockedEnvFailed: number
  contractOnlyBlocked: number
  contractOnlySubmitted: number
}

export interface BenchLlmEvidenceTotals {
  packetizedGenerationCount: number
  packetizedRepairCount: number
  packetizedSelectionExplanationCount: number
}

export interface BenchReport {
  timestamp: string
  model: string
  provider: string
  /** Dataset family (RFC jun-29 R4) — present only for non-verified runs so a
   *  verified report stays byte-identical; lets the leaderboard SSOT separate
   *  verified/live/pro instead of conflating their resolved-rates. */
  datasetFamily?: "verified" | "live" | "pro"
  n: number
  totals: {
    total: number
    resolved: number
    resolvedPct: number
  }
  scoreTotals: BenchScoreTotals
  proofTotals: BenchProofTotals
  llmEvidenceTotals: BenchLlmEvidenceTotals
  /** Aggregated failure counts across results. `byTermination` is a covering
   *  partition; `bySignal` is non-exclusive (one failure can carry multiple
   *  signals). Both are emitted in every report; empty objects when 0/n
   *  failed. */
  failureBreakdown: FailureBreakdown
  perInstance: PerInstanceReport[]
  /** Knob telemetry — recorded so two runs are comparable from the JSON
   *  alone. Always present (empty subfields when the registry is empty). */
  knobs: BenchReportKnobs
  /** Run-health verdict from the early systemic-abort detector. ABSENT for a
   *  plain HEALTHY run (byte-identical report) — present only when the detector
   *  ran AND it has something worth recording: an abort, or a non-healthy
   *  diagnosis (e.g. the gate was disabled but the run was systemically broken).
   *  `verdict:"healthy"` runs omit it so a normal report is unchanged. */
  runHealth?: RunHealthSummary
  /** jul-02 — OFFLINE Best@K-vs-Pass@K ceiling (observe-only). Populated ONLY by
   *  the post-hoc `quanta-bench bestk-passk` analyzer (QUANTA_BENCH_BESTK_PASSK),
   *  which re-grades the repair-breadth candidate pool through the official harness
   *  to measure the selector's missed-winner headroom. The LIVE batch/submission
   *  path NEVER sets this field — `buildReport` does not populate it — so a normal
   *  run stays byte-identical (absent ⇒ not serialized). */
  bestKPassKGap?: {
    readonly k: number
    readonly passK: number
    readonly bestK: number
    readonly gap: number
  }
}

/** Serialisable run-health verdict embedded in the report. Mirrors
 *  {@link import("./eval/run-health").RunHealthVerdict} minus the per-instance
 *  category list (kept out of the report SSOT — it is derivable from
 *  perInstance). */
export interface RunHealthSummary {
  aborted: boolean
  verdict: string
  reason: string
  attempted: number
  total: number
}

/** Build the report object from results + meta. Pure & deterministic given a
 *  fixed `timestamp` (defaults to now).
 *
 *  `knobs` is optional only because most legacy callers (and the entire
 *  knob-less codepath, including this worktree's empty registry) pass none.
 *  When omitted the report emits `{ resolved:{}, inactive:[] }` — a safe
 *  empty marker that distinguishes "no knobs section was wired" (impossible
 *  after this change) from "registry was empty for this run" (legitimate
 *  pre-knob baseline). */
/**
 * Project one graded {@link InstanceResult} (+ its {@link FailureClassification})
 * onto its {@link PerInstanceReport} JSON entry. Extracted verbatim from the
 * `buildReport` `perInstance.map` callback so that closure stays under the
 * god-function line cap — pure, behaviour-identical, every conditional-spread
 * keeps its byte-identical-legacy posture.
 */
const buildPerInstanceReportEntry = (
  r: InstanceResult,
  c: FailureClassification,
): PerInstanceReport => {
  const proofSummary: SelectionProofSummary | undefined = r.selectionTelemetry?.proofSummary
  const llmEvidenceSummary =
    r.llmEvidence !== undefined ? summarizeLlmEvidenceArtifacts(r.llmEvidence) : undefined
  const patchBytes = Buffer.byteLength(r.patch, "utf8")
  const touchedFiles = filesFromPatch(r.patch)
  return {
    id: r.id,
    passed: r.passed,
    turns: r.turns,
    patchBytes,
    ...(r.patch.trim() !== ""
      ? {
          modelPatchDigest: createHash("sha256").update(r.patch, "utf8").digest("hex"),
        }
      : {}),
    ...(touchedFiles.length > 0 ? { touchedFiles } : {}),
    ...(r.error !== undefined ? { error: r.error } : {}),
    ...(r.reproArtifactPath !== undefined ? { reproArtifactPath: r.reproArtifactPath } : {}),
    // Cost-analysis SSOT: forward the observed token usage + wall-clock so
    // `report.json` carries what `cost.ts` reads (Gap 1). Both are omitted
    // when observability did not capture them ⇒ byte-identical legacy shape.
    ...(r.usage !== undefined ? { usage: r.usage } : {}),
    ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    ...(c.termination !== "passed" ? { failure: c } : {}),
    ...(r.budget !== undefined ? { budget: r.budget } : {}),
    ...(r.reproTest !== undefined ? { reproTest: r.reproTest } : {}),
    ...(r.reproVoteOutcomes !== undefined ? { reproVoteOutcomes: r.reproVoteOutcomes } : {}),
    ...(r.repairValidationDecision !== undefined
      ? { repairValidationDecision: r.repairValidationDecision }
      : {}),
    ...(r.gradeBreakdown !== undefined ? { gradeBreakdown: r.gradeBreakdown } : {}),
    // jun-29 — forward the repair-loop diagnostics that were typed but dropped.
    ...(r.verifyRounds !== undefined ? { verifyRounds: r.verifyRounds } : {}),
    ...(r.primaryFalseGreen !== undefined ? { primaryFalseGreen: r.primaryFalseGreen } : {}),
    ...(r.primaryFalseRed !== undefined ? { primaryFalseRed: r.primaryFalseRed } : {}),
    // jun-30 SOTA++ — preserve the acceptance rerank tier for synthesis-arm A/B.
    ...(r.acceptanceTier !== undefined ? { acceptanceTier: r.acceptanceTier } : {}),
    // jun-29 — DERIVED, observe-only: the agent-side canonical oracle cleared
    // the repair gate but the OFFICIAL harness graded unresolved (agent repro
    // weaker than the held-out test). Computed from already-graded fields ONLY;
    // never consulted by repair selection (no answer-key leak).
    ...(r.repairValidationDecision?.authority === "canonical-sidecar" &&
    r.repairValidationDecision?.issueResolved === true &&
    r.gradeBreakdown?.resolved === false
      ? { oracleGapFalseGreen: true }
      : {}),
    ...(r.reproOracleCalibration !== undefined
      ? { reproOracleCalibration: r.reproOracleCalibration }
      : {}),
    ...(r.selectionTelemetry !== undefined ? { selectionTelemetry: r.selectionTelemetry } : {}),
    ...(proofSummary !== undefined
      ? {
          proofState: proofSummary.proofState,
          proofSource: proofSummary.proofSource,
          proofRequiredMissing: proofSummary.proofRequiredMissing,
          contractOnlySubmitted: proofSummary.contractOnlySubmitted,
          contractOnlyBlocked: proofSummary.contractOnlyBlocked,
          ...(proofSummary.publicMweState !== undefined
            ? { publicMweState: proofSummary.publicMweState }
            : {}),
          ...(proofSummary.publicRegressionState !== undefined
            ? { publicRegressionState: proofSummary.publicRegressionState }
            : {}),
          ...(proofSummary.reproConsensusState !== undefined
            ? { reproConsensusState: proofSummary.reproConsensusState }
            : {}),
          repairOnlyCandidates: proofSummary.repairOnlyCandidates,
          submittedCandidateProof: proofSummary.submittedCandidateProof,
        }
      : {}),
    ...(r.verdict === "env_prep_failed" ? { envPrepFailed: true } : {}),
    ...(r.goldResolved !== undefined ? { goldResolved: r.goldResolved } : {}),
    ...(r.scoreLabel !== undefined ? { scoreLabel: r.scoreLabel } : {}),
    ...(r.scoreEvidence !== undefined ? { scoreEvidence: r.scoreEvidence } : {}),
    ...(r.ownerWidening !== undefined ? { ownerWidening: r.ownerWidening } : {}),
    ...(r.submissionReview !== undefined ? { submissionReview: r.submissionReview } : {}),
    ...(r.llmEvidence !== undefined ? { llmEvidence: r.llmEvidence } : {}),
    ...(llmEvidenceSummary !== undefined
      ? {
          llmEvidenceStages: llmEvidenceSummary.stages,
          llmEvidenceRevision: llmEvidenceSummary.revisionByStage,
          llmEvidenceMissingKinds: llmEvidenceSummary.missingKinds,
        }
      : {}),
  }
}

export const buildReport = (
  meta: BenchReportMeta & {
    n: number
    timestamp?: string
    knobs?: BenchReportKnobs
    runHealth?: RunHealthSummary
  },
  results: InstanceResult[],
): BenchReport => {
  // C8: degraded-excluding denominator — the SAME source as observe.summarize
  // / summary.json. Never count a strict-degraded instance here.
  const { resolved, total } = resolvedTotals(results)
  const score = scoreTotals(results)
  const classifications = results.map((r) => classify(r))
  const failedClassifications = classifications.filter((c) => c.termination !== "passed")
  // `knobs` defaults to an empty marker so the JSON shape is stable across
  // runs even when the registry is empty (current worktree state).
  const knobs: BenchReportKnobs = meta.knobs ?? { resolved: {}, inactive: [] }
  const proofTotals = results.reduce<BenchProofTotals>(
    (totals, r) => {
      const summary = r.selectionTelemetry?.proofSummary
      if (summary?.submittedCandidateProof === true) totals.submittedWithProof += 1
      if (summary?.proofRequiredMissing === true) totals.blockedProofMissing += 1
      if ((r.verdict ?? "ok") === "env_prep_failed" || summary?.proofState === "infra_blocked") {
        totals.blockedEnvFailed += 1
      }
      if (summary?.contractOnlyBlocked === true) totals.contractOnlyBlocked += 1
      if (summary?.contractOnlySubmitted === true) totals.contractOnlySubmitted += 1
      return totals
    },
    {
      submittedWithProof: 0,
      blockedProofMissing: 0,
      blockedEnvFailed: 0,
      contractOnlyBlocked: 0,
      contractOnlySubmitted: 0,
    },
  )
  const llmEvidenceTotals = results.reduce<BenchLlmEvidenceTotals>(
    (totals, r) => {
      const counts = llmEvidencePacketCounts(r.llmEvidence)
      totals.packetizedGenerationCount += counts?.candidateGeneration ?? 0
      totals.packetizedRepairCount += counts?.repairSeed ?? 0
      totals.packetizedSelectionExplanationCount += counts?.selectionExplanation ?? 0
      return totals
    },
    {
      packetizedGenerationCount: 0,
      packetizedRepairCount: 0,
      packetizedSelectionExplanationCount: 0,
    },
  )
  return {
    timestamp: meta.timestamp ?? new Date().toISOString(),
    model: meta.model,
    provider: meta.provider,
    // R4: emit ONLY for non-verified families ⇒ a verified report is byte-identical.
    ...(meta.datasetFamily !== undefined && meta.datasetFamily !== "verified"
      ? { datasetFamily: meta.datasetFamily }
      : {}),
    n: meta.n,
    totals: {
      total,
      resolved,
      resolvedPct: total === 0 ? 0 : Math.round((resolved / total) * 100),
    },
    scoreTotals: score,
    proofTotals,
    llmEvidenceTotals,
    failureBreakdown: aggregate(failedClassifications),
    perInstance: results.map((r, i) =>
      buildPerInstanceReportEntry(r, classifications[i] ?? { termination: "unknown", signals: [] }),
    ),
    knobs,
    // Emit the run-health verdict ONLY when it carries signal — an abort or a
    // non-healthy diagnosis. A plain `verdict:"healthy"` run omits the field so
    // a normal report stays byte-identical to the pre-feature shape.
    ...(meta.runHealth !== undefined &&
    (meta.runHealth.aborted || meta.runHealth.verdict !== "healthy")
      ? { runHealth: meta.runHealth }
      : {}),
  }
}

/** Canonical SSOT sink for ALL bench reports — regardless of the caller-chosen
 *  `--report` path. Override with `QUANTA_BENCH_RESULTS_DIR`; disable the mirror
 *  with `QUANTA_BENCH_RESULTS_DIR=off`. Default `~/.quanta/bench/results`. */
const benchResultsDir = (): string | null => {
  const override = runtimeConfig().benchResultsDir
  if (override === "off" || override === "0") return null
  if (override && override.length > 0) return override
  return quantaHomePath("bench", "results")
}

/** Mirror an already-written report's CONTENT into the canonical SSOT dir so
 *  results never scatter again — independent of the caller-chosen `--report`
 *  path. The mirror name is the sanitised source path, so re-runs to the same
 *  destination overwrite their own mirror (idempotent, no accumulation).
 *  Best-effort: a mirror failure never throws (the primary write already
 *  succeeded). Shared by `writeReport` (local batch) and the full-remote
 *  sidecar saver, so EVERY report path is covered by one canonical sink. */
export const mirrorReportToSsot = async (sourceFile: string, content: string): Promise<void> => {
  const dir = benchResultsDir()
  if (!dir) return
  try {
    const { resolve } = await import("node:path")
    const mirrorName = resolve(sourceFile)
      .replace(/^[/\\]+/, "")
      .replace(/[^a-zA-Z0-9._-]/g, "__")
    await Bun.write(`${dir}/${mirrorName}`, content)
  } catch {
    // canonical mirror is best-effort — the source report already landed
  }
}

/** Write the report as pretty JSON (trailing newline) and mirror it to the
 *  canonical SSOT dir (see {@link mirrorReportToSsot}). */
export const writeReport = async (file: string, report: BenchReport): Promise<void> => {
  const json = `${JSON.stringify(report, null, 2)}\n`
  await Bun.write(file, json)
  await mirrorReportToSsot(file, json)
}
