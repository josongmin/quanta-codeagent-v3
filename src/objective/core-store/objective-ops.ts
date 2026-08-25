/**
 * ADR-0394 objective store — the core lifecycle: create / replace / clear an
 * objective generation, set its explicit status, amend its budget caps, record
 * a usage limit, list every thread.
 *
 * GOAL-01: `create` refuses a live thread, `replace` refuses an empty one, and
 * both mint a FRESH generation from the provenance the authority binds (the
 * store never chooses an id or an actor on its own).
 */

import { clampBudgetLimit } from "../budget-limits"
import { normalizeGoalText } from "../identity"
import type { ObjectiveCore } from "../store"
import type { Objective } from "../types"
import { type CellProvenance, cellFromDefinition, isNonEmptyString, toObjective } from "./cell"
import type { ObjectiveStoreCtx } from "./ctx"

export const objectiveOps = (
  ctx: ObjectiveStoreCtx,
): Pick<
  ObjectiveCore,
  | "create"
  | "replace"
  | "clear"
  | "get"
  | "setExplicitStatus"
  | "amendBudget"
  | "markUsageLimited"
  | "list"
> => {
  const { cells, enforce, clockNow, idFactory, mutate } = ctx

  const mint = (
    threadId: string,
    definition: Parameters<ObjectiveCore["create"]>[1],
    provenance: CellProvenance | undefined,
  ): Objective | null => {
    try {
      if (!isNonEmptyString(threadId) || definition === null || typeof definition !== "object") {
        return null
      }
      if (normalizeGoalText(definition.goal) === null) return null
      const t = clockNow()
      const cell = cellFromDefinition(
        threadId,
        definition,
        provenance ?? { objectiveId: idFactory(), createdBy: "system" },
        t,
      )
      cells.set(threadId, cell)
      return toObjective(cell, enforce, t)
    } catch {
      return null
    }
  }

  return {
    create(threadId, definition, provenance): Objective | null {
      if (isNonEmptyString(threadId) && cells.has(threadId)) return null
      return mint(threadId, definition, provenance)
    },

    replace(threadId, definition, provenance): Objective | null {
      if (!isNonEmptyString(threadId) || !cells.has(threadId)) return null
      return mint(threadId, definition, provenance)
    },

    clear(threadId): boolean {
      // A Map delete cannot throw for a string key; no catch needed (the
      // silent-failure ratchet counts bare catches).
      return isNonEmptyString(threadId) && cells.delete(threadId)
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

    setExplicitStatus(threadId, status): Objective | null {
      // GOAL-01 — only the two explicit intents exist. Anything else (a forged
      // "completed", a derived limit state) is refused: `null`, no bump.
      if (status !== "active" && status !== "paused") return null
      return mutate(threadId, (cell) => {
        cell.explicitStatus = status
      })
    },

    amendBudget(threadId, budget): Objective | null {
      if (budget === null || typeof budget !== "object") return null
      return mutate(threadId, (cell) => {
        // A present cap replaces; `undefined` leaves the cap untouched; a
        // non-finite/negative cap is ignored. `*Used` are never touched here.
        // GOAL-05A — same-ID amendment: clamp to the product ceiling, never
        // touch `*Used`; the derived status re-evaluates against the new caps.
        const { maxTokens, maxTurns } = clampBudgetLimit(budget)
        if (maxTokens !== undefined) cell.maxTokens = maxTokens
        if (maxTurns !== undefined) cell.maxTurns = maxTurns
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
