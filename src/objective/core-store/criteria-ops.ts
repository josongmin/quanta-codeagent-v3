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
import { type CritCell, isNonEmptyString, MAX_BLOCKERS_PER_OBJECTIVE } from "./cell"
import type { ObjectiveStoreCtx } from "./ctx"

export const criteriaOps = (
  ctx: ObjectiveStoreCtx,
): Pick<
  ObjectiveCore,
  "addBlocker" | "clearBlocker" | "setNextActions" | "markCriterion" | "getCriterion"
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

    clearBlocker(threadId, blockerId): Objective | null {
      return mutate(threadId, (cell) => {
        cell.blockers = cell.blockers.filter((b) => b.id !== blockerId)
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
