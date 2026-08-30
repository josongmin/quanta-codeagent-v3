import type { GoalWakeStatus, ObjectiveDomainSnapshot, SuccessCriterion } from "@/objective"

const short = (value: string): string => (value.length <= 8 ? value : value.slice(0, 8))

const age = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.floor((now - at) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`
}

const validationContract = (criteria: readonly SuccessCriterion[]): string => {
  if (criteria.length === 0) return "missing"
  return criteria.some((criterion) => criterion.kind === "checked") ? "checked" : "manual-only"
}

/** GOAL P0-B — the operator has to see WHY the goal stopped before being told
 *  to clear it. Bounded: the store caps blockers at 64, and a wall of them is
 *  not more legible than the first few plus a count. */
const blockerLines = (objective: {
  readonly blockers: readonly { readonly reason: string; readonly waitingOn: string }[]
}): string => {
  if (objective.blockers.length === 0) return ""
  const shown = objective.blockers
    .slice(0, 3)
    .map((blocker) => `  - [${blocker.waitingOn}] ${blocker.reason}`)
    .join("\n")
  const rest = objective.blockers.length - 3
  return `blockers (/goal unblock to clear):\n${shown}${rest > 0 ? `\n  … +${rest} more` : ""}\n`
}

const delayLabel = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`
}

/** GOAL-06 — one typed line for the wake decision; never a predicted status. */
export const renderWakeStatus = (wake: GoalWakeStatus | undefined, now?: number): string => {
  if (wake === undefined)
    return "wake: not composed (autonomous pursuit is not armed in this surface)"
  if (wake.kind === "stopped") return "wake: stopped"
  if (wake.kind === "armed") return `wake: armed in ${delayLabel(wake.delayMs)}`
  if (wake.kind === "pending") {
    return `wake: pending ${delayLabel(wake.delayMs)} quiet after this input settles`
  }
  // W3 — the policy computes a retry instant and a limiting bound for several
  // skips; the status used to drop both, so this line could say "idle
  // (usage-limited)" without saying whether that meant thirty seconds or four
  // hours. Each part is appended only when it exists — a bare idle line is
  // byte-identical.
  const detail = wake.detail === undefined ? "" : `: ${wake.detail}`
  const bound = wake.limitedBy === undefined ? "" : ` · ${wake.limitedBy}`
  const retry =
    wake.retryAt === undefined
      ? ""
      : ` · retry in ${delayLabel(wake.retryAt - (now ?? Date.now()))}`
  return `wake: idle (${wake.skipReason}${detail})${bound}${retry}`
}

export const renderGoalDomain = (
  domain: ObjectiveDomainSnapshot,
  now = Date.now(),
  wake?: GoalWakeStatus | undefined,
): string => {
  const objective = domain.state?.objective
  if (objective === undefined) return "No goal set. Usage: /goal <objective>\n"
  const criteria = objective.successCriteria
  const met = criteria.filter((criterion) => criterion.met).length
  const remaining = criteria.filter((criterion) => !criterion.met).map((criterion) => criterion.id)
  const contract = validationContract(criteria)
  const validation =
    contract === "missing"
      ? "validation contract missing — add a check or criterion"
      : `${met}/${criteria.length} verified (contract: ${contract})`
  const budget = objective.budget
  const receipts = domain.progressReceipts ?? []
  const last = receipts.at(-1)
  const verifiedAt = criteria
    .map((criterion) => criterion.completion?.verifiedAt)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => b - a)[0]
  const sourceDigest = criteria
    .map((criterion) =>
      criterion.completion?.source === "verifier" ? criterion.completion.sourceDigest : undefined,
    )
    .find((value): value is string => value !== undefined)
  const checkpoint =
    last === undefined ? "none" : `rev ${last.objectiveRevisionAfter} · ${receipts.length} receipts`
  const source = sourceDigest ?? "unverified"
  return (
    `🎯 Goal: ${objective.goal}\n` +
    `status: ${objective.status} · rev ${domain.revision} · id ${short(objective.objectiveId)}\n` +
    `validation: ${validation}\n` +
    `remaining: ${remaining.length === 0 ? "none" : remaining.join(", ")}   next: ${objective.nextActions[0] ?? "none"}   blocked: ${objective.blockers[0]?.waitingOn ?? "none"}${objective.blockerObservations[0] === undefined ? "" : ` (observing ${objective.blockerObservations[0].distinctAttemptIds.length}/3)`}\n` +
    blockerLines(objective) +
    `budget: ${budget.turnsUsed}/${budget.maxTurns ?? "∞"} turns · ${budget.tokensUsed}/${budget.maxTokens ?? "∞"} tokens` +
    // GOAL P1-D — WHICH bound applies. The store derives this precisely so a
    // surface can say whether raising the budget could help; until now nothing
    // read it, so the operator saw counters and had to guess.
    (budget.limitedBy === undefined ? "" : ` · limited by: ${budget.limitedBy}`) +
    (last === undefined
      ? "   last attempt: none\n"
      : `   last attempt: ${last.turnOutcome} · ${age(last.recordedAt, now)} (attempt ${short(last.attemptKey)})\n`) +
    `last verified: ${verifiedAt === undefined ? "never" : age(verifiedAt, now)}   checkpoint: ${checkpoint}   source: ${source}\n` +
    `${renderWakeStatus(wake)}\n`
  )
}
