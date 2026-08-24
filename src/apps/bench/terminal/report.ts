/**
 * TB21-04 — lossless Terminal-Bench 2.1 trial receipts: parse, classify, admit,
 * build. PURE: every input arrives from `harbor-results.ts`, every metric comes
 * from `scoring.ts`, and nothing here touches the filesystem or a clock.
 *
 * The defect this replaces
 * -----------------------
 * `tools/leaderboard-dashboard/tb-report-emit.ts` (DELETED — retirement DB-1)
 * folded a task's trials into one any-pass row. Five k=5 trials became a
 * boolean; trial ids, per-trial cost, tokens and trajectory paths were gone;
 * infra outcomes quietly left the denominator; `k=5` coverage could not be
 * proven. So the unit of this module is the TRIAL, and a task is only ever a
 * grouping key. Its two real contracts were absorbed before deletion: the raw
 * job-tree walk lives in `harbor-results.ts`, and its error taxonomy is the
 * `EXCEPTION_OUTCOMES` table below (widened from 2 kinds to 8 classes).
 *
 * Two invariants hold the honesty of the number:
 *
 *  1. The taxonomy is DIAGNOSTIC. `outcome` explains a trial; it never reaches
 *     `scoring.ts`, which sees rewards only. An errored trial has no reward, so
 *     it scores zero and stays in the denominator — by construction, not by a
 *     rule someone could relax.
 *  2. Nothing is ever invented to reach an expected count. A missing or
 *     malformed trial makes the run INCOMPLETE; it never becomes a fabricated
 *     zero, a fabricated pass, or a silently dropped row.
 *
 * Schema authority (harbor 0.21.0, `harbor.models.trial.result.TrialResult`):
 *   id, task_name, task_id{org,name,ref}, task_checksum, source,
 *   config{task{name,ref}, agent, verifier, environment, *_multiplier},
 *   verifier_result{rewards}, exception_info{exception_type,...},
 *   started_at, finished_at,
 *   agent_result{n_input_tokens, n_cache_tokens, n_output_tokens, cost_usd,
 *                metadata.quanta_agent}
 *
 * Admission authority (terminal-bench-2-1@7131e437,
 * `leaderboard/src/leaderboard/ci/static_analysis.py`): the 89-task set, the
 * >=5-trials-per-task rule, the per-trial task-digest check, the forbidden
 * timeout/resource override keys, and "rewarded trials have trajectories".
 */
import {
  isTerminalVerifyGateState,
  type QuantaTrialFacts,
  TERMINAL_TRIAL_OUTCOMES,
  type TerminalAdmission,
  type TerminalBenchReport,
  type TerminalRejection,
  type TerminalTrialDefect,
  type TerminalTrialOutcome,
  type TerminalTrialReceipt,
  type TerminalVerdict,
} from "@/runner/batch/report-terminal"
import {
  CANONICAL_TASK_IDS,
  canonicalTaskRef,
  EXPECTED_TASK_COUNT,
  isCanonicalTask,
  TERMINAL_BENCH_DATASET,
  TERMINAL_BENCH_DATASET_REF,
} from "./dataset"
import type { HarborTrialFile } from "./harbor-results"
import type { TerminalBenchRunManifest } from "./manifest"
import { computeOfficialMetrics, isSuccess, type ScorableTrial, trialDurationSec } from "./scoring"

// ── taxonomy ─────────────────────────────────────────────────────────────────
//
// The persisted SHAPE of a Terminal report — the outcome vocabulary, the trial
// receipt, the admission record, the report itself — is declared ONCE, in the
// batch layer that owns persistence (`@/runner/batch/report-terminal`). It has
// to be: `@/runner` may not reference `apps/**` even in type position (the
// surface-isolation guard), and BFND-02 puts serialization there. This module
// owns the BEHAVIOUR — parsing, classification, admission — and re-exports the
// vocabulary under the names TB21-04's consumers already use, so there is one
// declaration per field and no drift to police.

export type { QuantaTrialFacts } from "@/runner/batch/report-terminal"
export {
  isTerminalVerifyGateState,
  TERMINAL_TRIAL_OUTCOMES,
  TERMINAL_VERIFY_GATE_STATES,
  type TerminalAdmission,
  type TerminalRejection,
  type TerminalRejectionKind,
  type TerminalTrialDefect,
  type TerminalTrialOutcome,
  type TerminalVerdict,
  type TerminalVerifyGateState,
} from "@/runner/batch/report-terminal"

