/**
 * PMX-06 — THE SIX STAGED GATES, as pure predicates over the landed receipts.
 *
 * *"Close the integration with the cheapest authoritative sequence and forbid an
 * expensive Full-170 model run on an unverified evaluator/image fleet."*
 *
 * ```text
 *   1 PMX-7 gold      sentinel apply_failed / golden success, 7/7, full provenance
 *   2 PMX-7 model     7/7 grading-valid, zero infra/ambiguous/missing, leak check on
 *   3 PMX-14 canary   14/14 grading-valid, no unknown outcome reason
 *   4 PMX-40 paired   same manifest/images/model/effort/budgets + PREDECLARED rule
 *   5 PMX-170 gold    170/170, or a versioned exception manifest that keeps 170 assigned
 *   6 PMX-170 model   only after 1-5, clean SHA, chunk coverage, frozen retry policy
 * ```
 *
 * ## Three properties this module is built around
 *
 * THE RECORD IS A PRECONDITION. Every gate takes
 * `record: ProMaxFrozenCampaignRecord | undefined` and refuses `record_absent`
 * when there is none. Evidence additionally cites `frozenRecordSha256`, so a run
 * judged against one record and reported against another is refused rather than
 * merged.
 *
 * `passed` IS NEVER READ. Not once, anywhere in this file. Upstream computes it
 * as `model.final_result == "success" and golden.final_result == "success"`
 * (PMX-00A: at the pinned commit it carries no independent information at all),
 * and a drifted or forged document could set it freely. The gates read the two
 * NESTED verdicts through PMX-03's classifier and PMX-04's sentinel gate.
 *
 * THE CONTINUATION RULE IS PREDECLARED OR IT IS NOTHING. The rule lives in the
 * frozen record — whose digest changes if it is edited — and gate 4 additionally
 * requires each arm's results to be OBSERVED AFTER the freeze. A rule written
 * once the numbers exist can be written to fit them, so a gate that reads one
 * must fail.
 *
 * PURE: no I/O, no clock, no env. A live campaign driver reads artefacts and
 * calls these; nothing here can spend.
 */

import type { ProMaxImageFreezeReceipt } from "@/apps/bench/harness/promax"
import {
  assertImageFreezeReadyForModelLaunch,
  evaluateGoldSentinelGate,
  isOfficialFinalResult,
} from "@/apps/bench/harness/promax"
import type {
  OfficialGradeReceipt,
  OfficialGradeState,
  OfficialGradeSummary,
} from "@/runner/batch/eval/official-grade"
import { summarizeOfficialGrade } from "@/runner/batch/eval/official-grade"
import { errMessage } from "@/shared"
import type { ProMaxExceptionManifest } from "./exceptions"
import { exceptionEntriesOf, validateExceptionManifest } from "./exceptions"
import type { ProMaxGateSink } from "./gate-clauses"
import {
  auditFullRunCoverage,
  auditModelRunIdentity,
  auditPairedImageParity,
  PROMAX_LEAKAGE_CHECK_IDS,
  PROMAX_LEAKAGE_CHECKS,
  type ProMaxLeakageCheckId,
  receiptPairedInstances,
  receiptResolvedCount,
  reconcileArmRowsWithReceipt,
} from "./gate-clauses"
import type { ProMaxCampaignBudgets, ProMaxFrozenCampaignRecord } from "./record"
import { proMaxCampaignSample } from "./record"

// ── the gate vocabulary ─────────────────────────────────────────────────────

export const PROMAX_GATE_ORDER = [
  "gate1_pmx7_gold",
  "gate2_pmx7_model",
  "gate3_pmx14_canary",
  "gate4_pmx40_paired",
  "gate5_pmx170_gold",
  "gate6_pmx170_model",
] as const

export type ProMaxGateId = (typeof PROMAX_GATE_ORDER)[number]

/** The frozen sample each gate is accountable for. `Record<GateId, string>` so a
 *  new gate cannot be added without saying what it grades. */
export const PROMAX_GATE_SAMPLE: Record<ProMaxGateId, string> = {
  gate1_pmx7_gold: "PMX-7",
  gate2_pmx7_model: "PMX-7",
  gate3_pmx14_canary: "PMX-14",
  gate4_pmx40_paired: "PMX-40",
  gate5_pmx170_gold: "PMX-170",
  gate6_pmx170_model: "PMX-170",
}

/**
 * The agent/grader LEAKAGE CHECKS every model-spending gate requires. Defined in
 * `./gate-clauses` beside the clause that enforces them and re-exported here so
 * this module stays the ONE import surface for the gate vocabulary.
 */
