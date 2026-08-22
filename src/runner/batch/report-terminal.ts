/**
 * BFND-02 × TB21-04 — the Terminal-Bench branch of {@link CanonicalBenchReport}.
 *
 * ## Why the types live HERE and the logic lives in `@/apps/bench/terminal`
 *
 * The batch layer owns PERSISTENCE (BFND-02: "`src/runner/batch/report.ts` or
 * cohesive siblings own serialization"), and `@/runner` may not reference
 * `apps/**` — not even in type position (the surface-isolation guard in
 * `tests/unit/runner-slice-boundary.test.ts`). So the persisted SHAPE is declared
 * here, once, and TB21-04's parser / classifier / admission / scorer import it
 * and build values of it. There is exactly one declaration of every field: the
 * surface narrows the shape (`TerminalRunReport extends TerminalBenchReport`) but
 * never redeclares it.
 *
 * ## What replaced what
 *
 * The pre-TB21-04 branch was LOSSY against the receipt the ticket requires: it
 * carried `{id, passed, turns, durationMs, error?}` per trial — no reward, no
 * task id/ref, no tokens, no cost, no trajectory path, and a two-value
 * `error.kind` where the taxonomy has eight classes. A run could therefore be
 * scored losslessly in memory and flattened the moment it was written, which is
 * the same fold `tb-report-emit.ts` performed one layer down. That schema is
 * REPLACED, not extended with another optional field beside the old fold:
 * `trials` is the only per-trial channel, and there is no `perInstance`.
 *
 * ## What the decode enforces
 *
 * {@link decodeTerminalBenchReport} REBUILDS the report field by field, and then
 * checks the three things a hand-edited or truncated artifact would break:
 *
 *  - the recorded `outcomes` tally matches the trials actually present;
 *  - the recorded duplicate-trial-id set matches the trials actually present,
 *    and a run with duplicates is `rejected`;
 *  - `metrics` is present exactly when the verdict is NOT `rejected`.
 *
 * Those are drift guards, not decoration: without them a report could claim
 * `verdict:"official"` over a trial set that never earned it, and every consumer
 * downstream would believe it.
 */
import {
  asArrayField,
  asBooleanField,
  asFiniteField,
  asFiniteOrNullField,
  asRecordField,
  asStringArrayField,
  asStringField,
  CanonicalReportIdentityError,
  put,
  refuse,
} from "./report-decode"

/** The only Terminal-Bench version this envelope admits. */
export const TERMINAL_BENCH_VERSION = "2.1"
export type TerminalBenchVersion = typeof TERMINAL_BENCH_VERSION

/** The persisted report schema. A Terminal artifact WITHOUT it is a pre-2.1
 *  (TB2.0) encoding and is refused: the versionless fold cannot be read as a 2.1
 *  receipt, and quarantining it is the whole point of stamping a version. */
export const TERMINAL_REPORT_SCHEMA_VERSION = "terminal-bench-report/v2"
export type TerminalReportSchemaVersion = typeof TERMINAL_REPORT_SCHEMA_VERSION

/** The canonical dataset a 2.1 trial is graded against. Declared here because
 *  the persisted `dataset` field is part of the branch's identity; the pinned
 *  REF (and the 89 task digests) stay with TB21-04's dataset module. */
export const TERMINAL_BENCH_DATASET_ID = "terminal-bench/terminal-bench-2-1"
export type TerminalBenchDatasetId = typeof TERMINAL_BENCH_DATASET_ID

// ── taxonomy ─────────────────────────────────────────────────────────────────

/** Every outcome a Terminal trial can have (TB21-04's eight classes). Closed
 *  set: adding a kind forces every exhaustive consumer to compile-fail. */
export const TERMINAL_TRIAL_OUTCOMES = [
  "graded_pass",
  "graded_fail",
  "agent_timeout",
  "agent_crash",
  "environment_error",
  "verifier_error",
  "missing_reward",
  "malformed_result",
] as const
export type TerminalTrialOutcome = (typeof TERMINAL_TRIAL_OUTCOMES)[number]

/** Runtime drift guard for the closed set above: `satisfies` proves the array and
 *  the union agree in BOTH directions at compile time (a missing member fails to
 *  satisfy; an invented one is not assignable). */
const TERMINAL_TRIAL_OUTCOME_SET = {
  graded_pass: true,
  graded_fail: true,
  agent_timeout: true,
  agent_crash: true,
  environment_error: true,
  verifier_error: true,
  missing_reward: true,
  malformed_result: true,
} as const satisfies Record<TerminalTrialOutcome, true>