/** ONE receipt per distinct trial id. Never collapsed, never merged. TB21-04's
 *  name for the batch layer's {@link TerminalTrialReceipt}. */
export type TerminalTrialRecord = TerminalTrialReceipt

/**
 * Harbor exception class -> outcome. Every left-hand side is a REAL class in
 * harbor 0.21.0 (`harbor/trial/errors.py`, `harbor/agents/installed/base.py`,
 * `harbor/environments/base.py`, `harbor/verifier/verifier.py`); harbor records
 * `exception_info.exception_type` as the bare class name.
 *
 * Unrecognised exceptions fall back to `agent_crash` and keep their raw
 * `exceptionType` on the receipt, so an unmapped fault is visible rather than
 * guessed at. The fallback is safe precisely because classification never
 * touches the score.
 */
const EXCEPTION_OUTCOMES: Readonly<Record<string, TerminalTrialOutcome>> = {
  AgentTimeoutError: "agent_timeout",
  AgentSetupTimeoutError: "agent_timeout",
  VerifierTimeoutError: "verifier_error",
  VerifierOutputParseError: "verifier_error",
  AddTestsDirError: "verifier_error",
  EnvironmentStartTimeoutError: "environment_error",
  HealthcheckError: "environment_error",
  SandboxBuildFailedError: "environment_error",
  ServiceOperationsUnsupportedError: "environment_error",
  MemoryLimitExceededError: "environment_error",
  GKEExecStreamClosedError: "environment_error",
}

// ── receipts ────────────────────────────────────────────────────────────────

export const isTrialDefect = (
  value: TerminalTrialRecord | TerminalTrialDefect,
): value is TerminalTrialDefect => !("trialId" in value)

// ── parsing ──────────────────────────────────────────────────────────────────

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const asStringArray = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined

/** Spread-in an optional field ONLY when it has a value. Under
 *  `exactOptionalPropertyTypes` an absent field and a `undefined` field are
 *  different things, and a receipt must never carry an explicit `undefined`. */
const put = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } =>
  value === undefined ? ({} as { [P in K]?: V }) : ({ [key]: value } as { [P in K]?: V })

/**
 * Port of harbor's `_extract_primary_reward` (`harbor/upload/uploader.py:702`) —
 * the exact rule that decides which number the Hub row, and therefore the
 * leaderboard, treats as THE reward: the `reward` key if present, otherwise the
 * sole key when there is exactly one, otherwise none.
 */
const extractPrimaryReward = (
  raw: Record<string, unknown>,
): { readonly reward: number | null; readonly malformed: boolean } => {
  const verifier = asRecord(raw.verifier_result)
  if (verifier === undefined) return { reward: null, malformed: false }
  const rewards = asRecord(verifier.rewards)
  if (rewards === undefined) return { reward: null, malformed: false }
  const keys = Object.keys(rewards)
  if (keys.length === 0) return { reward: null, malformed: false }
  const [onlyKey] = keys
  const picked =
    "reward" in rewards
      ? rewards.reward
      : keys.length === 1 && onlyKey !== undefined
        ? rewards[onlyKey]
        : undefined
  if (picked === undefined) {
    // Several named rewards and no `reward` key: harbor itself cannot name a
    // primary reward, so neither can we. Never guess one.
    return { reward: null, malformed: true }
  }
  const numeric = asFiniteNumber(picked)
  return numeric === null
    ? { reward: null, malformed: true }
    : { reward: numeric, malformed: false }
}

/** Upstream `static_analysis` forbidden-key sets, verbatim. */
const MULTIPLIER_KEYS = [
  "agent_timeout_multiplier",
  "verifier_timeout_multiplier",
  "agent_setup_timeout_multiplier",
  "environment_build_timeout_multiplier",
] as const
const AGENT_OVERRIDE_KEYS = [
  "override_timeout_sec",
  "override_setup_timeout_sec",
  "max_timeout_sec",
] as const
const VERIFIER_OVERRIDE_KEYS = ["override_timeout_sec", "max_timeout_sec"] as const
const ENVIRONMENT_OVERRIDE_KEYS = [
  "override_cpus",
  "override_gpus",
  "override_memory_mb",
  "override_storage_mb",
] as const

