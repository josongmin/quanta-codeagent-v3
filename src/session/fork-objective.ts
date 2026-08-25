import {
  OBJECTIVE_SNAPSHOT_VERSION,
  OBJECTIVE_SNAPSHOT_VERSION_V1,
  type PersistedObjectiveCriterion,
  type PersistedObjectiveSnapshot,
  type PersistedObjectiveThread,
  type PersistedObjectiveThreadV2,
} from "./types"

const resetCriteria = (
  criteria: readonly PersistedObjectiveCriterion[],
  objectiveId: string,
): readonly PersistedObjectiveCriterion[] =>
  criteria.map((criterion, index) => ({
    id: `criterion:${objectiveId}:${index + 1}`,
    text: criterion.text,
    met: false,
    ...(criterion.kind !== undefined ? { kind: criterion.kind } : {}),
    ...(criterion.check !== undefined
      ? { check: { ...criterion.check, id: `check:${objectiveId}:${index + 1}` } }
      : {}),
  }))

const selectedThread = <T extends { readonly threadId: string }>(
  threads: readonly T[],
  sourceId: string,
): T | undefined =>
  threads.find((thread) => thread.threadId === sourceId) ??
  (threads.length === 1 ? threads[0] : undefined)

/** A fork keeps only the user-owned declaration and starts a paused,
 * evidence-free generation. Both persisted wire versions remain loadable. */
export const cloneObjectiveForFork = (
  snapshot: PersistedObjectiveSnapshot | undefined,
  sourceId: string,
  newId: string,
  now: number,
): PersistedObjectiveSnapshot | undefined => {
  if (snapshot === undefined) return undefined
  const objectiveId = `objective:${newId}:${crypto.randomUUID()}`
  if (snapshot.version === OBJECTIVE_SNAPSHOT_VERSION_V1) {
    const selected = selectedThread<PersistedObjectiveThread>(snapshot.threads, sourceId)
    if (selected === undefined) return undefined
    return {
      version: OBJECTIVE_SNAPSHOT_VERSION_V1,
      threads: [
        {
          threadId: newId,
          revision: 1,
          goal: selected.goal,
          successCriteria: resetCriteria(selected.successCriteria, objectiveId),
          status: "paused",
          explicitStatus: "paused",
          budget: {
            ...(selected.budget.maxTokens !== undefined
              ? { maxTokens: selected.budget.maxTokens }
              : {}),
            tokensUsed: 0,
            ...(selected.budget.maxTurns !== undefined
              ? { maxTurns: selected.budget.maxTurns }
              : {}),
            turnsUsed: 0,
          },
          blockers: [],
          nextActions: [...selected.nextActions],
          createdAt: now,
          updatedAt: now,
        },
      ],
    }
  }

  const selected = selectedThread<PersistedObjectiveThreadV2>(snapshot.threads, sourceId)
  if (selected === undefined) return undefined
  const body = selected.objective
  return {
    version: OBJECTIVE_SNAPSHOT_VERSION,
    threads: [
      {
        threadId: newId,
        revision: 1,
        objective:
          body === null
            ? null
            : {
                objectiveId,
                createdBy: "user",
                goal: body.goal,
                successCriteria: resetCriteria(body.successCriteria, objectiveId),
                status: "paused",
                explicitStatus: "paused",
                budget: {
                  ...(body.budget.maxTokens !== undefined
                    ? { maxTokens: body.budget.maxTokens }
                    : {}),
                  tokensUsed: 0,
                  ...(body.budget.maxTurns !== undefined ? { maxTurns: body.budget.maxTurns } : {}),
                  turnsUsed: 0,
                },
                blockers: [],
                nextActions: [...body.nextActions],
                attempts: { autonomousTurnsStarted: 0 },
                createdAt: now,
                updatedAt: now,
              },
      },
    ],
  }
}
