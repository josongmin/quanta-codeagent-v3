/**
 * ADR-0394 objective store — the core lifecycle: create/read an objective,
 * set its explicit status, record a usage limit, list every thread.
 */

import type { ObjectiveCore } from "../store"
import type { Objective } from "../types"
import { cellFromInit, emptyCell, isNonEmptyString, toObjective } from "./cell"
import type { ObjectiveStoreCtx } from "./ctx"

export const objectiveOps = (
  ctx: ObjectiveStoreCtx,
): Pick<ObjectiveCore, "set" | "get" | "updateStatus" | "markUsageLimited" | "list"> => {
  const { cells, enforce, clockNow, mutate } = ctx
  return {
    set(threadId, init): Objective {
      try {
        // Malformed input still returns a non-null Objective (port contract):
        // degrade to a synthetic empty cell rather than throwing.
        if (!isNonEmptyString(threadId) || init === null || typeof init !== "object") {
          const t = clockNow()
          return toObjective(emptyCell(threadId, t), enforce, t)
        }
        const t = clockNow()
        const cell = cellFromInit(threadId, init, t)
        cells.set(threadId, cell)
        return toObjective(cell, enforce, t)
      } catch {
        const t = Date.now()
        return toObjective(emptyCell(threadId, t), enforce, t)
      }
    },

    get(threadId): Objective | null {
      try {
        if (!isNonEmptyString(threadId)) return null
        const cell = cells.get(threadId)
        return cell === undefined ? null : toObjective(cell, enforce, clockNow())
      } catch {
        return null
      }
    },

    updateStatus(threadId, status): Objective | null {
      return mutate(threadId, (cell) => {
        // Only "active" / "paused" / "completed" are explicit intents. The other
        // three values (`blocked` / `usage_limited` / `budget_limited`) are
        // DERIVED (from blockers / usage window / budget) and cannot be set
        // directly — passing one is a silent no-op (the port is NO-THROW).
        if (status === "active" || status === "paused" || status === "completed") {
          cell.explicitStatus = status
        }
      })
    },

    markUsageLimited(threadId, untilEpochMs): Objective | null {
      return mutate(threadId, (cell) => {
        // A finite, future-or-equal epoch sets the window; anything else (NaN /
        // Infinity / negative / non-number) CLEARS it. The derive uses the
        // injected clock so the window auto-resets — no sticky flag here.
        // exactOptionalPropertyTypes: set or DELETE (never assign `undefined`).
        if (typeof untilEpochMs === "number" && Number.isFinite(untilEpochMs) && untilEpochMs > 0) {
          cell.usageLimitedUntil = untilEpochMs
        } else {
          delete cell.usageLimitedUntil
        }
      })
    },

    list(): readonly Objective[] {
      try {
        const t = clockNow()
        return Object.freeze([...cells.values()].map((c) => toObjective(c, enforce, t)))
      } catch {
        return Object.freeze([])
      }
    },
  }
}
