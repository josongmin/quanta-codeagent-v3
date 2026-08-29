/**
 * GOAL-04 — attributed turn SETTLEMENT (the host side of the objective's
 * two-phase attempt accounting).
 *
 *   1. `beginObjectiveAttempt` — before the paid provider call: take the host
 *      claim from the attempt slot, commit `beginAttempt` (reserves the turn and,
 *      for an autonomous attempt, the product hard-cap slot) and persist the
 *      started state durably. The provider is NOT called if that persistence
 *      fails (the slot is fail-stopped).
 *   2. `settleObjectiveAttempt` — after the agent body, in ONE finally-style
 *      terminal path: reconcile verifier freshness, commit `settleAttempt` with
 *      the MEASURED usage and the typed outcome, then let the caller persist the
 *      post-settlement snapshot. A persistence failure after settlement never
 *      refunds the start: the slot is fail-stopped (durable uncertainty) and
 *      further attributed turns are refused.
 *
 * Usage is measured, never self-reported: the `BudgetMeter` delta when the
 * session wired one (production), else the turn stream's usage accumulator
 * (legacy/test adapters). Ordinary chat carries no attempt and touches nothing.
 */

import type { AgentConfig, AgentOutcome, StopReason } from "@/agent"
import type { BudgetUsage } from "@/agent/budget/types"
import type { ObjectiveJudgeObserverPort } from "@/agent/tier1/objective-judge-observer"
import {
  createObjectiveCapabilities,
  type ObjectiveAttemptContext,
  type ObjectiveAttemptSlot,
  type ObjectiveCapabilities,
  type ObjectivePort,
  type ObjectiveVerificationPort,
  type ProgressTurnOutcome,
  verifierReceiptRef,
} from "@/objective"
import { errMessage, logger } from "@/shared"
import type { AgentEvent } from "@/stream"

/** Exhaustive StopReason -> settlement outcome (a new StopReason is a compile error). */
export const SETTLEMENT_OUTCOME: Record<StopReason, ProgressTurnOutcome> = {
  completed: "completed",
  max_turns: "max_turns",
  aborted: "aborted",
  error: "error",
  budget_exhausted: "budget_exhausted",
  refusal: "refusal",
  awaiting_approval: "awaiting_approval",
}

/** Sum of provider-reported input + output tokens seen on the turn stream.
 *  Reasoning tokens are NOT added: both OpenAI and Anthropic report them inside
 *  `outputTokens` (pinned by the provider cassette expectations). */
export interface TurnUsageAccumulator {
  readonly observe: (event: AgentEvent) => void
  readonly total: () => number
}

export const createTurnUsageAccumulator = (): TurnUsageAccumulator => {
  let total = 0
  return {
    observe: (event) => {
      if (event.type !== "usage") return
      const usage = event as unknown as { inputTokens?: number; outputTokens?: number }
      const input = Number.isFinite(usage.inputTokens) ? (usage.inputTokens as number) : 0
      const output = Number.isFinite(usage.outputTokens) ? (usage.outputTokens as number) : 0
      total += Math.max(0, input) + Math.max(0, output)
    },
    total: () => total,
  }
}

const meterTokens = (u: BudgetUsage | undefined): number =>
  u === undefined ? 0 : Math.max(0, u.inputTokens) + Math.max(0, u.outputTokens)

export interface AttributedAttempt {
  readonly attempt: ObjectiveAttemptContext
  readonly capabilities: ObjectiveCapabilities
  readonly slot: ObjectiveAttemptSlot
  readonly criterionIdsBefore: readonly string[]
  readonly verifierReceiptIdsBefore: readonly string[]
  readonly meterBefore: BudgetUsage | undefined
  readonly usage: TurnUsageAccumulator
}

export const isObjectiveAttemptSlot = (v: unknown): v is ObjectiveAttemptSlot =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as ObjectiveAttemptSlot).take === "function" &&
  typeof (v as ObjectiveAttemptSlot).failStop === "function"

/** Durable persistence of the objective snapshot BEFORE the paid call. */
export type PersistObjectiveStart = () => Promise<void>

