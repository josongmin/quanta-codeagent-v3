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
import {
  aggregate,
  classify,
  type FailureBreakdown,
  type FailureClassification,
} from "./corpus/failure-classifier"
import {
  llmEvidencePacketCounts,
  summarizeLlmEvidenceArtifacts,
  type LlmEvidencePacketStage,
  type LlmEvidenceRevisionByStage,
} from "./eval/llm-evidence-packet"
import type { ReceiptEvidence, ScoreLabel } from "./eval/score-label"
import { resolvedTotals, scoreTotals } from "./observe"
import type {
  BenchInstanceBudget,
  BenchReproTestTelemetry,
  GradeBreakdown,
  InstanceResult,
  LlmEvidenceArtifacts,
  PublicRegressionProofState,
  ReproOracleCalibration,
  ReproConsensusProofState,
  SelectionProofSource,
  SelectionProofState,
  SelectionProofSummary,
  SelectionTelemetry,
} from "./types"

export interface BenchReportMeta {
  model: string
  provider: string
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
  error?: string
  /** Structured failure classification. Omitted for passing runs. */
  failure?: FailureClassification
  /** Adaptive-timeout + retry budget. Omitted unless the driver applied the
   *  measurement-stability slice (default: omitted ⇒ byte-identical to the
   *  pre-feature JSON report shape). */
  budget?: BenchInstanceBudget
  /** Repro-test generation/install telemetry. Omitted when the knob was off. */
  reproTest?: BenchReproTestTelemetry
  /** jun-19 — official-grade regression-vs-didn't-fix breakdown (swebench only).
   *  Lets a run self-measure PASS_TO_PASS-break rate (regression-gate
   *  justification). Omitted for non-swebench / ungraded ⇒ byte-identical. */
  gradeBreakdown?: GradeBreakdown
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
export const buildReport = (
  meta: BenchReportMeta & { n: number; timestamp?: string; knobs?: BenchReportKnobs },
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
    perInstance: results.map((r, i) => {
      const c = classifications[i] ?? { termination: "unknown", signals: [] }
      const proofSummary: SelectionProofSummary | undefined = r.selectionTelemetry?.proofSummary
      const llmEvidenceSummary =
        r.llmEvidence !== undefined ? summarizeLlmEvidenceArtifacts(r.llmEvidence) : undefined
      return {
        id: r.id,
        passed: r.passed,
        turns: r.turns,
        patchBytes: Buffer.byteLength(r.patch, "utf8"),
        ...(r.error !== undefined ? { error: r.error } : {}),
        ...(c.termination !== "passed" ? { failure: c } : {}),
        ...(r.budget !== undefined ? { budget: r.budget } : {}),
        ...(r.reproTest !== undefined ? { reproTest: r.reproTest } : {}),
        ...(r.gradeBreakdown !== undefined ? { gradeBreakdown: r.gradeBreakdown } : {}),
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
        ...(r.scoreLabel !== undefined ? { scoreLabel: r.scoreLabel } : {}),
        ...(r.scoreEvidence !== undefined ? { scoreEvidence: r.scoreEvidence } : {}),
        ...(r.llmEvidence !== undefined ? { llmEvidence: r.llmEvidence } : {}),
        ...(llmEvidenceSummary !== undefined
          ? {
              llmEvidenceStages: llmEvidenceSummary.stages,
              llmEvidenceRevision: llmEvidenceSummary.revisionByStage,
              llmEvidenceMissingKinds: llmEvidenceSummary.missingKinds,
            }
          : {}),
      }
    }),
    knobs,
  }
}

/** Canonical SSOT sink for ALL bench reports — regardless of the caller-chosen
 *  `--report` path. Override with `QUANTA_BENCH_RESULTS_DIR`; disable the mirror
 *  with `QUANTA_BENCH_RESULTS_DIR=off`. Default `~/.quanta/bench/results`. */
const benchResultsDir = (): string | null => {
  const override = process.env.QUANTA_BENCH_RESULTS_DIR
  if (override === "off" || override === "0") return null
  if (override && override.length > 0) return override
  const home = process.env.HOME ?? process.env.USERPROFILE
  return home ? `${home}/.quanta/bench/results` : null
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
    const mirrorName = resolve(sourceFile).replace(/^[/\\]+/, "").replace(/[^a-zA-Z0-9._-]/g, "__")
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
