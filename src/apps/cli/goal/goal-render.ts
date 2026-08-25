/**
 * GOAL-05A — the goal REPORT: a pure projection of read-port data
 * (`ObjectiveDomainSnapshot`) and its one text renderer.
 *
 * The report carries only what the authority already derived: goal, derived
 * status, revision, a short objective id, the validation contract with
 * evidence counts, remaining criteria, next actions, typed blockers, budget +
 * the autonomous counter, the last attributed outcome + age, and the
 * checkpoint / source-digest status. It NEVER exposes an attempt key, a claim,
 * or a predicted status (rail 10). The same data model is what the host
 * projects after each attributed attempt and what a restart re-renders from
 * the persisted receipts — there is no parallel progress log.
 *
 * Slice fence: `@/objective` types + `criterionSatisfied` only.
 */

import {
  criterionSatisfied,
  type GoalWakeStatus,
  type ObjectiveDomainSnapshot,
  type ObjectiveStatus,
  type ProgressTurnOutcome,
  type ValidationContract,
  type WaitingOn,
} from "@/objective"

export interface GoalReportCriterion {
  readonly id: string
  readonly text: string
  readonly kind: "manual" | "checked"
  readonly checkId?: string
}

export interface GoalReport {
  readonly goal: string
  readonly status: ObjectiveStatus
  readonly revision: number
  readonly objectiveId: string
  readonly shortId: string
  readonly createdAgeMs: number
  readonly validationContract: ValidationContract
  readonly counts: {
    readonly total: number
    readonly manualMet: number
    readonly verified: number
    readonly checkedUnverified: number
    readonly remaining: number
  }
  readonly remaining: readonly GoalReportCriterion[]
  readonly nextActions: readonly string[]
  readonly blockers: readonly { reason: string; waitingOn: WaitingOn; ageMs: number }[]
  readonly budget: {
    readonly tokensUsed: number
    readonly maxTokens?: number
    readonly turnsUsed: number
    readonly maxTurns?: number
    readonly autonomousTurnsStarted: number
  }
  readonly lastAttempt?: { readonly outcome: ProgressTurnOutcome; readonly ageMs: number }
  readonly checkpoint: { readonly receipts: number; readonly sourceDigest: "present" | "absent" }
  /** GOAL-06 — the wake controller's typed scheduling decision (absent ⇒ no controller). */
  readonly wake?: GoalWakeStatus
}

/** Operator-facing short form of the authority-minted id (never the raw id). */
export const shortObjectiveId = (objectiveId: string): string => objectiveId.slice(0, 8)

const age = (now: number, at: number): number => Math.max(0, now - at)

export const buildGoalReport = (
  domain: ObjectiveDomainSnapshot,
  now: number,
  wake?: GoalWakeStatus,
): GoalReport | null => {
  const state = domain.state
  if (state === null) return null
  const o = state.objective
  const criteria = o.successCriteria
  const verified = criteria.filter(
    (c) => c.kind === "checked" && criterionSatisfied(c, o.objectiveId),
  ).length
  const manualMet = criteria.filter(
    (c) => c.kind === "manual" && criterionSatisfied(c, o.objectiveId),
  ).length
  const remaining = criteria.filter((c) => !c.met)
  const receipts = domain.progressReceipts ?? []
  const last = receipts.at(-1)
  return {
    goal: o.goal,
    status: o.status,
    revision: domain.revision,
    objectiveId: o.objectiveId,
    shortId: shortObjectiveId(o.objectiveId),
    createdAgeMs: age(now, o.createdAt),
    validationContract: domain.validationContract ?? "missing",
    counts: {
      total: criteria.length,
      manualMet,
      verified,
      checkedUnverified: criteria.filter((c) => c.kind === "checked" && !c.met).length,
      remaining: remaining.length,
    },
    remaining: remaining.map((c) => ({
      id: c.id,
      text: c.text,
      kind: c.kind,
      ...(c.kind === "checked" ? { checkId: c.check.id } : {}),
    })),
    nextActions: [...o.nextActions],
    blockers: o.blockers.map((b) => ({
      reason: b.reason,
      waitingOn: b.waitingOn,
      ageMs: age(now, b.since),
    })),
    budget: {
      tokensUsed: o.budget.tokensUsed,
      ...(o.budget.maxTokens !== undefined ? { maxTokens: o.budget.maxTokens } : {}),
      turnsUsed: o.budget.turnsUsed,
      ...(o.budget.maxTurns !== undefined ? { maxTurns: o.budget.maxTurns } : {}),
      autonomousTurnsStarted: o.attempts.autonomousTurnsStarted,
    },
    ...(last !== undefined
      ? { lastAttempt: { outcome: last.turnOutcome, ageMs: age(now, last.recordedAt) } }
      : {}),
    checkpoint: {
      receipts: receipts.length,
      sourceDigest: last?.sourceDigest !== undefined ? "present" : "absent",
    },
    ...(wake !== undefined ? { wake } : {}),
  }
}