export const isTerminalTrialOutcome = (raw: unknown): raw is TerminalTrialOutcome =>
  typeof raw === "string" && raw in TERMINAL_TRIAL_OUTCOME_SET

// ── per-trial receipt ────────────────────────────────────────────────────────

/** The verify-before-finalize gate's honest trichotomy, as the terminal brain
 *  stamped it (`QUANTA_TB_VERIFY_GATE`, a RETAINED 2.1 lever). ABSENT on a
 *  gate-off run — the field is never defaulted, because "no stamp" and
 *  "unverifiable" are different facts. Mirrors `@/agent/converge`'s
 *  `VerificationState`; duplicated as a literal union rather than imported
 *  because `@/runner` must not depend on the agent slice for a report shape. */
export const TERMINAL_VERIFY_GATE_STATES = [
  "verified-pass",
  "verified-fail",
  "unverifiable",
] as const
export type TerminalVerifyGateState = (typeof TERMINAL_VERIFY_GATE_STATES)[number]
const VERIFY_GATE_STATE_SET: Readonly<Record<TerminalVerifyGateState, true>> = {
  "verified-pass": true,
  "verified-fail": true,
  unverifiable: true,
}
export const isTerminalVerifyGateState = (raw: unknown): raw is TerminalVerifyGateState =>
  typeof raw === "string" && raw in VERIFY_GATE_STATE_SET

/** Supplemental Quanta facts, verbatim from the agent adapter's own receipt.
 *  NEVER authoritative for the score — the grader's reward is. */
export interface QuantaTrialFacts {
  /** TB21-06 AP-9: the verify-gate outcome. The retired 2.0 shell tally
   *  (`tally-verification.sh`) was this stamp's only consumer; the distribution
   *  it printed is now derivable from the canonical report itself. */
  readonly verifyGateState?: TerminalVerifyGateState
  readonly agentVersion?: string
  readonly packageVersion?: string
  readonly commit?: string
  readonly dirty?: boolean
  readonly model?: string
  readonly reasoningEffort?: string
  readonly reasoningEffortWireHonored?: boolean
  readonly termination?: string
  readonly promotable?: boolean
  readonly promotabilityReasons?: readonly string[]
  readonly atifErrors?: readonly string[]
}

/** ONE receipt per distinct trial id. Never collapsed, never merged, never
 *  folded into a per-task boolean. */
export interface TerminalTrialReceipt {
  readonly trialId: string
  readonly trialName?: string
  /** `org/name`, e.g. `terminal-bench/adaptive-rejection-sampler`. */
  readonly taskId: string
  readonly taskName: string
  /** The canonical task VERSION this trial ran (`sha256:…`). Absent on a
   *  pre-2.1 artifact, which is exactly why such a run is not admissible. */
  readonly taskRef?: string
  readonly taskChecksum?: string
  /** The dataset the trial declares it ran. */
  readonly datasetSource?: string
  /** The raw numeric reward used for scoring; `null` when the grader recorded none.
   *  `null` is NOT zero — it is "no reward was recorded", and the difference is
   *  what stops a fabricated miss. */
  readonly reward: number | null
  readonly outcome: TerminalTrialOutcome
  readonly exceptionType?: string
  readonly exceptionMessage?: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly durationSec: number | null
  readonly uncachedInputTokens: number | null
  readonly cachedInputTokens: number | null
  readonly outputTokens: number | null
  readonly costUsd: number | null
  /** Path only — trajectory CONTENT never enters a summary report. */
  readonly trajectoryPath?: string
  /** `undefined` when there is no trajectory to judge. */
  readonly atifValid?: boolean
  readonly quanta?: QuantaTrialFacts
  /** Forbidden timeout/resource overrides found on this trial's own config. */
  readonly configOverrides: readonly string[]
  readonly sourcePath: string
  readonly harborJobId?: string
  /** Which experimental arm produced this trial. Guards the baseline/lever union. */
  readonly arm?: string
}

/** A trial record that could not be turned into a receipt at all. Reported, and
 *  it makes the run incomplete; NEVER scored and never back-filled. */
export interface TerminalTrialDefect {
  readonly sourcePath: string
  readonly reason: string
}

// ── admission ────────────────────────────────────────────────────────────────

