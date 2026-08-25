import type { ObjectiveCore } from "./store"
import type { GoalDefinition, ObjectivePort } from "./types"

const isObjectiveCore = (port: ObjectivePort): port is ObjectiveCore =>
  typeof (port as Partial<ObjectiveCore>).snapshotThread === "function" &&
  typeof (port as Partial<ObjectiveCore>).restoreThread === "function" &&
  typeof (port as Partial<ObjectiveCore>).observeBlocker === "function" &&
  typeof (port as Partial<ObjectiveCore>).clearBlockerObservations === "function"

/** Adapt a foreign public port to the authority's core protocol. */
export const objectiveCoreFromPort = (port: ObjectivePort): ObjectiveCore => {
  if (isObjectiveCore(port)) return port
  return {
    ...port,
    snapshotThread(threadId) {
      const objective = port.get(threadId)
      if (objective === null) return null
      return Object.freeze({
        objective,
        explicitStatus: objective.status === "paused" ? ("paused" as const) : ("active" as const),
      })
    },
    restoreThread(threadId, state) {
      if (state === null) return port.clear(threadId)
      const objective = state.objective
      const definition: GoalDefinition = {
        goal: objective.goal,
        successCriteria: objective.successCriteria.map((criterion) => criterion.text),
      }
      return (
        (port.get(threadId) === null
          ? port.create(threadId, definition)
          : port.replace(threadId, definition)) !== null
      )
    },
    getCriterion(threadId, criterionId) {
      const criterion = port
        .get(threadId)
        ?.successCriteria.find((candidate) => candidate.id === criterionId)
      if (criterion === undefined) return null
      return {
        kind: criterion.kind,
        met: criterion.met,
        checkId: criterion.kind === "checked" ? criterion.check.id : null,
      }
    },
    applyManualCompletion: (threadId, criterionId, met) =>
      port.markCriterion(threadId, criterionId, met),
    applyVerifierCompletion(threadId, criterionId, receipt) {
      const criterion = port
        .get(threadId)
        ?.successCriteria.find((candidate) => candidate.id === criterionId)
      if (
        criterion === undefined ||
        criterion.kind !== "checked" ||
        receipt.checkId !== criterion.check.id ||
        receipt.verifierResult.passed !== true
      ) {
        return null
      }
      return port.markCriterion(threadId, criterionId, true)
    },
    applyUsage: (threadId) => port.get(threadId),
    resetCheckedCriterion: (threadId) => port.get(threadId),
    startAttempt: (threadId) => port.get(threadId),
    clearStartedAttempt: (threadId) => port.get(threadId),
    observeBlocker: () => null,
    clearBlockerObservations: () => null,
  }
}
