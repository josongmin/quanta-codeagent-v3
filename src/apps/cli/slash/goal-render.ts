import type {
  GoalWakeStatus,
  ObjectiveDomainSnapshot,
  ObjectiveFreshness,
  SuccessCriterion,
} from "@/objective"

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

const checkedProofIsCurrent = (
  criteria: readonly SuccessCriterion[],
  freshness: ObjectiveFreshness,
): boolean =>
  !criteria.some((criterion) => criterion.kind === "checked") ||
  freshness.kind === "fresh" ||
  freshness.kind === "invalidated"

const currentVerificationView = (
  criteria: readonly SuccessCriterion[],
  freshness: ObjectiveFreshness,
): {
  readonly met: number
  readonly remaining: readonly string[]
  readonly verifiedAt: number | undefined
  readonly sourceDigest: string | undefined
  readonly currentProof: boolean
} => {
  const currentProof = checkedProofIsCurrent(criteria, freshness)
  const current = (criterion: SuccessCriterion): boolean =>
    criterion.kind === "manual" || currentProof
  return {
    met: criteria.filter((criterion) => criterion.met && current(criterion)).length,
    remaining: criteria
      .filter((criterion) => !criterion.met || !current(criterion))
      .map((criterion) => criterion.id),
    verifiedAt: (currentProof ? criteria : [])
      .map((criterion) => criterion.completion?.verifiedAt)
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => b - a)[0],
    sourceDigest: (currentProof ? criteria : [])
      .map((criterion) =>
        criterion.completion?.source === "verifier" ? criterion.completion.sourceDigest : undefined,
      )
      .find((value): value is string => value !== undefined),
    currentProof,
  }
}

const renderFreshness = (freshness: ObjectiveFreshness): string => {
  const reason =
    freshness.kind === "source-unavailable" || freshness.kind === "cap-exceeded"
      ? ` (${freshness.reason})`
      : ""
  return `${freshness.kind}${reason}`
}

const renderObjectiveStatus = (status: string, currentProof: boolean): string =>
  status === "completed" && !currentProof ? "completion unconfirmed" : status

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
  freshness: ObjectiveFreshness = { kind: "freshness-unresolved" },
): string => {
  const objective = domain.state?.objective
  if (objective === undefined) return "No goal set. Usage: /goal <objective>\n"
  const criteria = objective.successCriteria
  const verification = currentVerificationView(criteria, freshness)
  const contract = validationContract(criteria)
  const validation =
    contract === "missing"
      ? "validation contract missing — add a check or criterion"
      : `${verification.met}/${criteria.length} verified (contract: ${contract})`
  const budget = objective.budget
  const receipts = domain.progressReceipts ?? []
  const last = receipts.at(-1)
  const checkpoint =
    last === undefined ? "none" : `rev ${last.objectiveRevisionAfter} · ${receipts.length} receipts`
  const source = verification.sourceDigest ?? "unverified"
  const renderedStatus = renderObjectiveStatus(objective.status, verification.currentProof)
  return (
    `🎯 Goal: ${objective.goal}\n` +
    `status: ${renderedStatus} · rev ${domain.revision} · id ${short(objective.objectiveId)}\n` +
    `freshness: ${renderFreshness(freshness)}\n` +
    `validation: ${validation}\n` +
    `remaining: ${verification.remaining.length === 0 ? "none" : verification.remaining.join(", ")}   next: ${objective.nextActions[0] ?? "none"}   blocked: ${objective.blockers[0]?.waitingOn ?? "none"}${objective.blockerObservations[0] === undefined ? "" : ` (observing ${objective.blockerObservations[0].distinctAttemptIds.length}/3)`}\n` +
    blockerLines(objective) +
    `budget: ${budget.turnsUsed}/${budget.maxTurns ?? "∞"} turns · ${budget.tokensUsed}/${budget.maxTokens ?? "∞"} tokens` +
    // GOAL P1-D — WHICH bound applies. The store derives this precisely so a
    // surface can say whether raising the budget could help; until now nothing
    // read it, so the operator saw counters and had to guess.
    (budget.limitedBy === undefined ? "" : ` · limited by: ${budget.limitedBy}`) +
    (last === undefined
      ? "   last attempt: none\n"
      : `   last attempt: ${last.turnOutcome} · ${age(last.recordedAt, now)} (attempt ${short(last.attemptKey)})\n`) +
    `last verified: ${verification.verifiedAt === undefined ? "never" : age(verification.verifiedAt, now)}   checkpoint: ${checkpoint}   source: ${source}\n` +
    `${renderWakeStatus(wake)}\n`
  )
}