export type TerminalRejectionKind =
  | "duplicate_trial_id"
  | "unknown_task"
  | "missing_task_ref"
  | "task_ref_mismatch"
  | "dataset_source_mismatch"

const TERMINAL_REJECTION_KIND_SET = {
  duplicate_trial_id: true,
  unknown_task: true,
  missing_task_ref: true,
  task_ref_mismatch: true,
  dataset_source_mismatch: true,
} as const satisfies Record<TerminalRejectionKind, true>

export interface TerminalRejection {
  readonly kind: TerminalRejectionKind
  readonly trialId: string
  readonly detail: string
}

/** `official` > `nonstandard` > `incomplete` > `rejected`, worst wins. */
export type TerminalVerdict = "official" | "nonstandard" | "incomplete" | "rejected"

const TERMINAL_VERDICT_SET = {
  official: true,
  nonstandard: true,
  incomplete: true,
  rejected: true,
} as const satisfies Record<TerminalVerdict, true>

export interface TerminalAdmission {
  readonly verdict: TerminalVerdict
  readonly complete: boolean
  readonly standardConfig: boolean
  readonly promotable: boolean
  readonly k: number
  readonly expectedTaskCount: number
  readonly observedTaskCount: number
  readonly expectedTrials: number
  readonly admittedTrials: number
  readonly duplicateTrialIds: readonly string[]
  readonly rejections: readonly TerminalRejection[]
  /** Human-readable caveats. Every entry names a real, counted fact. */
  readonly reasons: readonly string[]
}

// ── official metrics ─────────────────────────────────────────────────────────

/** The pass@k columns the upstream leaderboard `metrics_schema` requires. */
export const TERMINAL_PASS_AT_KS = [2, 3, 4, 5] as const
export type TerminalPassAtK = (typeof TERMINAL_PASS_AT_KS)[number]

/** Precomputed official-shaped metrics. Downstream FORMATS these; it never
 *  recomputes them, and it never folds `trials` into a score of its own. */
export interface TerminalOfficialMetrics {
  readonly accuracy: number
  readonly accuracyStderr: number
  readonly displayAccuracy: string
  readonly nTrials: number
  readonly passAtK: Readonly<Record<TerminalPassAtK, number>>
  readonly uncachedInputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
  readonly totalCostUsd: number
  readonly displayTotalCostUsd: string
  readonly avgTrialDurationSec: number
  readonly rewardHacks: number
}

// ── run provenance (the TB21-03 manifest, carried verbatim) ──────────────────

/**
 * The provenance core every persisted Terminal report must carry.
 *
 * TB21-03's `TerminalBenchRunManifest` EXTENDS this interface, so there is one
 * declaration per field and a rename on either side is a compile error. The
 * manifest's remaining fields (knob table, effort decision, upload posture, …)
 * are provenance the batch layer has no business re-typing; they ride along
 * verbatim through the decode and are re-validated by the manifest's own
 * validator at the surface.
 */
export interface TerminalRunManifestSection {
  readonly schemaVersion: string
  readonly benchmarkSuite: "terminal-bench"
  readonly benchmarkVersion: string
  readonly dataset: string
  readonly datasetRef: string
  readonly harborVersion: string
  readonly quantaSha: string
  readonly dirty: boolean
  readonly agentVersion: string
  readonly model: string
  readonly k: number
  readonly timestamp: string
  readonly arm: string
  readonly preset: string
  readonly promotable: boolean
}

// ── the branch ───────────────────────────────────────────────────────────────

/** The Terminal-Bench branch: versioned, dataset-pinned, family-less, lossless. */
export interface TerminalBenchReport {
  readonly schemaVersion: TerminalReportSchemaVersion
  readonly benchmarkSuite: "terminal-bench"
  readonly benchmarkVersion: TerminalBenchVersion
  readonly dataset: TerminalBenchDatasetId
  /** The pinned upstream dataset ref the trials were graded against. */
  readonly datasetRef: string
  readonly timestamp: string
  /** Experiment arm. Baseline and lever runs are scored SEPARATELY, always. */
  readonly arm: string
  /** Trials per task the run intended. */
  readonly k: number
  /** Never fabricated — an unknown model stays undefined. */
  readonly model: string | undefined
  readonly preset: string
  readonly harborJobIds: readonly string[]
  readonly sourcePaths: readonly string[]
  readonly manifest?: TerminalRunManifestSection
  readonly admission: TerminalAdmission
  /** `undefined` for a REJECTED run: a number computed from trials that failed
   *  identity admission would be worse than no number at all. */
  readonly metrics: TerminalOfficialMetrics | undefined
  readonly outcomes: Readonly<Record<TerminalTrialOutcome, number>>
  /** THE lossless per-trial channel. There is no second, folded one. */
  readonly trials: readonly TerminalTrialReceipt[]
  readonly defects: readonly TerminalTrialDefect[]
}