export { PROMAX_LEAKAGE_CHECK_IDS, PROMAX_LEAKAGE_CHECKS, type ProMaxLeakageCheckId }

/** Every way a gate can refuse. Closed, each with a human reason. */
export const PROMAX_GATE_FAILURE_REASONS = {
  record_absent:
    "no frozen campaign record — recording the inputs is a precondition of a gated run",
  record_digest_mismatch: "the evidence cites a different frozen campaign record",
  sample_mismatch: "the assigned set is not this gate's frozen sample, in order",
  attempt_incomplete: "an assigned instance was never reported on by the evaluator",
  golden_not_success: "the reference patch did not pass in this image",
  sentinel_not_apply_failed:
    "the gold sentinel did not apply-fail, so the preflight proves nothing",
  image_provenance_incomplete: "the image freeze does not cover the assigned set with digest pins",
  upstream_provenance_mismatch:
    "the evaluator or image freeze is pinned to another upstream commit",
  grading_invalid_present: "the run carries infra-invalid, ambiguous or missing rows",
  leakage_check_disabled: "an agent/grader leakage check was not enabled for this run",
  provenance_incomplete:
    "the run's model/preset/quanta provenance disagrees with the frozen record",
  outcome_reason_unknown: "the evaluator emitted an outcome the pinned schema does not define",
  paired_manifest_mismatch: "the two arms did not run the same ordered manifest",
  paired_image_mismatch: "the two arms ran different images for the same instance",
  paired_config_mismatch: "the two arms differ in something other than their declared variable",
  paired_row_missing: "an assigned instance has no paired row in one of the arms",
  paired_rows_receipt_mismatch:
    "an arm's paired rows disagree with its own official-grade receipt, so the continuation number was never reconciled",
  paired_metric_missing: "a paired row carries no usable cost, turn count or wall time",
  continuation_rule_not_predeclared: "the results are not newer than the record that judges them",
  continuation_rule_stop: "the predeclared continuation rule says stop",
  exception_manifest_required: "a gold shortfall with no versioned upstream-exception manifest",
  exception_manifest_invalid: "the exception manifest is not a complete versioned record",
  exception_unjustified: "an exception was filed for an instance that is not failing",
  exception_shrinks_assigned: "an excepted instance was removed from the assigned set",
  prior_gate_not_passed: "an earlier gate did not pass, or was never run",
  quanta_dirty: "the run was made from a dirty tree",
  quanta_sha_mismatch: "the run was made from a different Quanta commit than the record froze",
  chunk_coverage_incomplete: "the chunks do not cover the assigned set",
  chunk_overlap: "two chunks claim the same instance",
  retry_not_exhausted: "a lost chunk was abandoned before the frozen retry policy was exhausted",
  exhausted_row_not_missing: "a row from a lost chunk was scored instead of left missing",
} as const

export type ProMaxGateFailureCode = keyof typeof PROMAX_GATE_FAILURE_REASONS

export const PROMAX_GATE_FAILURE_CODES = Object.keys(
  PROMAX_GATE_FAILURE_REASONS,
) as readonly ProMaxGateFailureCode[]

export interface ProMaxGateFailure {
  readonly gate: ProMaxGateId
  readonly code: ProMaxGateFailureCode
  readonly message: string
}

/** Campaign readiness coverage: `assigned` NEVER shrinks (README score contract). */
export interface ProMaxGateCoverage {
  readonly assigned: number
  readonly valid: number
  readonly exceptions: number
}

export interface ProMaxContinuationOutcome {
  readonly pairedInstances: number
  readonly resolvedDelta: number
  readonly costUsdDelta: number
  readonly continue: boolean
}

export interface ProMaxGateResult {
  readonly gate: ProMaxGateId
  readonly ok: boolean
  readonly failures: readonly ProMaxGateFailure[]
  readonly summary: OfficialGradeSummary | null
  readonly coverage?: ProMaxGateCoverage
  readonly continuation?: ProMaxContinuationOutcome
}

// ── evidence ────────────────────────────────────────────────────────────────

/** What one graded stage produced. */
export interface ProMaxStageEvidence {
  /** The digest of the frozen record this stage was run under. */
  readonly frozenRecordSha256: string
  /** ISO instant the results were observed. Must be AFTER the freeze. */
  readonly observedAt: string
  readonly receipt: OfficialGradeReceipt
  readonly imageFreeze: ProMaxImageFreezeReceipt
  readonly quanta: { readonly sha: string; readonly dirty: boolean }
}