const sectionOverrides = (
  section: Record<string, unknown> | undefined,
  keys: readonly string[],
  prefix: string,
): string[] =>
  section === undefined
    ? []
    : keys
        .filter((key) => section[key] !== undefined && section[key] !== null)
        .map((key) => `${prefix}${key}=${String(section[key])}`)

/** Port of upstream `trial_config_failures`: the standard-config check applied to
 *  a trial's OWN resolved config (the anti-tampering the job config cannot give). */
const configOverridesOf = (config: Record<string, unknown> | undefined): readonly string[] => {
  if (config === undefined) return []
  const multiplier = config.timeout_multiplier
  const out: string[] = []
  if (multiplier !== undefined && multiplier !== null && multiplier !== 1) {
    out.push(`timeout_multiplier=${String(multiplier)}`)
  }
  out.push(...sectionOverrides(config, MULTIPLIER_KEYS, ""))
  out.push(...sectionOverrides(asRecord(config.agent), AGENT_OVERRIDE_KEYS, "agent."))
  out.push(...sectionOverrides(asRecord(config.verifier), VERIFIER_OVERRIDE_KEYS, "verifier."))
  out.push(
    ...sectionOverrides(asRecord(config.environment), ENVIRONMENT_OVERRIDE_KEYS, "environment."),
  )
  return out
}

const parseQuantaFacts = (
  agentResult: Record<string, unknown> | undefined,
): QuantaTrialFacts | undefined => {
  const metadata = asRecord(agentResult?.metadata)
  const receipt = asRecord(metadata?.quanta_agent)
  if (receipt === undefined) return undefined
  const promotability = asRecord(receipt.promotability)
  // TB21-06 AP-9. The verify-gate stamp is a SIBLING of `quanta_agent` under
  // metadata (the adapter spreads the brain report there verbatim), not part of
  // the provenance receipt. An unrecognised value is DROPPED, never coerced:
  // "no stamp" and "unverifiable" are different facts about a run.
  const verifyGateState = asString(asRecord(metadata?.verification)?.state)
  return {
    ...put(
      "verifyGateState",
      isTerminalVerifyGateState(verifyGateState) ? verifyGateState : undefined,
    ),
    ...put("agentVersion", asString(receipt.version)),
    ...put("packageVersion", asString(receipt.package_version)),
    ...put("commit", asString(receipt.commit)),
    ...put("dirty", typeof receipt.dirty === "boolean" ? receipt.dirty : undefined),
    ...put("model", asString(receipt.model)),
    ...put("reasoningEffort", asString(receipt.reasoning_effort)),
    ...put(
      "reasoningEffortWireHonored",
      typeof receipt.reasoning_effort_wire_honored === "boolean"
        ? receipt.reasoning_effort_wire_honored
        : undefined,
    ),
    ...put("termination", asString(receipt.termination)),
    ...put(
      "promotable",
      typeof promotability?.promotable === "boolean" ? promotability.promotable : undefined,
    ),
    ...put("promotabilityReasons", asStringArray(promotability?.reasons)),
    ...put("atifErrors", asStringArray(receipt.atif_errors)),
  }
}

/**
 * Did the agent issue ANY model call? Harbor puts the three token counters on
 * `agent_result`; an agent that never reached its provider reports all three as
 * `null`.
 *
 * MEASURED aug-22 on the first two live 2.1 canaries: the one whose brain failed
 * to launch reported `n_input_tokens/n_cache_tokens/n_output_tokens = null` with
 * `exception_info: null` and `reward: 0.0`; the working one reported 51 175 /
 * 4 742. Harbor cannot tell these apart — it saw a completed trial both times.
 */
const hasAgentActivity = (t: TrialTokenCounters): boolean =>
  t.inputTokens !== null || t.cacheTokens !== null || t.outputTokens !== null

interface TrialTokenCounters {
  readonly inputTokens: number | null
  readonly cacheTokens: number | null
  readonly outputTokens: number | null
}