// ── decode ───────────────────────────────────────────────────────────────────

const decodeQuantaFacts = (raw: unknown, at: string): QuantaTrialFacts => {
  const row = asRecordField(raw, at)
  const optString = (key: keyof QuantaTrialFacts): string | undefined =>
    row[key] === undefined ? undefined : asStringField(row[key], `${at}.${String(key)}`)
  const optBool = (key: keyof QuantaTrialFacts): boolean | undefined =>
    row[key] === undefined ? undefined : asBooleanField(row[key], `${at}.${String(key)}`)
  const optStrings = (key: keyof QuantaTrialFacts): readonly string[] | undefined =>
    row[key] === undefined ? undefined : asStringArrayField(row[key], `${at}.${String(key)}`)
  if (row.verifyGateState !== undefined && !isTerminalVerifyGateState(row.verifyGateState)) {
    refuse(
      `${at}.verifyGateState`,
      `must be one of ${TERMINAL_VERIFY_GATE_STATES.join("|")}`,
      row.verifyGateState,
    )
  }
  return {
    ...put(
      "verifyGateState",
      isTerminalVerifyGateState(row.verifyGateState) ? row.verifyGateState : undefined,
    ),
    ...put("agentVersion", optString("agentVersion")),
    ...put("packageVersion", optString("packageVersion")),
    ...put("commit", optString("commit")),
    ...put("dirty", optBool("dirty")),
    ...put("model", optString("model")),
    ...put("reasoningEffort", optString("reasoningEffort")),
    ...put("reasoningEffortWireHonored", optBool("reasoningEffortWireHonored")),
    ...put("termination", optString("termination")),
    ...put("promotable", optBool("promotable")),
    ...put("promotabilityReasons", optStrings("promotabilityReasons")),
    ...put("atifErrors", optStrings("atifErrors")),
  }
}

const decodeTrialReceipt = (raw: unknown, index: number): TerminalTrialReceipt => {
  const at = `trials[${index}]`
  const row = asRecordField(raw, at)
  const optString = (key: string): string | undefined =>
    row[key] === undefined ? undefined : asStringField(row[key], `${at}.${key}`)
  const outcome = row.outcome
  if (!isTerminalTrialOutcome(outcome)) {
    refuse(`${at}.outcome`, `must be one of ${TERMINAL_TRIAL_OUTCOMES.join("|")}`, outcome)
  }
  return {
    trialId: asStringField(row.trialId, `${at}.trialId`),
    ...put("trialName", optString("trialName")),
    taskId: asStringField(row.taskId, `${at}.taskId`),
    taskName: asStringField(row.taskName, `${at}.taskName`),
    ...put("taskRef", optString("taskRef")),
    ...put("taskChecksum", optString("taskChecksum")),
    ...put("datasetSource", optString("datasetSource")),
    reward: asFiniteOrNullField(row.reward, `${at}.reward`),
    outcome: outcome as TerminalTrialOutcome,
    ...put("exceptionType", optString("exceptionType")),
    ...put("exceptionMessage", optString("exceptionMessage")),
    startedAt: row.startedAt === null ? null : asStringField(row.startedAt, `${at}.startedAt`),
    finishedAt: row.finishedAt === null ? null : asStringField(row.finishedAt, `${at}.finishedAt`),
    durationSec: asFiniteOrNullField(row.durationSec, `${at}.durationSec`),
    uncachedInputTokens: asFiniteOrNullField(row.uncachedInputTokens, `${at}.uncachedInputTokens`),
    cachedInputTokens: asFiniteOrNullField(row.cachedInputTokens, `${at}.cachedInputTokens`),
    outputTokens: asFiniteOrNullField(row.outputTokens, `${at}.outputTokens`),
    costUsd: asFiniteOrNullField(row.costUsd, `${at}.costUsd`),
    ...put("trajectoryPath", optString("trajectoryPath")),
    ...put(
      "atifValid",
      row.atifValid === undefined ? undefined : asBooleanField(row.atifValid, `${at}.atifValid`),
    ),
    ...put(
      "quanta",
      row.quanta === undefined ? undefined : decodeQuantaFacts(row.quanta, `${at}.quanta`),
    ),
    configOverrides: asStringArrayField(row.configOverrides, `${at}.configOverrides`),
    sourcePath: asStringField(row.sourcePath, `${at}.sourcePath`),
    ...put("harborJobId", optString("harborJobId")),
    ...put("arm", optString("arm")),
  }
}