/** One line for the wake decision (typed; the PTY suite asserts this text). */
export const formatWakeStatus = (wake: GoalWakeStatus | undefined): string => {
  if (wake === undefined)
    return "wake: not composed (QUANTA_GOAL_ENFORCE=1 arms autonomous pursuit)"
  if (wake.kind === "stopped") return "wake: stopped"
  if (wake.kind === "armed") return `wake: armed in ${formatAge(wake.delayMs)} (${wake.reason})`
  const why =
    wake.skipReason === undefined
      ? ""
      : ` (${wake.skipReason}${wake.busyReason === undefined ? "" : `: ${wake.busyReason}`})`
  return `wake: idle${why}`
}

// ── text renderer ────────────────────────────────────────────────────────────

/** 6-state status label (drift-guarded by the `Record<ObjectiveStatus, …>`). */
const STATUS_LABEL: Record<ObjectiveStatus, string> = {
  active: "Pursuing goal",
  completed: "Goal achieved",
  paused: "Paused goal",
  blocked: "Goal stalled",
  budget_limited: "Goal limited",
  usage_limited: "Goal usage limited",
}

const CONTRACT_LINE: Record<ValidationContract, string> = {
  missing:
    "contract: missing — add `/goal criterion add <text>` or `/goal check add <text> -- <argv>` before autonomous pursuit can proceed",
  "manual-only": "contract: manual-only (no runnable check; completion needs your attestation)",
  checked: "contract: checked (verifier-backed)",
}

export const formatAge = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m - h * 60}m`
}

const budgetLine = (b: GoalReport["budget"]): string => {
  const tokens = b.maxTokens !== undefined ? `${b.tokensUsed}/${b.maxTokens}` : `${b.tokensUsed}`
  const turns = b.maxTurns !== undefined ? `${b.turnsUsed}/${b.maxTurns}` : `${b.turnsUsed}`
  return `  budget: ${tokens} tokens · ${turns} turns · autonomous started ${b.autonomousTurnsStarted}\n`
}

const evidenceLine = (r: GoalReport): string =>
  `  criteria: ${r.counts.total} total · ${r.counts.verified} verified · ${r.counts.manualMet} attested · ${r.counts.checkedUnverified} unverified check(s) · ${r.counts.remaining} remaining\n`

const listBlock = (title: string, rows: readonly string[]): string =>
  rows.length === 0 ? "" : `  ${title}:\n${rows.map((row) => `    - ${row}\n`).join("")}`

export const renderGoalReport = (report: GoalReport | null): string => {
  if (report === null) {
    return "No goal set. Usage: /goal <objective>  (define measurable outcomes for best results)\n"
  }
  const r = report
  const remainingRows = r.remaining.map(
    (c) => `${c.id} ${c.kind === "checked" ? `[check ${c.checkId ?? "?"}] ` : ""}${c.text}`,
  )
  const blockerRows = r.blockers.map(
    (b) => `${b.reason} (waiting on ${b.waitingOn}, ${formatAge(b.ageMs)})`,
  )
  const lastLine =
    r.lastAttempt === undefined
      ? "  last attempt: none\n"
      : `  last attempt: ${r.lastAttempt.outcome} · ${formatAge(r.lastAttempt.ageMs)} ago\n`
  return (
    `🎯 ${STATUS_LABEL[r.status]}: ${r.goal}\n` +
    `  status: ${r.status} · rev ${r.revision} · id ${r.shortId} · ${formatAge(r.createdAgeMs)} old\n` +
    `  ${CONTRACT_LINE[r.validationContract]}\n` +
    evidenceLine(r) +
    listBlock("remaining", remainingRows) +
    listBlock("next", r.nextActions) +
    listBlock("blocked", blockerRows) +
    budgetLine(r.budget) +
    lastLine +
    `  checkpoint: ${r.checkpoint.receipts} receipt(s) · source digest ${r.checkpoint.sourceDigest}\n` +
    `  ${formatWakeStatus(r.wake)}\n`
  )
}
