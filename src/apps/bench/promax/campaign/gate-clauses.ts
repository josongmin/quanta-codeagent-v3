/**
 * PMX-06 — THE GATE CLAUSES THAT ACTUALLY READ THE EVIDENCE.
 *
 * These live beside `gates.ts` rather than inside it for one reason: an
 * adversarial audit found the packet's most expensive gate (gate 6, the
 * Full-170 model run) REQUIRING a `ProMaxModelStageEvidence` and reading none of
 * it, while gates 2 and 3 read the same fields in a private helper the full-run
 * gate could not reach. A required-but-unread parameter is a FALSE ASSURANCE:
 * the caller believes the gate checked.
 *
 * So every clause a model-spending gate owes its evidence is exported HERE, and
 * gates 2, 3 and 6 call the same function. There is no second spelling of "the
 * run used the frozen preset/model/effort with the leakage guards on" for a gate
 * to drift away from.
 *
 * Three properties this module is built around:
 *
 * COVERAGE IS NOT A RATE. `officialValidRate` is `resolved / grading_valid`, so
 * an evaluator that reported on ONE of 170 assigned instances publishes a 100%
 * valid rate. {@link auditFullRunCoverage} therefore checks the DENOMINATOR
 * against the frozen manifest: every row the evaluator never reported on must be
 * attributable to a chunk that never came back. The retry policy's exhausted
 * rows stay `missing` — but a missing row with no lost chunk behind it is a
 * silently shrunken denominator, and it is refused.
 *
 * THE EFFORT DECISION IS RECOMPUTED, NEVER READ. `parseProMaxCampaignRecord`
 * proves a record was not EDITED; it does not prove the record's own
 * `reasoning_effort` block is internally honest, because a hand-authored record
 * can carry any decision and re-digest itself. So the decision is recomputed
 * from `requested` + `surface` through `@/llm`'s owning resolver, and a campaign
 * whose requested effort can never reach the provider is refused before a token
 * is spent.
 *
 * A CROSS-CHECK IS NOT A SOURCE. The paired arms hand the gate a row set AND an
 * official-grade receipt. {@link reconcileArmRowsWithReceipt} makes the receipt
 * authoritative and the rows a cross-check that must agree, because the
 * continuation decision that authorizes the Full-170 spend must not be
 * computable from a number the caller chose.
 *
 * PURE: no I/O, no clock, no env.
 */

import {
  decideReasoningEffort,
  deliveredReasoningEffort,
  describeReasoningEffortDecision,
  isReasoningEffortHonest,
} from "@/llm"
import type { OfficialGradeReceipt, OfficialGradeState } from "@/runner/batch/eval/official-grade"
import {
  deriveMissingInstanceIds,
  GRADING_VALID_BY_STATE,
} from "@/runner/batch/eval/official-grade"
import type {
  ProMaxArmEvidence,
  ProMaxChunkEvidence,
  ProMaxGateFailureCode,
  ProMaxModelStageEvidence,
} from "./gates"
import type { ProMaxFrozenCampaignRecord } from "./record"

/** How a clause reports a refusal. The gate owns which gate id it is tagged to. */
export type ProMaxGateSink = (code: ProMaxGateFailureCode, message: string) => void

/**
 * The agent/grader LEAKAGE CHECKS a model-spending gate requires. Each names the
 * production guard that implements it, so "leakage check enabled" cites shipped
 * code instead of being an unfalsifiable flag.
 */
export const PROMAX_LEAKAGE_CHECKS = {
  dataset_shape_gold_absent: {
    symbol: "assertProMaxDatasetShape",
    why: "every agent-visible corpus row is proven free of gold / test patch / eval script before a box is provisioned",
  },
  grader_bundle_outside_agent_root: {
    symbol: "assertGraderBundleOutsideAgentRoot",
    why: "the grader bundle is proven to live outside the agent's workspace root",
  },
  agent_phase_bootstrap_gold_absent: {
    symbol: "selectBootstrapCommandsForPhase",
    why: "no gold-bearing bootstrap command may be issued during the agent phase",
  },
} as const

export type ProMaxLeakageCheckId = keyof typeof PROMAX_LEAKAGE_CHECKS

export const PROMAX_LEAKAGE_CHECK_IDS = Object.keys(
  PROMAX_LEAKAGE_CHECKS,
) as readonly ProMaxLeakageCheckId[]

/** THE state of one assigned instance, receipt-side. An id the evaluator never
 *  reported on is `"missing"` — never inferred, never a model miss. */
export const receiptStateOf = (
  receipt: OfficialGradeReceipt,
  instanceId: string,
): OfficialGradeState | "missing" =>
  receipt.dispositionsByInstanceId.get(instanceId)?.state ?? "missing"

/** Grading validity through PMX-03's own table, so a new state cannot be
 *  silently treated as comparable here. */
export const isGradingValidState = (state: OfficialGradeState | "missing"): boolean =>
  state !== "missing" && GRADING_VALID_BY_STATE[state]