const decodeDefect = (raw: unknown, index: number): TerminalTrialDefect => {
  const at = `defects[${index}]`
  const row = asRecordField(raw, at)
  return {
    sourcePath: asStringField(row.sourcePath, `${at}.sourcePath`),
    reason: asStringField(row.reason, `${at}.reason`),
  }
}

const decodeRejection = (raw: unknown, index: number): TerminalRejection => {
  const at = `admission.rejections[${index}]`
  const row = asRecordField(raw, at)
  const kind = row.kind
  if (typeof kind !== "string" || !(kind in TERMINAL_REJECTION_KIND_SET)) {
    refuse(
      `${at}.kind`,
      `must be one of ${Object.keys(TERMINAL_REJECTION_KIND_SET).join("|")}`,
      kind,
    )
  }
  return {
    kind: kind as TerminalRejectionKind,
    trialId: asStringField(row.trialId, `${at}.trialId`),
    detail: asStringField(row.detail, `${at}.detail`),
  }
}

const decodeAdmission = (raw: unknown): TerminalAdmission => {
  const row = asRecordField(raw, "admission")
  const verdict = row.verdict
  if (typeof verdict !== "string" || !(verdict in TERMINAL_VERDICT_SET)) {
    refuse(
      "admission.verdict",
      `must be one of ${Object.keys(TERMINAL_VERDICT_SET).join("|")}`,
      verdict,
    )
  }
  return {
    verdict: verdict as TerminalVerdict,
    complete: asBooleanField(row.complete, "admission.complete"),
    standardConfig: asBooleanField(row.standardConfig, "admission.standardConfig"),
    promotable: asBooleanField(row.promotable, "admission.promotable"),
    k: asFiniteField(row.k, "admission.k"),
    expectedTaskCount: asFiniteField(row.expectedTaskCount, "admission.expectedTaskCount"),
    observedTaskCount: asFiniteField(row.observedTaskCount, "admission.observedTaskCount"),
    expectedTrials: asFiniteField(row.expectedTrials, "admission.expectedTrials"),
    admittedTrials: asFiniteField(row.admittedTrials, "admission.admittedTrials"),
    duplicateTrialIds: asStringArrayField(row.duplicateTrialIds, "admission.duplicateTrialIds"),
    rejections: asArrayField(row.rejections, "admission.rejections").map(decodeRejection),
    reasons: asStringArrayField(row.reasons, "admission.reasons"),
  }
}

const decodeMetrics = (raw: unknown): TerminalOfficialMetrics => {
  const row = asRecordField(raw, "metrics")
  const passAtKRaw = asRecordField(row.passAtK, "metrics.passAtK")
  const passAtK = {} as Record<TerminalPassAtK, number>
  for (const k of TERMINAL_PASS_AT_KS) {
    passAtK[k] = asFiniteField(passAtKRaw[String(k)], `metrics.passAtK.${k}`)
  }
  return {
    accuracy: asFiniteField(row.accuracy, "metrics.accuracy"),
    accuracyStderr: asFiniteField(row.accuracyStderr, "metrics.accuracyStderr"),
    displayAccuracy: asStringField(row.displayAccuracy, "metrics.displayAccuracy"),
    nTrials: asFiniteField(row.nTrials, "metrics.nTrials"),
    passAtK,
    uncachedInputTokens: asFiniteField(row.uncachedInputTokens, "metrics.uncachedInputTokens"),
    cachedInputTokens: asFiniteField(row.cachedInputTokens, "metrics.cachedInputTokens"),
    outputTokens: asFiniteField(row.outputTokens, "metrics.outputTokens"),
    totalCostUsd: asFiniteField(row.totalCostUsd, "metrics.totalCostUsd"),
    displayTotalCostUsd: asStringField(row.displayTotalCostUsd, "metrics.displayTotalCostUsd"),
    avgTrialDurationSec: asFiniteField(row.avgTrialDurationSec, "metrics.avgTrialDurationSec"),
    rewardHacks: asFiniteField(row.rewardHacks, "metrics.rewardHacks"),
  }
}