export interface BeginObjectiveAttemptDeps {
  readonly objective: unknown
  readonly objectiveAttemptSlot: unknown
  readonly budgetMeter: AgentConfig["budgetMeter"] | undefined
  readonly persistStart: PersistObjectiveStart | undefined
  /** GOAL-04 rail 13 — the production usage source is the BudgetMeter delta.
   *  An attributed attempt WITHOUT a meter is a composition error (thrown before
   *  anything is reserved) unless the caller explicitly opts into the stream
   *  usage accumulator (test / legacy adapters only). */
  readonly usageSource?: "budget-meter" | "legacy-stream-events"
  readonly now?: () => number
}

/**
 * Take the host claim (if any) and reserve the attempt durably. Returns
 * `undefined` for an unattributed turn (no claim / no objective). Throws when
 * the reservation cannot be made durable — the caller must NOT run the agent.
 */
export const beginObjectiveAttempt = async (
  deps: BeginObjectiveAttemptDeps,
): Promise<AttributedAttempt | undefined> => {
  if (!isObjectiveAttemptSlot(deps.objectiveAttemptSlot)) return undefined
  const slot = deps.objectiveAttemptSlot
  const attempt = slot.take()
  if (attempt === undefined) return undefined
  if (deps.objective === undefined || deps.objective === null) return undefined
  const capabilities = createObjectiveCapabilities(deps.objective as ObjectivePort)
  const live = capabilities.read.get(attempt.threadId)
  if (live === null || live.objectiveId !== attempt.objectiveId) {
    // The claim is stale (objective replaced/cleared since the surface claimed it):
    // an unattributed turn, never a charge against a different generation.
    return undefined
  }
  if (deps.budgetMeter === undefined && deps.usageSource !== "legacy-stream-events") {
    const reason =
      "objective attempt requires a BudgetMeter (composition error: measured usage source missing)"
    slot.failStop(reason, attempt.objectiveId)
    throw new Error(reason)
  }
  const begun = capabilities.system.commit(attempt.threadId, {
    kind: "beginAttempt",
    attempt: {
      objectiveId: attempt.objectiveId,
      attemptId: attempt.attemptId,
      provenance: attempt.provenance,
      executionMode: attempt.executionMode,
      startedRevision: attempt.startedRevision,
    },
  })
  if (!begun.ok) {
    throw new Error(`objective attempt could not be reserved (${begun.reason})`)
  }
  try {
    await deps.persistStart?.()
  } catch (e) {
    const reason = `objective attempt start not durable: ${errMessage(e)}`
    slot.failStop(reason, attempt.objectiveId)
    throw new Error(reason)
  }
  return {
    attempt,
    capabilities,
    slot,
    criterionIdsBefore: live.successCriteria.filter((c) => c.met).map((c) => c.id),
    verifierReceiptIdsBefore: live.successCriteria.flatMap((c) =>
      c.kind === "checked" && c.completion?.source === "verifier"
        ? [
            verifierReceiptRef({
              criterionId: c.id,
              checkId: c.completion.checkId,
              objectiveRevision: c.completion.objectiveRevision,
            }),
          ]
        : [],
    ),
    meterBefore: deps.budgetMeter?.snapshot(),
    usage: createTurnUsageAccumulator(),
  }
}

/** GOAL-05A rail 16 — what a settled attempt announces. Bounded and text-free
 *  (no goal text, no prompt, no attempt key beyond the id the receipt already
 *  carries): a surface renders it, a counter labels it. */
export interface ObjectiveSettlementNotice {
  readonly threadId: string
  readonly objectiveId: string
  readonly attemptId: string
  readonly provenance: ObjectiveAttemptContext["provenance"]
  readonly turnOutcome: ProgressTurnOutcome
  readonly tokensUsed: number
  /** The revision AFTER the settlement commit. */
  readonly objectiveRevision: number
  readonly receiptCount: number
  readonly remainingCriterionIds: readonly string[]
}

