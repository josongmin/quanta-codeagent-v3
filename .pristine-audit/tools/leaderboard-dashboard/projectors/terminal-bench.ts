/**
 * TB21-05 — the Terminal-Bench **2.1** suite projector.
 *
 * Terminal-Bench is a top-level SUITE with its own versioned, dataset-pinned
 * artifact. It has no dataset family, so nothing here reads one.
 *
 * ## What this projector is for
 *
 * TB21-04 widened the persisted branch to the LOSSLESS 2.1 receipt
 * (`schemaVersion: "terminal-bench-report/v2"`): per-trial rewards, task refs,
 * an eight-class outcome taxonomy, an explicit admission verdict and precomputed
 * official metrics. The dashboard's job is to DISPLAY those receipts:
 *
 *  - the per-instance channel is `trials`, not `perInstance`, so the shell
 *    cannot shape the rows — the projector emits one row PER TRIAL and the shell
 *    carries them. A per-task any-pass fold is gone: it collapsed five k=5
 *    trials into a boolean and reported the optimistic union as a score.
 *  - `metrics` and `outcomes` are computed ONCE, by TB21-04's scorer, and
 *    written into the artifact. A second fold here would be a second scoring
 *    authority, which the ticket's stop rule forbids.
 *  - a CRASH trial stays a row and stays in the denominator. TB21-04 reversed
 *    the old D1 exclusion (an errored trial has no reward, so it scores zero),
 *    and the dashboard must agree with the scorer rather than quietly disagree.
 *
 * ## Identity
 *
 * Two Terminal runs coalesce only when they are the SAME experiment. The
 * campaign identity therefore carries suite@version, the pinned dataset ref, the
 * profile, provider/model, reasoning effort, sandbox, `k` and the standard-config
 * admission — every axis that changes what the number means. A report that
 * cannot supply that identity is REFUSED here rather than rendered under a
 * guessed one.
 *
 * ## Quarantine
 *
 * The pre-2.1 (versionless TB2.0) encoding has no legacy adapter and never will:
 * it recorded no trial ids, rewards or task versions, so there is no honest 2.1
 * reading of it. Those artifacts fail identity at `decodeCanonicalReport`. What
 * this projector adds is a CLAIM on such a refusal, so the view shows a visible
 * "refused, and here is why" line instead of a silently shorter list.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  type CanonicalBenchReport,
  CanonicalReportIdentityError,
  TERMINAL_ONLY_KEYS,
} from "@/runner/batch/report-envelope"
import {
  decodeOfficialComparison,
  type OfficialComparisonPayload,
} from "../importers/terminal-bench-official"
import { TERMINAL_BENCH_CLIENT_SCRIPT, TERMINAL_BENCH_CLIENT_STYLE } from "./terminal-bench.client"
import type {
  BenchmarkView,
  ProjectedInstanceRow,
  ProjectedRun,
  SuiteDataOpts,
  SuiteProjector,
} from "./types"

/** The view tab id AND the suite id — Terminal has exactly one view. */
const TERMINAL_VIEW_ID = "terminal-bench"

/** The label the benchmark selector shows. The VERSION is part of the name: a
 *  2.1 number and a 2.0 number are different benchmarks. */
const TERMINAL_VIEW_LABEL = "Terminal-Bench 2.1"

/** The versioned envelope `DATA.tb` carries. A client that finds anything else
 *  is looking at a pre-cutover payload and must not render it as 2.1. */
export const TERMINAL_DASHBOARD_SCHEMA_VERSION = "terminal-bench-dashboard/v2"

/** The stored competitor payload, read fresh per request (re-running the
 *  importer reflects live) and never fetched. */
const OFFICIAL_FILE = "terminal-bench-official.json"

/**
 * ONE per-trial row. The shell reads `{id, passed}` for its shared tally; every
 * other field belongs to the Terminal view's per-task matrix.
 *
 * `id` is the TRIAL id, not the task id — that is what makes the shell's
 * instance rollup reproduce the official denominator (every trial counted once,
 * an error counted as a zero) instead of an any-pass fold over tasks.
 */
export interface TerminalTrialRow extends ProjectedInstanceRow {
  readonly turns: number
  readonly durationMs: number
  readonly taskId: string
  readonly taskName: string
  readonly outcome: string
  readonly reward: number | null
  readonly costUsd: number | null
  readonly exceptionType?: string
  readonly trajectoryPath?: string
  readonly harborJobId?: string
}

/** Manifest fields that are part of a run's IDENTITY. A report that cannot
 *  supply one of them cannot be placed in a campaign, so it is refused. */