/**
 * The manifest section: identity + provenance VALIDATED, every other manifest
 * field carried through verbatim so the hand-off stays lossless. The authority
 * on the manifest's full shape is TB21-03's own validator at the surface; this
 * boundary refuses the fields a report reader depends on being true.
 */
const decodeManifestSection = (raw: unknown): TerminalRunManifestSection => {
  const row = asRecordField(raw, "manifest")
  if ("datasetFamily" in row) {
    throw new CanonicalReportIdentityError(
      "a terminal-bench run manifest must not carry a datasetFamily (families are the SWE axis)",
    )
  }
  if (row.benchmarkSuite !== "terminal-bench") {
    refuse("manifest.benchmarkSuite", 'must be "terminal-bench"', row.benchmarkSuite)
  }
  const core = {
    schemaVersion: asStringField(row.schemaVersion, "manifest.schemaVersion"),
    benchmarkSuite: "terminal-bench" as const,
    benchmarkVersion: asStringField(row.benchmarkVersion, "manifest.benchmarkVersion"),
    dataset: asStringField(row.dataset, "manifest.dataset"),
    datasetRef: asStringField(row.datasetRef, "manifest.datasetRef"),
    harborVersion: asStringField(row.harborVersion, "manifest.harborVersion"),
    quantaSha: asStringField(row.quantaSha, "manifest.quantaSha"),
    dirty: asBooleanField(row.dirty, "manifest.dirty"),
    agentVersion: asStringField(row.agentVersion, "manifest.agentVersion"),
    model: asStringField(row.model, "manifest.model"),
    k: asFiniteField(row.k, "manifest.k"),
    timestamp: asStringField(row.timestamp, "manifest.timestamp"),
    arm: asStringField(row.arm, "manifest.arm"),
    preset: asStringField(row.preset, "manifest.preset"),
    promotable: asBooleanField(row.promotable, "manifest.promotable"),
  }
  // Verbatim remainder FIRST, validated core second: the checked values win, and
  // nothing the producer recorded is dropped.
  return { ...row, ...core }
}

const duplicateIdsOf = (trials: readonly TerminalTrialReceipt[]): readonly string[] => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const trial of trials) {
    if (seen.has(trial.trialId)) duplicates.add(trial.trialId)
    seen.add(trial.trialId)
  }
  return [...duplicates]
}

/**
 * Consistency drift guards. A report is a RECEIPT: the tallies it publishes must
 * be derivable from the rows it carries. A hand edit, a truncated merge, or a
 * filter that dropped rows before the writer saw them fails closed HERE rather
 * than putting an unearned verdict on a leaderboard.
 */
const assertReceiptConsistency = (report: TerminalBenchReport): void => {
  const counted = Object.fromEntries(TERMINAL_TRIAL_OUTCOMES.map((k) => [k, 0])) as Record<
    TerminalTrialOutcome,
    number
  >
  for (const trial of report.trials) counted[trial.outcome] += 1
  for (const outcome of TERMINAL_TRIAL_OUTCOMES) {
    if (report.outcomes[outcome] !== counted[outcome]) {
      throw new CanonicalReportIdentityError(
        `outcomes.${outcome} says ${report.outcomes[outcome]} but the persisted trials contain ` +
          `${counted[outcome]} — the tally must be derivable from the receipts it summarises`,
      )
    }
  }
  if (report.admission.admittedTrials !== report.trials.length) {
    throw new CanonicalReportIdentityError(
      `admission.admittedTrials says ${report.admission.admittedTrials} but ${report.trials.length} ` +
        "trial receipts are present",
    )
  }
  const duplicates = duplicateIdsOf(report.trials)
  const recorded = new Set(report.admission.duplicateTrialIds)
  const agree = duplicates.length === recorded.size && duplicates.every((id) => recorded.has(id))
  if (!agree) {
    throw new CanonicalReportIdentityError(
      `admission.duplicateTrialIds records [${report.admission.duplicateTrialIds.join(", ")}] but ` +
        `the persisted trials contain duplicate ids [${duplicates.join(", ")}]`,
    )
  }
  if (duplicates.length > 0 && report.admission.verdict !== "rejected") {
    throw new CanonicalReportIdentityError(
      `a run with duplicate trial ids [${duplicates.join(", ")}] cannot be ` +
        `"${report.admission.verdict}" — duplicate trial ids are a rejection`,
    )
  }
  if (report.admission.rejections.length > 0 && report.admission.verdict !== "rejected") {
    throw new CanonicalReportIdentityError(
      `admission carries ${report.admission.rejections.length} rejection(s) but the verdict is ` +
        `"${report.admission.verdict}"`,
    )
  }
  const rejected = report.admission.verdict === "rejected"
  if (rejected !== (report.metrics === undefined)) {
    throw new CanonicalReportIdentityError(
      rejected
        ? "a rejected terminal run must carry NO metrics — a number computed from trials that " +
            "failed identity admission is worse than no number"
        : `a ${report.admission.verdict} terminal run must carry its precomputed metrics`,
    )
  }
}