/**
 * A stage that spent model tokens carries its run identity too.
 *
 * `budgets` is REQUIRED, not optional. The ticket asks gate 4 for *"the same
 * ordered PMX-40 manifest, images, model, reasoning effort, and budgets"*, and a
 * budget is the cheapest thing in that list to change by accident: a turn or
 * wall-clock ceiling raised for one arm turns any resolved delta into a budget
 * effect wearing the candidate's name. An optional field would have let a run
 * satisfy the comparison by not reporting the number, so omitting it is a
 * COMPILE error instead.
 */
export interface ProMaxModelStageEvidence extends ProMaxStageEvidence {
  readonly preset: string
  readonly model: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffortDelivered: string | null
  }
  readonly budgets: ProMaxCampaignBudgets
  readonly leakageChecks: readonly ProMaxLeakageCheckId[]
}

export interface ProMaxPairedRow {
  readonly instanceId: string
  readonly state: OfficialGradeState | "missing"
  readonly costUsd: number
  readonly turns: number
  readonly wallMs: number
}

export interface ProMaxArmEvidence {
  readonly armName: string
  readonly preset: string
  readonly evidence: ProMaxModelStageEvidence
  readonly rows: readonly ProMaxPairedRow[]
}

export interface ProMaxChunkEvidence {
  readonly chunkId: string
  readonly assignedInstanceIds: readonly string[]
  readonly attempts: number
  readonly delivered: boolean
}

// ── shared clauses ──────────────────────────────────────────────────────────

type Sink = ProMaxGateSink

const orderedEqual = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i])

/** The record binding every gate shares. Returns the frozen sample ids, or null
 *  when there is nothing to judge against. */
const bindRecord = (
  record: ProMaxFrozenCampaignRecord | undefined,
  sampleName: string,
  evidence: Pick<ProMaxStageEvidence, "frozenRecordSha256">,
  add: Sink,
): readonly string[] | null => {
  if (record === undefined) {
    add("record_absent", PROMAX_GATE_FAILURE_REASONS.record_absent)
    return null
  }
  if (evidence.frozenRecordSha256 !== record.sha256) {
    add(
      "record_digest_mismatch",
      `the evidence cites frozen record ${evidence.frozenRecordSha256} but this gate is judging ${record.sha256}`,
    )
  }
  const sample = proMaxCampaignSample(record, sampleName)
  if (sample === undefined) {
    add("sample_mismatch", `the frozen record carries no sample named "${sampleName}"`)
    return null
  }
  return sample.instanceIds
}

const auditSampleAndAttempts = (
  expected: readonly string[],
  receipt: OfficialGradeReceipt,
  sampleName: string,
  add: Sink,
): void => {
  if (!orderedEqual(receipt.assignedInstanceIds, expected)) {
    add(
      "sample_mismatch",
      `this gate grades ${sampleName} (${expected.length} ids, in the manifest's order) but the ` +
        `receipt assigns ${receipt.assignedInstanceIds.length} id(s) in a different set or order`,
    )
  }
  const unattempted = receipt.assignedInstanceIds.filter(
    (id) => !receipt.dispositionsByInstanceId.has(id),
  )
  if (unattempted.length > 0) {
    add(
      "attempt_incomplete",
      `${unattempted.length}/${receipt.assignedInstanceIds.length} assigned instance(s) were never ` +
        `reported on by the evaluator (${unattempted.slice(0, 3).join(", ")})`,
    )
  }
}

const auditImageProvenance = (
  imageFreeze: ProMaxImageFreezeReceipt,
  assigned: readonly string[],
  record: ProMaxFrozenCampaignRecord,
  receipt: OfficialGradeReceipt,
  add: Sink,
): void => {
  try {
    assertImageFreezeReadyForModelLaunch(imageFreeze, assigned)
  } catch (err) {
    add("image_provenance_incomplete", errMessage(err))
  }
  if (imageFreeze.upstream_git_commit !== record.upstream.git_commit) {
    add(
      "upstream_provenance_mismatch",
      `the image freeze is pinned to upstream ${imageFreeze.upstream_git_commit}, the campaign to ${record.upstream.git_commit}`,
    )
  }
  if (receipt.evaluator.upstreamCommit !== record.upstream.git_commit) {
    add(
      "upstream_provenance_mismatch",
      `the evaluator ran at upstream ${receipt.evaluator.upstreamCommit}, the campaign froze ${record.upstream.git_commit}`,
    )
  }
  if (receipt.evaluator.evaluatorSha256 !== record.upstream.evaluator_sha256) {
    add(
      "upstream_provenance_mismatch",
      `the evaluator hashes to ${receipt.evaluator.evaluatorSha256}, the campaign froze ${record.upstream.evaluator_sha256}`,
    )
  }
}

