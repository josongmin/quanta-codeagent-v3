/**
 * ADR-0394 objective store — completion receipts and usage accounting.
 *
 * A completion is recorded as a RECEIPT (who completed it, how, when), never as
 * a bare boolean, so `deriveStatus` can distinguish a manually-asserted
 * completion from a verifier-proven one.
 *
 * GOAL-01: usage is applied ONLY by the authority's `settleAttempt` handler
 * (`applyUsage`) — there is no self-reported `recordUsage` on the port.
 */

import type { ObjectiveCore } from "../store"
import type { Objective } from "../types"
import { type CritCell, finiteNonNegInt } from "./cell"
import type { ObjectiveStoreCtx } from "./ctx"

export const completionOps = (
  ctx: ObjectiveStoreCtx,
): Pick<
  ObjectiveCore,
  | "applyManualCompletion"
  | "applyVerifierCompletion"
  | "resetCheckedCriterion"
  | "applyUsage"
  | "startAttempt"
  | "clearStartedAttempt"
> => {
  const { cells, mutate } = ctx
  return {
    applyManualCompletion(threadId, criterionId, met, receipt): Objective | null {
      // Set met on a MANUAL criterion with an authority-minted receipt. Refuses a
      // CHECKED criterion (verifier-only) or a missing one ⇒ null (no bump).
      const c = cells.get(threadId)?.criteria.find((x) => x.id === criterionId)
      if (c === undefined || c.kind === "checked") return null
      return mutate(threadId, (cell) => {
        cell.criteria = cell.criteria.map((x) => {
          if (x.id !== criterionId || x.kind === "checked") return x
          const next: CritCell = { ...x, met: met === true }
          if (met === true && receipt !== null) next.completion = receipt
          else delete next.completion
          return next
        })
      })
    },

    applyVerifierCompletion(threadId, criterionId, receipt): Objective | null {
      // The VERIFIER-ONLY path. Completes a CHECKED criterion ⇔ its declared
      // `check.id` matches the receipt's `checkId`, the receipt binds the live
      // generation, and the result passed. Refuses (⇒ null) otherwise.
      const cell = cells.get(threadId)
      const c = cell?.criteria.find((x) => x.id === criterionId)
      if (cell === undefined || c === undefined || c.kind !== "checked" || c.check === undefined) {
        return null
      }
      if (receipt.checkId !== c.check.id) return null
      if (receipt.objectiveId !== cell.objectiveId) return null
      if (receipt.verifierResult.passed !== true) return null
      return mutate(threadId, (live) => {
        live.criteria = live.criteria.map((x) =>
          x.id === criterionId ? { ...x, met: true, completion: receipt } : x,
        )
      })
    },

    resetCheckedCriterion(threadId, criterionId): Objective | null {
      const c = cells.get(threadId)?.criteria.find((x) => x.id === criterionId)
      if (c === undefined || c.kind !== "checked") return null
      return mutate(threadId, (cell) => {
        cell.criteria = cell.criteria.map((x) => {
          if (x.id !== criterionId) return x
          const next: CritCell = { ...x, met: false }
          delete next.completion
          return next
        })
      })
    },

    startAttempt(threadId, started): Objective | null {
      return mutate(threadId, (cell) => {
        cell.startedAttempt = { ...started }
        cell.turnsUsed += 1
        if (started.provenance === "autonomous-continuation") cell.autonomousTurnsStarted += 1
      })
    },

    clearStartedAttempt(threadId): Objective | null {
      return mutate(threadId, (cell) => {
        delete cell.startedAttempt
      })
    },

    applyUsage(threadId, used): Objective | null {
      return mutate(threadId, (cell) => {
        const dTokens = finiteNonNegInt(used?.tokens)
        const dTurns = finiteNonNegInt(used?.turns)
        if (dTokens !== undefined) cell.tokensUsed += dTokens
        if (dTurns !== undefined) cell.turnsUsed += dTurns
      })
    },
  }
}