/**
 * THE Terminal read boundary. A real decode, not a cast: every field the type
 * promises is checked and REBUILT here, so a malformed or hostile artifact fails
 * closed instead of entering the type system as a well-typed value.
 */
export const decodeTerminalBenchReport = (raw: Record<string, unknown>): TerminalBenchReport => {
  if ("datasetFamily" in raw) {
    throw new CanonicalReportIdentityError(
      "a terminal-bench report must not carry a datasetFamily (families are the SWE axis)",
    )
  }
  if (raw.schemaVersion !== TERMINAL_REPORT_SCHEMA_VERSION) {
    throw new CanonicalReportIdentityError(
      `unsupported terminal schemaVersion ${JSON.stringify(raw.schemaVersion)} (expected ` +
        `${TERMINAL_REPORT_SCHEMA_VERSION}). A versionless artifact is a pre-2.1 (TB2.0) fold: ` +
        "its trials were collapsed per task and cannot be read as 2.1 receipts.",
    )
  }
  if (raw.benchmarkVersion !== TERMINAL_BENCH_VERSION) {
    throw new CanonicalReportIdentityError(
      `unsupported benchmarkVersion ${JSON.stringify(raw.benchmarkVersion)} (expected ${TERMINAL_BENCH_VERSION})`,
    )
  }
  if (raw.dataset !== TERMINAL_BENCH_DATASET_ID) {
    throw new CanonicalReportIdentityError(
      `a terminal-bench report must name the canonical dataset ${TERMINAL_BENCH_DATASET_ID} (got ` +
        `${JSON.stringify(raw.dataset)})`,
    )
  }
  if (typeof raw.datasetRef !== "string" || raw.datasetRef.trim() === "") {
    throw new CanonicalReportIdentityError(
      "a terminal-bench report requires a non-empty datasetRef",
    )
  }
  const outcomesRaw = asRecordField(raw.outcomes, "outcomes")
  const outcomes = {} as Record<TerminalTrialOutcome, number>
  for (const outcome of TERMINAL_TRIAL_OUTCOMES) {
    outcomes[outcome] = asFiniteField(outcomesRaw[outcome], `outcomes.${outcome}`)
  }
  const report: TerminalBenchReport = {
    schemaVersion: TERMINAL_REPORT_SCHEMA_VERSION,
    benchmarkSuite: "terminal-bench",
    benchmarkVersion: TERMINAL_BENCH_VERSION,
    dataset: TERMINAL_BENCH_DATASET_ID,
    datasetRef: raw.datasetRef,
    timestamp: asStringField(raw.timestamp, "timestamp"),
    arm: asStringField(raw.arm, "arm"),
    k: asFiniteField(raw.k, "k"),
    // Never fabricated: an absent model stays undefined, a non-string is refused.
    model: raw.model === undefined ? undefined : asStringField(raw.model, "model"),
    preset: asStringField(raw.preset, "preset"),
    harborJobIds: asStringArrayField(raw.harborJobIds, "harborJobIds"),
    sourcePaths: asStringArrayField(raw.sourcePaths, "sourcePaths"),
    ...put(
      "manifest",
      raw.manifest === undefined ? undefined : decodeManifestSection(raw.manifest),
    ),
    admission: decodeAdmission(raw.admission),
    metrics: raw.metrics === undefined ? undefined : decodeMetrics(raw.metrics),
    outcomes,
    trials: asArrayField(raw.trials, "trials").map(decodeTrialReceipt),
    defects: asArrayField(raw.defects, "defects").map(decodeDefect),
  }
  assertReceiptConsistency(report)
  return report
}