/**
 * The run's budgets against the frozen ones, field by field. The failure CODE is
 * the caller's, because the same disagreement means different things: on a
 * single stage it is incomplete provenance, between two arms it is a config
 * difference that voids the pairing.
 */
const auditBudgets = (
  what: string,
  budgets: ProMaxCampaignBudgets,
  record: ProMaxFrozenCampaignRecord,
  code: ProMaxGateFailureCode,
  add: Sink,
): void => {
  const differing = (["maxTurns", "maxTokens", "wallClockMs"] as const).filter(
    (field) => budgets[field] !== record.budgets[field],
  )
  if (differing.length === 0) return
  add(
    code,
    `${what} ran budgets the campaign did not freeze: ` +
      `${differing.map((f) => `${f} ${String(budgets[f])} ≠ ${String(record.budgets[f])}`).join(", ")}`,
  )
}

const auditQuanta = (
  quanta: { readonly sha: string; readonly dirty: boolean },
  record: ProMaxFrozenCampaignRecord,
  add: Sink,
): void => {
  if (quanta.dirty) {
    add("quanta_dirty", "the run was made from a dirty tree — a dirty overlay is not a result")
  }
  if (quanta.sha !== record.quanta.sha) {
    add(
      "quanta_sha_mismatch",
      `the run was made from ${quanta.sha} but the campaign froze ${record.quanta.sha}`,
    )
  }
}

// ── gates 1 and 5 — the gold sentinel gates ─────────────────────────────────

export interface ProMaxGoldGateInput {
  readonly record: ProMaxFrozenCampaignRecord | undefined
  /** `PMX-7` for gate 1, `PMX-170` for gate 5. */
  readonly sampleName: string
  readonly evidence: ProMaxStageEvidence
  /** Gate 5 only: the versioned manifest covering an upstream shortfall. */
  readonly exceptions?: ProMaxExceptionManifest
}

const GOLD_FAILURE_CODE = {
  sentinel_missing: "attempt_incomplete",
  golden_not_success: "golden_not_success",
  model_not_apply_failed: "sentinel_not_apply_failed",
} as const satisfies Record<string, ProMaxGateFailureCode>

/**
 * Reconcile a versioned exception manifest against the instances that ACTUALLY
 * failed the gold preflight, and record which ones it legitimately covers.
 *
 * The two refusals here are what stop an exception from being an escape hatch:
 * an entry for an instance the campaign no longer assigns is a denominator
 * shrink, and an entry for a PASSING instance is a pre-emptive excuse.
 */
const reconcileExceptions = (
  args: {
    readonly manifest: ProMaxExceptionManifest
    readonly record: ProMaxFrozenCampaignRecord
    readonly receipt: OfficialGradeReceipt
    readonly failingIds: ReadonlySet<string>
  },
  excepted: Set<string>,
  add: Sink,
): void => {
  const problems = validateExceptionManifest({
    manifest: args.manifest,
    campaignId: args.record.campaign_id,
    upstreamGitCommit: args.record.upstream.git_commit,
    requiredVersion: args.record.exception_policy.manifestVersion,
  })
  for (const problem of problems) add("exception_manifest_invalid", problem)
  const assigned = new Set(args.receipt.assignedInstanceIds)
  for (const entry of exceptionEntriesOf(args.manifest)) {
    if (!assigned.has(entry.instance_id)) {
      add(
        "exception_shrinks_assigned",
        `instance "${entry.instance_id}" is excepted but is not in the assigned set — an ` +
          "exception documents a failure, it does not remove the row from the denominator",
      )
      continue
    }
    if (!args.failingIds.has(entry.instance_id)) {
      add(
        "exception_unjustified",
        `instance "${entry.instance_id}" is excepted but its gold preflight PASSED — an ` +
          "exception may not be filed pre-emptively",
      )
      continue
    }
    if (problems.length === 0) excepted.add(entry.instance_id)
  }
}

/**
 * The gold preflight. Reads the two NESTED verdicts through PMX-03's sentinel
 * gate — never `passed` — and, for PMX-170, reconciles a shortfall against the
 * versioned exception manifest without ever shrinking `assigned`.
 */