const REQUIRED_MANIFEST_IDENTITY = ["profile", "provider", "reasoningEffort", "sandbox"] as const

interface RunIdentity {
  readonly profile: string
  readonly provider: string
  readonly reasoningEffort: string
  readonly sandbox: string
}

const refuse = (why: string): never => {
  throw new CanonicalReportIdentityError(`terminal-bench: ${why}`)
}

/**
 * Read the run's identity out of the TB21-03 manifest it persisted.
 *
 * The batch layer validates the manifest's provenance CORE and carries the rest
 * verbatim, so these fields arrive as untyped extras — they are checked here,
 * once, and a missing one QUARANTINES the report rather than defaulting.
 */
const identityOf = (
  report: CanonicalBenchReport & { benchmarkSuite: "terminal-bench" },
): RunIdentity => {
  const manifest = report.manifest as Record<string, unknown> | undefined
  if (manifest === undefined) {
    refuse(
      "a 2.1 report must carry its run manifest — profile, provider, reasoning effort and " +
        "sandbox are part of the campaign identity and are never invented",
    )
  }
  const read = (field: (typeof REQUIRED_MANIFEST_IDENTITY)[number]): string => {
    const value = (manifest as Record<string, unknown>)[field]
    if (typeof value !== "string" || value.trim() === "") {
      refuse(`run manifest is missing the required identity field "${field}"`)
    }
    return value as string
  }
  return {
    profile: read("profile"),
    provider: read("provider"),
    reasoningEffort: read("reasoningEffort"),
    sandbox: read("sandbox"),
  }
}

/**
 * The campaign identity. EVERY axis that changes what the accuracy means is in
 * here, so two profiles stay two rows and a dataset-ref change stays two groups.
 */
const campaignIdentityOf = (
  report: CanonicalBenchReport & { benchmarkSuite: "terminal-bench" },
  identity: RunIdentity,
): string =>
  [
    `${TERMINAL_VIEW_ID}@${report.benchmarkVersion}`,
    report.datasetRef,
    `profile=${identity.profile}`,
    `model=${identity.provider}/${(report.manifest as { model?: string } | undefined)?.model ?? report.model ?? "unknown"}`,
    `effort=${identity.reasoningEffort}`,
    `sandbox=${identity.sandbox}`,
    `k=${report.k}`,
    `std=${report.admission.standardConfig ? "yes" : "no"}`,
  ].join(" ")

const rowsOf = (
  report: CanonicalBenchReport & { benchmarkSuite: "terminal-bench" },
): readonly TerminalTrialRow[] =>
  report.trials.map((trial) => ({
    id: trial.trialId,
    // Harbor's reward IS the verdict; the outcome class explains it. `graded_pass`
    // is the ONLY passing class, and the scorer agrees by construction.
    passed: trial.outcome === "graded_pass",
    // Harbor records no turn count — never fabricate one.
    turns: 0,
    durationMs: trial.durationSec === null ? 0 : Math.round(trial.durationSec * 1000),
    taskId: trial.taskId,
    taskName: trial.taskName,
    outcome: trial.outcome,
    reward: trial.reward,
    costUsd: trial.costUsd,
    ...(trial.exceptionType !== undefined ? { exceptionType: trial.exceptionType } : {}),
    ...(trial.trajectoryPath !== undefined ? { trajectoryPath: trial.trajectoryPath } : {}),
    ...(trial.harborJobId !== undefined ? { harborJobId: trial.harborJobId } : {}),
  }))

/** Provenance + persisted metrics, carried verbatim to the Terminal view. */
const runPayloadOf = (
  report: CanonicalBenchReport & { benchmarkSuite: "terminal-bench" },
  identity: RunIdentity,
): Record<string, unknown> => {
  const manifest = (report.manifest ?? {}) as Record<string, unknown>
  return {
    benchmarkVersion: report.benchmarkVersion,
    dataset: report.dataset,
    datasetRef: report.datasetRef,
    timestamp: report.timestamp,
    arm: report.arm,
    k: report.k,
    profile: identity.profile,
    provider: identity.provider,
    reasoningEffort: identity.reasoningEffort,
    sandbox: identity.sandbox,
    model: typeof manifest.model === "string" ? manifest.model : (report.model ?? ""),
    harborVersion: typeof manifest.harborVersion === "string" ? manifest.harborVersion : "",
    quantaSha: typeof manifest.quantaSha === "string" ? manifest.quantaSha : "",
    dirty: manifest.dirty === true,
    agentVersion: typeof manifest.agentVersion === "string" ? manifest.agentVersion : "",
    concurrency: typeof manifest.concurrency === "number" ? manifest.concurrency : null,
    taskSelection: manifest.taskSelection ?? null,
    admission: report.admission,
    // `null`, never a fabricated zero: a REJECTED run publishes no metric.
    metrics: report.metrics ?? null,
    outcomes: report.outcomes,
    defects: report.defects.length,
    harborJobIds: report.harborJobIds,
  }
}