const classify = (
  reward: number | null,
  exceptionType: string | undefined,
  malformed: boolean,
  tokens: TrialTokenCounters,
): TerminalTrialOutcome => {
  if (malformed) return "malformed_result"
  if (exceptionType !== undefined) {
    return EXCEPTION_OUTCOMES[exceptionType] ?? "agent_crash"
  }
  if (reward === null) return "missing_reward"
  if (isSuccess(reward)) return "graded_pass"
  // NARROW BY DESIGN. Only a non-passing, exception-free trial with NO telemetry
  // at all is reclassified:
  //   * a PASS is never demoted — a scored success is a success however quiet;
  //   * partial telemetry is an ATTEMPT, so an agent that burned tokens and lost
  //     stays a real `graded_fail` and the arm keeps its honest miss.
  // Anything wider would let a provider that under-reports usage launder real
  // failures out of the denominator, which is the mirror of the bug being fixed.
  return hasAgentActivity(tokens) ? "graded_fail" : "no_agent_activity"
}

/**
 * One Harbor `result.json` -> one receipt. Pure: the only filesystem knowledge it
 * consumes is what `harbor-results.ts` already put on the {@link HarborTrialFile}
 * (source path, trajectory presence).
 *
 * Returns a {@link TerminalTrialDefect} when the record cannot be keyed by a trial
 * id at all — the one situation where no receipt can exist. It never returns a
 * synthesised trial.
 */
/**
 * The task this trial ran, resolved across the three places Harbor may record it.
 *
 * A unit because these are ONE identity with a precedence order: the config's task name
 * wins, then the `task_id` package coordinate — usable only when BOTH org and name are
 * present, so a half-filled record falls through rather than keying the report on
 * "undefined/foo" — and finally the trial's own task_name. `taskRef` follows the same
 * two sources in the same order, which is why it is resolved here and not separately.
 */
const resolveTrialTaskIdentity = (
  raw: Record<string, unknown>,
  config: Record<string, unknown> | undefined,
  taskName: string,
): { readonly taskId: string; readonly taskRef: string | undefined } => {
  const configTask = asRecord(config?.task)
  const taskIdRecord = asRecord(raw.task_id)
  const packageTaskId =
    asString(taskIdRecord?.org) !== undefined && asString(taskIdRecord?.name) !== undefined
      ? `${String(taskIdRecord?.org)}/${String(taskIdRecord?.name)}`
      : undefined
  return {
    taskId: asString(configTask?.name) ?? packageTaskId ?? taskName,
    taskRef: asString(configTask?.ref) ?? asString(taskIdRecord?.ref),
  }
}

export const parseHarborTrialResult = (
  file: HarborTrialFile,
): TerminalTrialRecord | TerminalTrialDefect => {
  const defect = (reason: string): TerminalTrialDefect => ({ sourcePath: file.sourcePath, reason })
  if (file.raw === undefined) return defect(file.readError ?? "no result.json payload")
  const raw = asRecord(file.raw)
  if (raw === undefined) return defect("result.json is not a JSON object")

  const trialId = asString(raw.id)
  if (trialId === undefined) return defect("result.json has no trial id")
  const taskName = asString(raw.task_name)
  if (taskName === undefined) return defect(`trial ${trialId} has no task_name`)

  const config = asRecord(raw.config)
  const { taskId, taskRef } = resolveTrialTaskIdentity(raw, config, taskName)

  const { reward, malformed } = extractPrimaryReward(raw)
  const exception = asRecord(raw.exception_info)
  const exceptionType = asString(exception?.exception_type)
  const agentResult = asRecord(raw.agent_result)
  const inputTokens = asFiniteNumber(agentResult?.n_input_tokens)
  const cacheTokens = asFiniteNumber(agentResult?.n_cache_tokens)
  const quanta = parseQuantaFacts(agentResult)
  const startedAt = asString(raw.started_at) ?? null
  const finishedAt = asString(raw.finished_at) ?? null

  return {
    trialId,
    ...put("trialName", asString(raw.trial_name)),
    taskId,
    taskName,
    ...put("taskRef", taskRef),
    ...put("taskChecksum", asString(raw.task_checksum)),
    ...put("datasetSource", asString(raw.source)),
    reward,
    outcome: classify(reward, exceptionType, malformed || config === undefined, {
      inputTokens,
      cacheTokens,
      outputTokens: asFiniteNumber(agentResult?.n_output_tokens),
    }),
    ...put("exceptionType", exceptionType),
    ...put("exceptionMessage", asString(exception?.exception_message)),
    startedAt,
    finishedAt,
    durationSec: trialDurationSec(startedAt, finishedAt),
    // Harbor's convention: n_input_tokens INCLUDES cache. Split it the way the
    // upstream resource metric wants, clamped for agents reporting them disjoint.
    uncachedInputTokens:
      inputTokens === null ? null : Math.max(inputTokens - (cacheTokens ?? 0), 0),
    cachedInputTokens: cacheTokens,
    outputTokens: asFiniteNumber(agentResult?.n_output_tokens),
    costUsd: asFiniteNumber(agentResult?.cost_usd),
    ...(file.trajectoryPath !== undefined
      ? {
          trajectoryPath: file.trajectoryPath,
          atifValid: (quanta?.atifErrors ?? []).length === 0,
        }
      : {}),
    ...(quanta !== undefined ? { quanta } : {}),
    configOverrides: configOverridesOf(config),
    sourcePath: file.sourcePath,
  }
}