export const evaluateProMaxGoldGate = (input: ProMaxGoldGateInput): ProMaxGateResult => {
  const gate: ProMaxGateId =
    input.sampleName === PROMAX_GATE_SAMPLE.gate5_pmx170_gold
      ? "gate5_pmx170_gold"
      : "gate1_pmx7_gold"
  const failures: ProMaxGateFailure[] = []
  const add: Sink = (code, message) => failures.push({ gate, code, message })
  const { evidence, record } = input
  const expected = bindRecord(record, input.sampleName, evidence, add)
  if (expected === null || record === undefined) {
    return { gate, ok: false, failures, summary: null }
  }

  auditSampleAndAttempts(expected, evidence.receipt, input.sampleName, add)
  auditImageProvenance(
    evidence.imageFreeze,
    evidence.receipt.assignedInstanceIds,
    record,
    evidence.receipt,
    add,
  )

  const sentinel = evaluateGoldSentinelGate(evidence.receipt)
  const failingIds = new Set(sentinel.failures.map((f) => f.instanceId))
  const excepted = new Set<string>()

  if (input.exceptions !== undefined) {
    reconcileExceptions(
      { manifest: input.exceptions, record, receipt: evidence.receipt, failingIds },
      excepted,
      add,
    )
  }

  for (const failure of sentinel.failures) {
    if (excepted.has(failure.instanceId)) continue
    add(GOLD_FAILURE_CODE[failure.code], failure.message)
  }
  const uncovered = [...failingIds].filter((id) => !excepted.has(id))
  if (uncovered.length > 0 && gate === "gate5_pmx170_gold") {
    add(
      "exception_manifest_required",
      `${uncovered.length} instance(s) failed the gold preflight with no versioned upstream-exception ` +
        `manifest entry (${uncovered.slice(0, 3).join(", ")}) — Full-170 model inference is forbidden ` +
        "until every shortfall is either fixed or explicitly, reviewably excepted",
    )
  }

  const assignedCount = evidence.receipt.assignedInstanceIds.length
  return {
    gate,
    ok: failures.length === 0,
    failures,
    summary: summarizeOfficialGrade(evidence.receipt),
    coverage: {
      assigned: assignedCount,
      valid: assignedCount - failingIds.size,
      exceptions: excepted.size,
    },
  }
}

// ── gates 2 and 3 — the model stages ────────────────────────────────────────

const auditModelStage = (
  sampleName: string,
  record: ProMaxFrozenCampaignRecord,
  expected: readonly string[],
  evidence: ProMaxModelStageEvidence,
  add: Sink,
): OfficialGradeSummary => {
  auditSampleAndAttempts(expected, evidence.receipt, sampleName, add)
  auditImageProvenance(
    evidence.imageFreeze,
    evidence.receipt.assignedInstanceIds,
    record,
    evidence.receipt,
    add,
  )
  auditQuanta(evidence.quanta, record, add)

  const summary = summarizeOfficialGrade(evidence.receipt)
  if (summary.infraInvalid > 0 || summary.ambiguous > 0 || summary.missing > 0) {
    add(
      "grading_invalid_present",
      `integration validity requires every assigned row to be grading-valid; this run carries ` +
        `${summary.infraInvalid} infra-invalid, ${summary.ambiguous} ambiguous and ${summary.missing} missing row(s)`,
    )
  }

  auditModelRunIdentity("the run", evidence, record, add)
  auditBudgets("the run", evidence.budgets, record, "provenance_incomplete", add)
  return summary
}

/** A row whose evaluator output the pinned schema does not define. */
const unknownOutcomeIds = (receipt: OfficialGradeReceipt): readonly string[] => {
  const out: string[] = []
  for (const [id, d] of receipt.dispositionsByInstanceId) {
    const sides = [d.evaluator.model, d.evaluator.golden]
    const drifted = sides.some((s) => s !== null && !isOfficialFinalResult(s.finalResult))
    if (drifted || d.reason === "schema_invalid") out.push(id)
  }
  return out
}

export interface ProMaxModelGateInput {
  readonly record: ProMaxFrozenCampaignRecord | undefined
  readonly sampleName: string
  readonly evidence: ProMaxModelStageEvidence
}

/**
 * Gate 2. *"Score is diagnostic at this gate; integration validity is the
 * decision"* — so no clause here reads the resolved rate.
 */
export const evaluateProMaxModelSmokeGate = (input: ProMaxModelGateInput): ProMaxGateResult => {
  const gate: ProMaxGateId = "gate2_pmx7_model"
  const failures: ProMaxGateFailure[] = []
  const add: Sink = (code, message) => failures.push({ gate, code, message })
  const expected = bindRecord(input.record, input.sampleName, input.evidence, add)
  if (expected === null || input.record === undefined) {
    return { gate, ok: false, failures, summary: null }
  }
  const summary = auditModelStage(input.sampleName, input.record, expected, input.evidence, add)
  return { gate, ok: failures.length === 0, failures, summary }
}