export interface SettleObjectiveAttemptDeps {
  readonly attributed: AttributedAttempt
  readonly outcome: AgentOutcome | { readonly reason: StopReason }
  readonly budgetMeter: AgentConfig["budgetMeter"] | undefined
  readonly verifier: ObjectiveVerificationPort | undefined
  readonly judge: ObjectiveJudgeObserverPort | undefined
  readonly now?: () => number
  /** GOAL-05A rail 16 — announce the SETTLED attempt. Fires only after the
   *  authority accepted the settlement (a refused one fail-stops instead), and
   *  a throwing sink can never destabilize settlement. Absent ⇒ byte-identical. */
  readonly onSettled?: ((notice: ObjectiveSettlementNotice) => void) | undefined
}

/** Settle exactly once. Never throws (a settlement refusal is logged and the
 *  slot is fail-stopped so the uncertainty is not silent). */
export const settleObjectiveAttempt = async (deps: SettleObjectiveAttemptDeps): Promise<void> => {
  const { attributed } = deps
  const { attempt, capabilities } = attributed
  const now = deps.now ?? Date.now
  // Reconcile verifier freshness first so a completion cannot settle on stale
  // receipts. A reconcile failure is typed (freshness-unresolved) and never skips
  // settlement.
  if (deps.verifier !== undefined) {
    try {
      await deps.verifier.reconcile(attempt.threadId)
    } catch (e) {
      logger.warn(`objective.settlement.reconcile: ${errMessage(e)}`)
    }
  }
  const measured =
    deps.budgetMeter !== undefined && attributed.meterBefore !== undefined
      ? Math.max(0, meterTokens(deps.budgetMeter.snapshot()) - meterTokens(attributed.meterBefore))
      : attributed.usage.total()
  const res = capabilities.system.commit(attempt.threadId, {
    kind: "settleAttempt",
    settlement: {
      objectiveId: attempt.objectiveId,
      attemptId: attempt.attemptId,
      startedRevision: attempt.startedRevision,
      tokensUsed: measured,
      turnsUsed: 0, // reserved at beginAttempt
      outcome: SETTLEMENT_OUTCOME[deps.outcome.reason],
      executionMode: attempt.executionMode,
      criterionIdsBefore: attributed.criterionIdsBefore,
      verifierReceiptIdsBefore: attributed.verifierReceiptIdsBefore,
      recordedAt: now(),
    },
  })
  if (!res.ok) {
    const reason = `objective attempt settlement refused (${res.reason})`
    logger.warn(`objective.settlement: ${reason}`)
    attributed.slot.failStop(reason, attributed.attempt.objectiveId)
    return
  }
  emitSettlementNotice(deps, measured)
  if (deps.judge !== undefined) {
    try {
      await deps.judge.evaluate({ read: capabilities.read, threadId: attempt.threadId })
    } catch (e) {
      logger.warn(`objective.settlement.judge: ${errMessage(e)}`)
    }
  }
}

/** Read the POST-commit facts and hand them to the sink. Reads the authority
 *  again on purpose: the notice must describe what was actually recorded, not
 *  the pre-commit snapshot the caller happened to hold. */
const emitSettlementNotice = (deps: SettleObjectiveAttemptDeps, tokensUsed: number): void => {
  const sink = deps.onSettled
  if (sink === undefined) return
  const { attempt, capabilities } = deps.attributed
  try {
    const domain = capabilities.read.readDomain(attempt.threadId)
    const receipts = domain.progressReceipts ?? []
    const last = receipts.at(-1)
    sink({
      threadId: attempt.threadId,
      objectiveId: attempt.objectiveId,
      attemptId: attempt.attemptId,
      provenance: attempt.provenance,
      turnOutcome: last?.turnOutcome ?? SETTLEMENT_OUTCOME[deps.outcome.reason],
      tokensUsed,
      objectiveRevision: domain.revision,
      receiptCount: receipts.length,
      remainingCriterionIds: last?.remainingCriterionIds ?? [],
    })
  } catch (error) {
    logger.warn(`objective.settlement.notice: ${errMessage(error)}`)
  }
}

/** Terminal persistence failed AFTER settlement: the durable state is uncertain. */
export const failStopAfterSettlement = (attributed: AttributedAttempt, error: unknown): void => {
  attributed.slot.failStop(
    `objective settlement not durable: ${errMessage(error)}`,
    attributed.attempt.objectiveId,
  )
}