/**
 * Every clause a run that SPENT MODEL TOKENS owes the frozen record: the leakage
 * guards were on, it ran the frozen model at the frozen effort, and it used a
 * preset the campaign actually froze for an arm.
 *
 * Shared by gates 2, 3 and 6 — the full-run gate used to require this evidence
 * and read none of it.
 */
export const auditModelRunIdentity = (
  what: string,
  evidence: ProMaxModelStageEvidence,
  record: ProMaxFrozenCampaignRecord,
  add: ProMaxGateSink,
): void => {
  const enabled = new Set<string>(evidence.leakageChecks)
  for (const id of PROMAX_LEAKAGE_CHECK_IDS) {
    if (enabled.has(id)) continue
    add(
      "leakage_check_disabled",
      `leakage check "${id}" (${PROMAX_LEAKAGE_CHECKS[id].symbol}) was not enabled for ${what} — ` +
        PROMAX_LEAKAGE_CHECKS[id].why,
    )
  }

  if (
    evidence.model.provider !== record.model.provider ||
    evidence.model.model !== record.model.model
  ) {
    add(
      "provenance_incomplete",
      `${what} reports ${evidence.model.provider}/${evidence.model.model} but the campaign froze ` +
        `${record.model.provider}/${record.model.model}`,
    )
  }

  // The record's effort block is RECOMPUTED from its own requested value and
  // surface. A digest proves the file was not edited; it does not prove the
  // block was ever honest, and a hand-authored record can re-digest itself.
  const frozen = record.model.reasoning_effort
  const decision = decideReasoningEffort(frozen.requested ?? undefined, frozen.surface)
  if (!isReasoningEffortHonest(decision)) {
    add(
      "provenance_incomplete",
      `the campaign froze reasoning effort "${String(frozen.requested)}" on the ${frozen.surface} ` +
        `surface: ${describeReasoningEffortDecision(decision)} — ${what} cannot honestly report an ` +
        "effort the provider never receives",
    )
  }
  const onTheWire = deliveredReasoningEffort(decision) ?? null
  if (onTheWire !== frozen.delivered) {
    add(
      "provenance_incomplete",
      `the record claims it DELIVERED reasoning effort ${String(frozen.delivered)}, but ` +
        `"${String(frozen.requested)}" on ${frozen.surface} puts ${String(onTheWire)} on the wire`,
    )
  }
  if (evidence.model.reasoningEffortDelivered !== frozen.delivered) {
    add(
      "provenance_incomplete",
      `${what} delivered reasoning effort ${String(evidence.model.reasoningEffortDelivered)} but the ` +
        `campaign froze ${String(frozen.delivered)}`,
    )
  }

  const frozenPresets = record.arms.map((a) => a.preset)
  if (!frozenPresets.includes(evidence.preset)) {
    add(
      "provenance_incomplete",
      `${what} used preset "${evidence.preset}", which is neither frozen arm ` +
        `(${frozenPresets.join(", ")})`,
    )
  }
}

/** What the Full-170 actually covered. `assigned` NEVER shrinks. */
export interface ProMaxFullRunCoverage {
  readonly assigned: number
  /** assigned ids the evaluator reported a grading-valid state for. */
  readonly gradingValid: number
  /** missing ids that a lost chunk accounts for — documented, not deleted. */
  readonly exhausted: number
}

/**
 * Gate 6's DENOMINATOR clause.
 *
 * `officialValidRate` is `resolved / grading_valid`, so a run whose evaluator
 * reported on one of 170 assigned instances publishes a 100% valid rate off a
 * denominator of one. The only rows allowed to be absent are the ones a chunk
 * that never came back accounts for; every other missing row is a denominator
 * that shrank without anyone owning the loss, and it is refused.
 */