/** Gate 3 — the PMX-14 canary: gate 2's clauses plus "no unknown outcome reason". */
export const evaluateProMaxCanaryGate = (input: {
  readonly record: ProMaxFrozenCampaignRecord | undefined
  readonly evidence: ProMaxModelStageEvidence
}): ProMaxGateResult => {
  const gate: ProMaxGateId = "gate3_pmx14_canary"
  const sampleName = PROMAX_GATE_SAMPLE[gate]
  const failures: ProMaxGateFailure[] = []
  const add: Sink = (code, message) => failures.push({ gate, code, message })
  const expected = bindRecord(input.record, sampleName, input.evidence, add)
  if (expected === null || input.record === undefined) {
    return { gate, ok: false, failures, summary: null }
  }
  const summary = auditModelStage(sampleName, input.record, expected, input.evidence, add)
  const unknown = unknownOutcomeIds(input.evidence.receipt)
  if (unknown.length > 0) {
    add(
      "outcome_reason_unknown",
      `${unknown.length} row(s) carry an outcome the pinned evaluator schema does not define ` +
        `(${unknown.slice(0, 3).join(", ")}) — a larger run must not be launched on a schema we cannot read`,
    )
  }
  return { gate, ok: failures.length === 0, failures, summary }
}

// ── gate 4 — the paired experiment ──────────────────────────────────────────

const digestByInstance = (freeze: ProMaxImageFreezeReceipt): ReadonlyMap<string, string> =>
  new Map(freeze.images.map((image) => [image.instance_id, image.registry_repo_digest]))

const finiteMetric = (value: number): boolean => Number.isFinite(value) && value >= 0

/**
 * Every clause ONE arm must satisfy on its own: it ran the frozen manifest, it
 * carries a complete paired row per instance with real metrics, its results are
 * NEWER than the record that judges them, and its preset/model/effort are the
 * ones the record froze for its role.
 */
const auditPairedArm = (
  role: string,
  arm: ProMaxArmEvidence,
  record: ProMaxFrozenCampaignRecord,
  expected: readonly string[],
  sampleName: string,
  add: Sink,
): void => {
  if (!orderedEqual(arm.evidence.receipt.assignedInstanceIds, expected)) {
    add(
      "paired_manifest_mismatch",
      `the ${role} arm "${arm.armName}" did not run the frozen ${sampleName} manifest in order`,
    )
  }
  const rowIds = arm.rows.map((r) => r.instanceId)
  if (!orderedEqual(rowIds, expected)) {
    add(
      "paired_row_missing",
      `the ${role} arm "${arm.armName}" carries ${rowIds.length} paired row(s) for ` +
        `${expected.length} assigned instance(s) — a dropped pair is not a comparison`,
    )
  }
  // The freeze-readiness assertion gate 4 never ran: a mutable tag, a fault, or
  // a freeze that does not cover the assigned set voids the arm on its own,
  // BEFORE the two arms are compared with each other.
  auditImageProvenance(
    arm.evidence.imageFreeze,
    arm.evidence.receipt.assignedInstanceIds,
    record,
    arm.evidence.receipt,
    add,
  )
  reconcileArmRowsWithReceipt(role, arm, add)
  const metricless = arm.rows.find(
    (row) => !(finiteMetric(row.costUsd) && finiteMetric(row.turns) && finiteMetric(row.wallMs)),
  )
  if (metricless !== undefined) {
    add(
      "paired_metric_missing",
      `the ${role} arm's row for "${metricless.instanceId}" has no usable cost/turns/wall time ` +
        `(${String(metricless.costUsd)} / ${String(metricless.turns)} / ${String(metricless.wallMs)})`,
    )
  }
  if (arm.evidence.observedAt <= record.frozen_at) {
    add(
      "continuation_rule_not_predeclared",
      `the ${role} arm's results were observed at ${arm.evidence.observedAt}, which is NOT after the ` +
        `record froze at ${record.frozen_at} — a continuation rule cannot be predeclared for results ` +
        "that already existed",
    )
  }
  const frozenArm = record.arms.find((a) => a.role === role)
  if (arm.preset !== arm.evidence.preset) {
    add(
      "paired_config_mismatch",
      `the ${role} arm declares preset "${arm.preset}" but its run reports "${arm.evidence.preset}"`,
    )
  } else if (frozenArm !== undefined && frozenArm.preset !== arm.preset) {
    add(
      "paired_config_mismatch",
      `the ${role} arm ran preset "${arm.preset}" but the record froze "${frozenArm.preset}" for that role`,
    )
  }
  auditBudgets(
    `the ${role} arm "${arm.armName}"`,
    arm.evidence.budgets,
    record,
    "paired_config_mismatch",
    add,
  )
  const armModel = arm.evidence.model
  if (
    armModel.provider !== record.model.provider ||
    armModel.model !== record.model.model ||
    armModel.reasoningEffortDelivered !== record.model.reasoning_effort.delivered
  ) {
    add(
      "paired_config_mismatch",
      `the ${role} arm ran ${armModel.provider}/${armModel.model} at effort ` +
        `${String(armModel.reasoningEffortDelivered)}, which is not the frozen model/effort`,
    )
  }
}