// ── admission ────────────────────────────────────────────────────────────────

const duplicateIdsOf = (trials: readonly TerminalTrialRecord[]): readonly string[] => {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const trial of trials) {
    if (seen.has(trial.trialId)) duplicates.add(trial.trialId)
    seen.add(trial.trialId)
  }
  return [...duplicates]
}

const rejectionsOf = (trials: readonly TerminalTrialRecord[]): readonly TerminalRejection[] => {
  const out: TerminalRejection[] = []
  for (const trial of trials) {
    if (trial.datasetSource !== undefined && trial.datasetSource !== TERMINAL_BENCH_DATASET) {
      out.push({
        kind: "dataset_source_mismatch",
        trialId: trial.trialId,
        detail: `${trial.datasetSource} != ${TERMINAL_BENCH_DATASET}`,
      })
    }
    if (!isCanonicalTask(trial.taskId)) {
      out.push({
        kind: "unknown_task",
        trialId: trial.trialId,
        detail: `${trial.taskId} is not in the pinned dataset`,
      })
      continue
    }
    if (trial.taskRef === undefined) {
      out.push({
        kind: "missing_task_ref",
        trialId: trial.trialId,
        detail: `${trial.taskId} carries no task version (a versionless TB2.0 artifact)`,
      })
      continue
    }
    const expected = canonicalTaskRef(trial.taskId)
    if (trial.taskRef !== expected) {
      out.push({
        kind: "task_ref_mismatch",
        trialId: trial.trialId,
        detail: `${trial.taskId} ran ${trial.taskRef}, canonical is ${String(expected)}`,
      })
    }
  }
  return out
}