export const auditFullRunCoverage = (
  args: {
    readonly expected: readonly string[]
    readonly receipt: OfficialGradeReceipt
    readonly chunks: readonly ProMaxChunkEvidence[]
    /** The campaign's OWN declared tolerance — never a default invented here. */
    readonly maxUngradedAssigned: number
  },
  add: ProMaxGateSink,
): ProMaxFullRunCoverage => {
  const exhausted = new Set<string>()
  for (const chunk of args.chunks) {
    if (chunk.delivered) continue
    for (const id of chunk.assignedInstanceIds) exhausted.add(id)
  }
  const missing = deriveMissingInstanceIds(args.receipt)
  const unaccounted = missing.filter((id) => !exhausted.has(id))
  if (unaccounted.length > 0) {
    add(
      "attempt_incomplete",
      `${unaccounted.length} of ${args.expected.length} assigned instance(s) were never reported on ` +
        `by the evaluator and NO lost chunk accounts for them ` +
        `(${unaccounted.slice(0, 3).join(", ")}) — the valid rate would then be published off a ` +
        "denominator that shrank silently; assigned never shrinks",
    )
  }
  // aug-22 audit (F1): ATTRIBUTION IS NOT A CEILING. Refusing only the
  // unaccounted rows left an attributed loss unbounded, so a Full-170 whose
  // evaluator reported on 1 of 170 instances PASSED — every missing row sat in a
  // chunk that had exhausted `maxChunkAttempts`, which made the loss explainable
  // but not acceptable. The gate that authorises the packet's most expensive run
  // has to say something about it.
  //
  // The bound is the campaign's OWN declared `maxUngradedAssigned`, never a
  // threshold invented here: a default would be a hidden decision about when a
  // run may publish off a shrunken denominator, and the record refuses to parse
  // without the field.
  if (missing.length > args.maxUngradedAssigned) {
    add(
      "attempt_incomplete",
      `${missing.length} of ${args.expected.length} assigned instance(s) finished without a grade, ` +
        `but the frozen retry policy declares maxUngradedAssigned=${args.maxUngradedAssigned} — ` +
        `${unaccounted.length === 0 ? "the loss is fully attributed to exhausted chunks, which explains it without making it acceptable" : "and part of it is not even attributed"}`,
    )
  }
  let gradingValid = 0
  for (const id of args.receipt.assignedInstanceIds) {
    if (isGradingValidState(receiptStateOf(args.receipt, id))) gradingValid += 1
  }
  return {
    assigned: args.receipt.assignedInstanceIds.length,
    gradingValid,
    exhausted: missing.length - unaccounted.length,
  }
}

/**
 * Gate 4's row/receipt reconciliation.
 *
 * The continuation decision that authorizes the Full-170 spend is read from the
 * RECEIPT. The caller-supplied rows carry the per-instance cost/turn/wall
 * metrics the receipt does not, so they cannot simply be dropped — but they must
 * AGREE with the receipt about every outcome, or they are not a cross-check.
 */
export const reconcileArmRowsWithReceipt = (
  role: string,
  arm: ProMaxArmEvidence,
  add: ProMaxGateSink,
): void => {
  const receipt = arm.evidence.receipt
  const disagreeing = arm.rows.filter(
    (row) => receiptStateOf(receipt, row.instanceId) !== row.state,
  )
  if (disagreeing.length === 0) return
  const detail = disagreeing
    .slice(0, 3)
    .map(
      (row) =>
        `${row.instanceId} (rows say "${row.state}", the receipt says ` +
        `"${receiptStateOf(receipt, row.instanceId)}")`,
    )
    .join("; ")
  add(
    "paired_rows_receipt_mismatch",
    `the ${role} arm "${arm.armName}" carries ${disagreeing.length} paired row(s) that disagree ` +
      `with its own official-grade receipt (${detail}) — the continuation rule is evaluated from ` +
      "the RECEIPT, and rows that contradict it are not a cross-check",
  )
}

/** Resolved instances, counted from the arm's RECEIPT over the frozen manifest. */
export const receiptResolvedCount = (arm: ProMaxArmEvidence, expected: readonly string[]): number =>
  expected.filter((id) => receiptStateOf(arm.evidence.receipt, id) === "resolved").length

/**
 * The instances BOTH arms graded validly, from their receipts. This is the
 * `pairedInstances` the predeclared continuation rule is measured against.
 */
export const receiptPairedInstances = (
  control: ProMaxArmEvidence,
  candidate: ProMaxArmEvidence,
  expected: readonly string[],
): number =>
  expected.filter(
    (id) =>
      isGradingValidState(receiptStateOf(control.evidence.receipt, id)) &&
      isGradingValidState(receiptStateOf(candidate.evidence.receipt, id)),
  ).length

/**
 * Gate 4's "same images" clause, with ABSENCE as a failure.
 *
 * `controlDigests.get(id) !== candidateDigests.get(id)` passes when BOTH freezes
 * omit the instance: `undefined === undefined`. Two arms that both failed to
 * pin an image are not "the same experiment" — they are two unpinned ones.
 */
export const auditPairedImageParity = (
  args: {
    readonly expected: readonly string[]
    readonly control: ReadonlyMap<string, string>
    readonly candidate: ReadonlyMap<string, string>
  },
  add: ProMaxGateSink,
): void => {
  const absent: string[] = []
  const differing: string[] = []
  for (const id of args.expected) {
    const control = args.control.get(id)
    const candidate = args.candidate.get(id)
    if (control === undefined || candidate === undefined) {
      absent.push(id)
      continue
    }
    if (control !== candidate) differing.push(id)
  }
  if (absent.length > 0) {
    add(
      "paired_image_mismatch",
      `${absent.length} instance(s) have NO frozen image digest in one or both arms ` +
        `(${absent.slice(0, 3).join(", ")}) — two arms that both failed to pin an image are not ` +
        "the same experiment, they are two unpinned ones",
    )
  }
  if (differing.length > 0) {
    add(
      "paired_image_mismatch",
      `${differing.length} instance(s) were graded against DIFFERENT image digests in the two arms ` +
        `(${differing.slice(0, 3).join(", ")}) — the arms are then not the same experiment`,
    )
  }
}