export const evaluateProMaxPairedGate = (input: {
  readonly record: ProMaxFrozenCampaignRecord | undefined
  readonly control: ProMaxArmEvidence
  readonly candidate: ProMaxArmEvidence
}): ProMaxGateResult => {
  const gate: ProMaxGateId = "gate4_pmx40_paired"
  const sampleName = PROMAX_GATE_SAMPLE[gate]
  const failures: ProMaxGateFailure[] = []
  const add: Sink = (code, message) => failures.push({ gate, code, message })
  const { record, control, candidate } = input
  const expected = bindRecord(record, sampleName, control.evidence, add)
  if (expected === null || record === undefined) {
    return { gate, ok: false, failures, summary: null }
  }
  if (candidate.evidence.frozenRecordSha256 !== record.sha256) {
    add(
      "record_digest_mismatch",
      `the candidate arm cites frozen record ${candidate.evidence.frozenRecordSha256}, not ${record.sha256}`,
    )
  }

  const arms: readonly (readonly [string, ProMaxArmEvidence])[] = [
    ["control", control],
    ["candidate", candidate],
  ]

  for (const [role, arm] of arms) auditPairedArm(role, arm, record, expected, sampleName, add)

  auditPairedImageParity(
    {
      expected,
      control: digestByInstance(control.evidence.imageFreeze),
      candidate: digestByInstance(candidate.evidence.imageFreeze),
    },
    add,
  )

  // THE CONTINUATION NUMBER COMES OFF THE RECEIPTS. `auditPairedArm` has already
  // refused any arm whose rows disagree with its own receipt, so the rows remain
  // the cross-check they were meant to be — and the only thing still read from
  // them is the per-instance COST, which no official-grade receipt carries.
  const costOf = (arm: ProMaxArmEvidence): number =>
    arm.rows.reduce((total, r) => total + r.costUsd, 0)
  const rule = record.continuation_rule
  const pairedInstances = receiptPairedInstances(control, candidate, expected)
  const resolvedDelta =
    receiptResolvedCount(candidate, expected) - receiptResolvedCount(control, expected)
  const costUsdDelta = costOf(candidate) - costOf(control)
  const proceed =
    pairedInstances >= rule.minPairedInstances &&
    resolvedDelta >= rule.minResolvedDelta &&
    costUsdDelta <= rule.maxCostUsdDelta
  if (!proceed) {
    add(
      "continuation_rule_stop",
      `the PREDECLARED continuation rule ("${rule.text}") is not satisfied: ${pairedInstances} paired ` +
        `instance(s) (needs ${rule.minPairedInstances}), resolved delta ${resolvedDelta} (needs ` +
        `${rule.minResolvedDelta}), cost delta ${costUsdDelta} (ceiling ${rule.maxCostUsdDelta}). ` +
        "STOP — Full-170 must not be run to search for a favorable aggregate.",
    )
  }

  return {
    gate,
    ok: failures.length === 0,
    failures,
    summary: summarizeOfficialGrade(candidate.evidence.receipt),
    continuation: { pairedInstances, resolvedDelta, costUsdDelta, continue: proceed },
  }
}

// ── gate 6 — the Full-170 model run ─────────────────────────────────────────

/**
 * Gate 6, clause 1: every earlier gate must have RUN and PASSED, and the PMX-40
 * gate must additionally have said CONTINUE. An absent gate is not a passed one.
 */
const auditPriorGates = (
  priorGates: readonly ProMaxGateResult[],
  gate: ProMaxGateId,
  add: Sink,
): void => {
  const byId = new Map(priorGates.map((g) => [g.gate, g]))
  for (const required of PROMAX_GATE_ORDER.filter((g) => g !== gate)) {
    const prior = byId.get(required)
    if (prior === undefined) {
      add("prior_gate_not_passed", `${required} was never run — an unrun gate is not a passed gate`)
      continue
    }
    if (!prior.ok) {
      add(
        "prior_gate_not_passed",
        `${required} did not pass (${prior.failures.map((f) => f.code).join(", ")})`,
      )
      continue
    }
    if (required === "gate4_pmx40_paired" && prior.continuation?.continue !== true) {
      add("prior_gate_not_passed", "the PMX-40 continuation rule did not say continue")
    }
  }
}

/**
 * Gate 6, clauses 3 and 4: the chunks must PARTITION the assigned set, a lost
 * chunk must have been retried to the frozen policy's limit, and its rows must
 * remain `missing` — never scored as model misses.
 */