const admit = (
  trials: readonly TerminalTrialRecord[],
  defects: readonly TerminalTrialDefect[],
  k: number,
): TerminalAdmission => {
  const duplicateTrialIds = duplicateIdsOf(trials)
  const rejections = rejectionsOf(trials)

  const perTask = new Map<string, number>()
  for (const trial of trials) perTask.set(trial.taskId, (perTask.get(trial.taskId) ?? 0) + 1)

  const expectedTrials = EXPECTED_TASK_COUNT * k
  const admittedTrials = trials.length
  const shortTasks = [...perTask.values()].filter((count) => count !== k).length
  const missingReward = trials.filter((t) => t.outcome === "missing_reward").length
  const malformed = trials.filter((t) => t.outcome === "malformed_result").length
  // Same class as `missing_reward` / `malformed_result`: not a scoreable model
  // result. The dangerous one, though — Harbor reports an unattempted trial as a
  // perfectly normal completed trial, so without this a whole campaign of them
  // would be admitted as a legitimate 0%.
  const noAgentActivity = trials.filter((t) => t.outcome === "no_agent_activity").length
  const overridden = trials.filter((t) => t.configOverrides.length > 0)
  const rewardedWithoutTrajectory = trials.filter(
    (t) => isSuccess(t.reward) && t.trajectoryPath === undefined,
  ).length

  const reasons: string[] = []
  if (duplicateTrialIds.length > 0) reasons.push(`duplicate-trial-ids:${duplicateTrialIds.length}`)
  for (const rejection of new Set(rejections.map((r) => r.kind))) {
    reasons.push(
      `${rejection.replaceAll("_", "-")}:${rejections.filter((r) => r.kind === rejection).length}`,
    )
  }
  if (perTask.size !== EXPECTED_TASK_COUNT) {
    reasons.push(`tasks:${perTask.size}/${EXPECTED_TASK_COUNT}`)
  }
  if (admittedTrials !== expectedTrials) {
    reasons.push(`admitted-trials:${admittedTrials}/${expectedTrials}`)
  }
  if (shortTasks > 0) reasons.push(`tasks-not-at-k${k}:${shortTasks}`)
  if (missingReward > 0) reasons.push(`missing-reward:${missingReward}`)
  if (malformed > 0) reasons.push(`malformed-result:${malformed}`)
  if (noAgentActivity > 0) reasons.push(`no-agent-activity:${noAgentActivity}`)
  if (defects.length > 0) reasons.push(`unreadable-trial-records:${defects.length}`)
  if (overridden.length > 0) {
    reasons.push(`nonstandard-config:${overridden.length} (${overridden[0]?.configOverrides[0]})`)
  }
  if (rewardedWithoutTrajectory > 0) {
    reasons.push(`rewarded-trials-without-trajectory:${rewardedWithoutTrajectory}`)
  }

  // Deliberately MINIMAL and non-redundant: "89 tasks" plus "every task at
  // exactly k" already implies "89*k admitted trials", so adding the count as a
  // third clause would make each of the three individually deletable without a
  // test noticing. `admittedTrials` is still REPORTED (and shows up in
  // `reasons`) — it is just not a second way to derive the same fact.
  const complete =
    perTask.size === EXPECTED_TASK_COUNT &&
    shortTasks === 0 &&
    missingReward === 0 &&
    malformed === 0 &&
    noAgentActivity === 0 &&
    defects.length === 0
  const standardConfig = overridden.length === 0
  const rejected = duplicateTrialIds.length > 0 || rejections.length > 0
  const verdict: TerminalVerdict = rejected
    ? "rejected"
    : !complete
      ? "incomplete"
      : standardConfig
        ? "official"
        : "nonstandard"

  return {
    verdict,
    complete,
    standardConfig,
    promotable: verdict === "official" && rewardedWithoutTrajectory === 0,
    k,
    expectedTaskCount: EXPECTED_TASK_COUNT,
    observedTaskCount: perTask.size,
    expectedTrials,
    admittedTrials,
    duplicateTrialIds,
    rejections,
    reasons,
  }
}

// ── the report ───────────────────────────────────────────────────────────────

export interface TerminalRunInput {
  /** The pinned dataset ref. Fails closed: identity is never inferred. */
  readonly datasetRef: string
  readonly timestamp: string
  /** Experiment arm. Baseline and lever runs are scored SEPARATELY, always. */
  readonly arm: string
  /** Trials per task the run intended: 1 or {@link MIN_TRIALS_PER_TASK}. */
  readonly k: number
  readonly harborJobIds: readonly string[]
  readonly sourcePaths: readonly string[]
  /** Never fabricated — an unknown model stays undefined. */
  readonly model: string | undefined
  readonly preset: string
  readonly trials: readonly TerminalTrialRecord[]
  readonly defects: readonly TerminalTrialDefect[]
  /** TB21-03's run manifest, carried through verbatim. TYPE-ONLY dependency:
   *  this module still owns none of the provenance — it neither builds nor
   *  validates the manifest — but the `unknown` placeholder is now NARROWED to
   *  the real contract (the deferred TB21-03 adoption). That makes the two
   *  hand-off points a COMPILE-time link: a manifest field rename can no longer
   *  slip through a report that carries an opaque blob. */
  readonly manifest?: TerminalBenchRunManifest
  /** Trial ids disqualified by the upstream reward-hacking judge. They join the
   *  metric as reward 0 — never removed from the denominator. */
  readonly disqualifiedTrialIds?: readonly string[]
}

