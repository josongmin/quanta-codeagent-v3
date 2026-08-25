/**
 * GOAL-01 test helpers — the domain v2 replacements for the retired
 * `set` / `updateStatus("completed")` / `recordUsage` surface.
 *
 * NOT a test file (no `.test.ts` suffix); imported by objective-related tests.
 */

import {
  asObjectiveAuthority,
  type CommitResult,
  type GoalDefinition,
  type ObjectiveAttemptSettlement,
  type ObjectivePort,
  type ProgressTurnOutcome,
} from "@/objective"

let attemptSeq = 0

/** Mint a unique host attempt id (settlements dedupe on it). */
export const nextAttemptId = (): string => `test-attempt-${++attemptSeq}`

/**
 * HOST-measured usage settlement — the ONLY way usage reaches an objective now.
 * `turns` is clamped to one per settlement (the domain debits one turn per
 * attributed attempt); call it repeatedly to model several turns.
 */
export const settleUsage = (
  port: ObjectivePort,
  threadId: string,
  used: { readonly tokens?: number; readonly turns?: number },
  over: Partial<ObjectiveAttemptSettlement> = {},
): CommitResult => {
  const auth = asObjectiveAuthority(port)
  const dom = auth.readDomain(threadId)
  const settlement: ObjectiveAttemptSettlement = {
    objectiveId: dom.state?.objective.objectiveId ?? "",
    attemptId: nextAttemptId(),
    startedRevision: dom.revision,
    tokensUsed: used.tokens ?? 0,
    turnsUsed: (used.turns ?? 0) > 0 ? 1 : 0,
    outcome: "completed" satisfies ProgressTurnOutcome,
    executionMode: "foreground",
    criterionIdsBefore: [],
    verifierReceiptIdsBefore: [],
    recordedAt: 0,
    ...over,
  }
  return auth.commit(
    auth.prepare({ threadId, actor: "system", mutation: { kind: "settleAttempt", settlement } }),
    { admitted: true },
  )
}

/** Record `turns` attributed turns (one settlement each) plus optional tokens on the first. */
export const settleTurns = (
  port: ObjectivePort,
  threadId: string,
  turns: number,
  tokens = 0,
): void => {
  for (let i = 0; i < turns; i += 1) {
    settleUsage(port, threadId, { tokens: i === 0 ? tokens : 0, turns: 1 })
  }
}

/** `create` when the thread has no objective, `replace` otherwise (the legacy
 *  `set` overwrite semantics, made explicit). Returns the objective or throws. */
export const seedObjective = (
  port: ObjectivePort,
  threadId: string,
  definition: GoalDefinition,
): NonNullable<ReturnType<ObjectivePort["get"]>> => {
  const result =
    port.get(threadId) === null
      ? port.create(threadId, definition)
      : port.replace(threadId, definition)
  if (result === null)
    throw new Error(`seedObjective(${threadId}) refused: ${JSON.stringify(definition)}`)
  return result
}

/** The live objective generation id for a thread (empty when none). */
export const objectiveIdOf = (port: ObjectivePort, threadId: string): string =>
  port.get(threadId)?.objectiveId ?? ""

/** Mark every criterion met through the system surface — the v2 way to reach a
 *  derived `completed` (there is no explicit completed intent any more). */
export const completeAllCriteria = (port: ObjectivePort, threadId: string): void => {
  for (const c of port.get(threadId)?.successCriteria ?? []) {
    if (c.kind === "manual") port.markCriterion(threadId, c.id, true)
  }
}