const auditChunkPartition = (
  chunks: readonly ProMaxChunkEvidence[],
  expected: readonly string[],
  receipt: OfficialGradeReceipt,
  record: ProMaxFrozenCampaignRecord,
  add: Sink,
): void => {
  const seen = new Map<string, string>()
  for (const chunk of chunks) {
    for (const id of chunk.assignedInstanceIds) {
      const owner = seen.get(id)
      if (owner !== undefined) {
        add(
          "chunk_overlap",
          `instance "${id}" is claimed by chunks "${owner}" and "${chunk.chunkId}" — it would be counted twice`,
        )
        continue
      }
      seen.set(id, chunk.chunkId)
    }
  }
  const assigned = new Set(expected)
  const uncovered = expected.filter((id) => !seen.has(id))
  const foreign = [...seen.keys()].filter((id) => !assigned.has(id))
  if (uncovered.length > 0 || foreign.length > 0) {
    add(
      "chunk_coverage_incomplete",
      `the chunks cover ${seen.size} of ${expected.length} assigned instance(s); ` +
        `${uncovered.length} uncovered (${uncovered.slice(0, 3).join(", ")}), ` +
        `${foreign.length} not assigned (${foreign.slice(0, 3).join(", ")})`,
    )
  }

  for (const chunk of chunks) {
    if (chunk.delivered) continue
    if (chunk.attempts < record.retry_policy.maxChunkAttempts) {
      add(
        "retry_not_exhausted",
        `chunk "${chunk.chunkId}" was abandoned after ${chunk.attempts} attempt(s); the frozen retry ` +
          `policy allows ${record.retry_policy.maxChunkAttempts}`,
      )
    }
    const scored = chunk.assignedInstanceIds.filter((id) =>
      receipt.dispositionsByInstanceId.has(id),
    )
    if (scored.length > 0) {
      add(
        "exhausted_row_not_missing",
        `chunk "${chunk.chunkId}" never came back, yet ${scored.length} of its instance(s) carry a ` +
          `graded disposition (${scored.slice(0, 3).join(", ")}) — an exhausted row remains ` +
          `"${record.retry_policy.exhaustedDisposition}", never a model miss`,
      )
    }
  }
}

export const admitProMaxFullRun = (input: {
  readonly record: ProMaxFrozenCampaignRecord | undefined
  readonly priorGates: readonly ProMaxGateResult[]
  readonly evidence: ProMaxModelStageEvidence
  readonly chunks: readonly ProMaxChunkEvidence[]
}): ProMaxGateResult => {
  const gate: ProMaxGateId = "gate6_pmx170_model"
  const sampleName = PROMAX_GATE_SAMPLE[gate]
  const failures: ProMaxGateFailure[] = []
  const add: Sink = (code, message) => failures.push({ gate, code, message })
  const { record, evidence } = input
  const expected = bindRecord(record, sampleName, evidence, add)
  if (expected === null || record === undefined) {
    return { gate, ok: false, failures, summary: null }
  }

  auditPriorGates(input.priorGates, gate, add)

  // 2 — a clean, exact SHA, the frozen budgets, the RUN IDENTITY this gate used
  //     to require and never read, and the image/upstream pins.
  auditQuanta(evidence.quanta, record, add)
  auditBudgets("the Full-170 run", evidence.budgets, record, "provenance_incomplete", add)
  auditModelRunIdentity("the Full-170 run", evidence, record, add)
  if (!orderedEqual(evidence.receipt.assignedInstanceIds, expected)) {
    add(
      "sample_mismatch",
      `the full run assigns ${evidence.receipt.assignedInstanceIds.length} id(s); the frozen ` +
        `${sampleName} manifest has ${expected.length}, in its own order`,
    )
  }
  auditImageProvenance(
    evidence.imageFreeze,
    evidence.receipt.assignedInstanceIds,
    record,
    evidence.receipt,
    add,
  )

  auditChunkPartition(input.chunks, expected, evidence.receipt, record, add)
  // 5 — the DENOMINATOR. A run whose evaluator reported on one of 170 assigned
  //     instances publishes a 100% valid rate; the loss must be attributable to
  //     a lost chunk, and it is reported either way so it is never invisible.
  const covered = auditFullRunCoverage(
    { expected, receipt: evidence.receipt, chunks: input.chunks },
    add,
  )

  return {
    gate,
    ok: failures.length === 0,
    failures,
    summary: summarizeOfficialGrade(evidence.receipt),
    coverage: {
      assigned: covered.assigned,
      valid: covered.gradingValid,
      exceptions: covered.exhausted,
    },
  }
}
