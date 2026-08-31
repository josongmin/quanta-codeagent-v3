/**
 * ADR-0394 objective store — success criteria and blockers.
 *
 * Both collections are CAPPED (`MAX_CRITERIA_PER_OBJECTIVE` /
 * `MAX_BLOCKERS_PER_OBJECTIVE`) so a looping caller cannot grow one thread's
 * cell without bound.
 */

import { randomUUID } from "node:crypto"
import { errMessage, logger } from "@/shared"
import type { ObjectiveCore } from "../store"
import type { Objective, WaitingOn } from "../types"
import {
  type Cell,
  type CritCell,
  isNonEmptyString,
  MAX_BLOCKER_OBSERVATIONS,
  MAX_BLOCKERS_PER_OBJECTIVE,
} from "./cell"
import type { ObjectiveStoreCtx } from "./ctx"

type ObservationInput = Parameters<ObjectiveCore["observeBlocker"]>[1]

const promoteObservedBlocker = (cell: Cell, observation: ObservationInput, now: number): void => {
  if (cell.blockers.length >= MAX_BLOCKERS_PER_OBJECTIVE) return
  // GOAL P0-B — a dependency that keeps blocking is ONE reason the goal stopped,
  // not a new one every three attempts. Without this the operator's clear-list
  // grew with the agent's retries, so the escape hatch got further away the
  // longer the agent tried.
  const alreadyLive = cell.blockers.some(
    (blocker) => blocker.dependencyId === observation.dependencyId,
  )
  if (alreadyLive) return
  cell.blockers.push({
    id: randomUUID(),
    dependencyId: observation.dependencyId,
    reason: observation.reason,
    waitingOn: observation.waitingOn,
    since: now,
  })
}

const recordDistinctObservation = (
  cell: Cell,
  observation: ObservationInput,
  now: number,
): void => {
  const existingIndex = cell.blockerObservations.findIndex(
    (candidate) => candidate.dependencyId === observation.dependencyId,
  )
  const existing = existingIndex < 0 ? undefined : cell.blockerObservations[existingIndex]
  const occurrences = [
    ...(existing?.occurrences ?? []),
    {
      attemptId: observation.attemptId,
      occurrenceEvidenceId: observation.occurrenceEvidenceId,
      observedAt: now,
    },
  ].slice(-3)
  if (existingIndex >= 0) cell.blockerObservations.splice(existingIndex, 1)
  if (occurrences.length >= 3) {
    promoteObservedBlocker(cell, observation, now)
    return
  }
  cell.blockerObservations.push({
    observationId: existing?.observationId ?? randomUUID(),
    dependencyId: observation.dependencyId,
    waitingOn: observation.waitingOn,
    occurrences,
  })
  if (cell.blockerObservations.length > MAX_BLOCKER_OBSERVATIONS) {
    cell.blockerObservations.shift()
  }
}

export const criteriaOps = (
  ctx: ObjectiveStoreCtx,
): Pick<
  ObjectiveCore,
  | "addBlocker"
  | "observeBlocker"
  | "clearBlocker"
  | "clearBlockerObservations"
  | "setNextActions"
  | "markCriterion"
  | "getCriterion"
> => {
  const { cells, clockNow, mutate } = ctx
  return {
    addBlocker(threadId, blocker): Objective | null {
      return mutate(threadId, (cell) => {
        // Audit R2 (F3): bounded blocker count per objective. Silently dropping
        // is correct here — an agent that has hit 64 simultaneous unresolved
        // blockers on one thread is already in a pathological state; adding a
        // 65th would not help diagnosis.
        if (cell.blockers.length >= MAX_BLOCKERS_PER_OBJECTIVE) return
        const waitingOn: WaitingOn =
          blocker?.waitingOn === "user" ||
          blocker?.waitingOn === "tool" ||
          blocker?.waitingOn === "network" ||
          blocker?.waitingOn === "child_agent"
            ? blocker.waitingOn
            : "user"
        cell.blockers.push({
          id: randomUUID(),
          reason: typeof blocker?.reason === "string" ? blocker.reason : "",
          waitingOn,
          since: clockNow(),
        })
      })
    },

    observeBlocker(threadId, observation): Objective | null {
      const cell = cells.get(threadId)
      if (
        cell === undefined ||
        !isNonEmptyString(observation.dependencyId) ||
        !isNonEmptyString(observation.attemptId) ||
        !isNonEmptyString(observation.occurrenceEvidenceId)
      ) {
        return null
      }
      const prior = cell.blockerObservations.find(
        (candidate) => candidate.dependencyId === observation.dependencyId,
      )
      if (
        prior?.occurrences.some(
          (item) =>
            item.attemptId === observation.attemptId ||
            item.occurrenceEvidenceId === observation.occurrenceEvidenceId,
        ) === true
      ) {
        return null
      }
      return mutate(threadId, (current) =>
        recordDistinctObservation(current, observation, clockNow()),
      )
    },

    clearBlocker(threadId, blockerId): Objective | null {
      return mutate(threadId, (cell) => {
        cell.blockers = cell.blockers.filter((b) => b.id !== blockerId)
      })
    },

    clearBlockerObservations(threadId): Objective | null {
      const cell = cells.get(threadId)
      if (cell === undefined || cell.blockerObservations.length === 0) return null
      return mutate(threadId, (current) => {
        current.blockerObservations = []
      })
    },

    setNextActions(threadId, actions): Objective | null {
      return mutate(threadId, (cell) => {
        cell.nextActions = Array.isArray(actions)
          ? actions.filter((a): a is string => typeof a === "string")
          : []
      })
    },

    markCriterion(threadId, criterionId, met): Objective | null {
      // RFC-03 C4 — the RAW (no-provenance) path. Kind-aware: a CHECKED criterion
      // is verifier-only, so a plain markCriterion NEVER changes its met flag
      // (structural, independent of any gate). A MANUAL criterion flips met and
      // (this dumb path carries no receipt) CLEARS any completion evidence.
      return mutate(threadId, (cell) => {
        cell.criteria = cell.criteria.map((c) => {
          if (c.id !== criterionId) return c
          if (c.kind === "checked") return c // verifier-only — no-op
          const next: CritCell = { ...c, met: met === true }
          delete next.completion
          return next
        })
      })
    },

    getCriterion(threadId, criterionId) {
      try {
        if (!isNonEmptyString(threadId)) return null
        const cell = cells.get(threadId)
        if (cell === undefined) return null
        const c = cell.criteria.find((x) => x.id === criterionId)
        if (c === undefined) return null
        return {
          kind: c.kind,
          met: c.met,
          checkId: c.kind === "checked" && c.check !== undefined ? c.check.id : null,
        }
      } catch (e) {
        // NO-THROW contract preserved (still `null`) — but a read fault that
        // reads as "no such criterion" would make a checked criterion look
        // absent instead of unreadable.
        logger.warn(`objective.getCriterion: ${errMessage(e)}`)
        return null
      }
    },
  }
}