/**
 * THE canonical Terminal-Bench 2.1 run report.
 *
 * It IS the persisted branch of {@link CanonicalBenchReport} — not a parallel
 * shape that has to be mapped onto one. `writeReport` therefore accepts it
 * directly, which is what closes the old gap where a run could be scored
 * losslessly in memory and flattened on the way to disk.
 *
 * The ONE thing narrowed here is `manifest`: the batch layer types it as the
 * provenance CORE it can validate ({@link TerminalRunManifestSection}), while a
 * report built by this module always carries TB21-03's full manifest. The
 * narrowing is a compile-time link in both directions — a field renamed on
 * either side fails to satisfy the `extends`.
 */
export interface TerminalRunReport extends TerminalBenchReport {
  readonly manifest?: TerminalBenchRunManifest
}

const toScorable = (trial: TerminalTrialRecord): ScorableTrial => ({
  id: trial.trialId,
  taskName: trial.taskId,
  reward: trial.reward,
  // Re-join the split the receipt stores, because the upstream resource metric
  // expects harbor's "input INCLUDES cache" convention.
  inputTokens:
    trial.uncachedInputTokens === null
      ? null
      : trial.uncachedInputTokens + (trial.cachedInputTokens ?? 0),
  cacheTokens: trial.cachedInputTokens,
  outputTokens: trial.outputTokens,
  costUsd: trial.costUsd,
  startedAt: trial.startedAt,
  finishedAt: trial.finishedAt,
})

const countOutcomes = (
  trials: readonly TerminalTrialRecord[],
): Readonly<Record<TerminalTrialOutcome, number>> => {
  const counts = Object.fromEntries(TERMINAL_TRIAL_OUTCOMES.map((kind) => [kind, 0])) as Record<
    TerminalTrialOutcome,
    number
  >
  for (const trial of trials) counts[trial.outcome] += 1
  return counts
}

/**
 * Build the canonical Terminal-Bench 2.1 run report. Pure and deterministic.
 *
 * Fails closed on the two things that would make a number meaningless:
 *  - a dataset ref that is not the pinned one (identity is never inferred);
 *  - a trial set spanning more than one arm (a baseline/lever union score).
 */
export const buildTerminalRunReport = (input: TerminalRunInput): TerminalRunReport => {
  if (input.datasetRef !== TERMINAL_BENCH_DATASET_REF) {
    throw new Error(
      `terminal-bench report requires the pinned datasetRef ${TERMINAL_BENCH_DATASET_REF}; ` +
        `got ${JSON.stringify(input.datasetRef)} — identity is never inferred or fabricated`,
    )
  }
  const arms = new Set(input.trials.map((t) => t.arm).filter((a): a is string => a !== undefined))
  if (arms.size > 1) {
    throw new Error(
      `terminal-bench report refuses a trial set spanning ${arms.size} arms ` +
        `(${[...arms].sort().join(", ")}); baseline and lever runs are scored separately`,
    )
  }
  const [only] = arms
  if (only !== undefined && only !== input.arm) {
    throw new Error(
      `terminal-bench report arm mismatch: the run declares "${input.arm}" but its trials ` +
        `carry "${only}"; baseline and lever runs never union into one metric`,
    )
  }

  const admission = admit(input.trials, input.defects, input.k)
  return {
    schemaVersion: "terminal-bench-report/v2",
    benchmarkSuite: "terminal-bench",
    benchmarkVersion: "2.1",
    dataset: TERMINAL_BENCH_DATASET,
    datasetRef: input.datasetRef,
    timestamp: input.timestamp,
    arm: input.arm,
    k: input.k,
    model: input.model,
    preset: input.preset,
    harborJobIds: input.harborJobIds,
    sourcePaths: input.sourcePaths,
    ...(input.manifest !== undefined ? { manifest: input.manifest } : {}),
    admission,
    metrics:
      admission.verdict === "rejected"
        ? undefined
        : computeOfficialMetrics(input.trials.map(toScorable), input.disqualifiedTrialIds ?? []),
    outcomes: countOutcomes(input.trials),
    trials: input.trials,
    defects: input.defects,
  }
}

/** The canonical task set this report is admitted against. Re-exported so a
 *  consumer never re-derives the expected set from a directory listing. */
export { CANONICAL_TASK_IDS }