const project = (report: CanonicalBenchReport): ProjectedRun => {
  if (report.benchmarkSuite !== "terminal-bench") {
    throw new CanonicalReportIdentityError(
      `the terminal-bench projector was handed a ${report.benchmarkSuite} report`,
    )
  }
  // `report` came through `decodeCanonicalReport`, which REBUILDS this branch
  // field by field (typed receipts, a validated admission, an outcome tally
  // proven to match the receipts). No defensive re-checking belongs here — only
  // the identity the batch layer does not own.
  const identity = identityOf(report)
  return {
    benchmarkSuite: "terminal-bench",
    // Harbor trials: no verifier, no gold patch — a trial receipt, not a grade.
    instanceRowKind: "trial-receipt",
    viewId: TERMINAL_VIEW_ID,
    campaignIdentity: campaignIdentityOf(report, identity),
    presetLabel: report.preset.trim() === "" ? TERMINAL_VIEW_ID : report.preset.trim(),
    rows: rowsOf(report),
    runPayload: runPayloadOf(report, identity),
    // Both numbers are PERSISTED facts: the eight-class tally the builder wrote
    // and the receipt count. A rejected run publishes no headline at all,
    // because it publishes no metric.
    ...(report.admission.verdict === "rejected"
      ? {}
      : {
          headline: {
            resolved: report.outcomes.graded_pass,
            total: report.trials.length,
          },
        }),
  }
}

/**
 * Claim a REFUSED artifact as this suite's, so the view can show why it was
 * dropped.
 *
 * Claiming is by EXPLICIT identity (`benchmarkSuite`, or any of the branch's own
 * fields), or by the pre-2.1 writer's PROVENANCE marker `source:
 * "terminal-bench-harbor"`. It is deliberately NOT by `datasetFamily`: reading a
 * family value as a suite id is the pre-BFND-02 encoding, it has no sanctioned
 * home left anywhere in this tree, and a claim is not a good enough reason to
 * bring it back.
 */
const claimsRefused = (raw: Record<string, unknown>): boolean => {
  if (raw.benchmarkSuite === TERMINAL_VIEW_ID) return true
  if (raw.source === "terminal-bench-harbor") return true
  return TERMINAL_ONLY_KEYS.some((key) => key in raw)
}

const viewsFor = (seen: ReadonlySet<string>): readonly BenchmarkView[] =>
  seen.has(TERMINAL_VIEW_ID)
    ? [{ id: TERMINAL_VIEW_ID, label: TERMINAL_VIEW_LABEL, suite: "terminal-bench" as const }]
    : []

/**
 * The suite's OFFLINE competitor payload.
 *
 * Read fresh per request from the file `importers/terminal-bench-official.ts`
 * wrote; never fetched, so dashboard startup stays network-free and
 * deterministic. Absent / malformed / pinned to a MUTABLE upstream ref ⇒ `null`,
 * and the view renders `—` rather than a half-trusted comparison.
 *
 * The pre-cutover channel (a parsed TB **2.0** markdown matrix with per-task
 * rates) is gone entirely — there is no `tasks` or `scaffolds` key to fall back
 * to, so a 2.0 rate cannot reappear beside a 2.1 receipt.
 */
const data = ({ rawdataDir, argOf }: SuiteDataOpts): Record<string, unknown> => {
  const path = argOf("--tb-official") ?? join(rawdataDir, OFFICIAL_FILE)
  let official: OfficialComparisonPayload | null = null
  try {
    if (existsSync(path))
      official = decodeOfficialComparison(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    official = null
  }
  return {
    tb: { schemaVersion: TERMINAL_DASHBOARD_SCHEMA_VERSION, official, source: path },
  }
}

export const terminalBenchProjector: SuiteProjector = {
  suite: "terminal-bench",
  // No `adoptLegacy`: a versionless TB2.0 artifact has no honest 2.1 reading.
  claimsRefused,
  project,
  viewsFor,
  data,
  client: { style: TERMINAL_BENCH_CLIENT_STYLE, script: TERMINAL_BENCH_CLIENT_SCRIPT },
}
