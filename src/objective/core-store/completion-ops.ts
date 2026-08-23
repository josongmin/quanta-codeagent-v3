/**
 * ADR-0394 objective store — completion receipts and usage accounting.
 *
 * A completion is recorded as a RECEIPT (who completed it, how, when), never as
 * a bare boolean, so `deriveStatus` can distinguish a manually-asserted
 * completion from a verifier-proven one.
 */

import type { ObjectiveCore } from "../store"
import type { Objective } from "../types"
import { type CritCell, finiteNonNegInt } from "./cell"
import type { ObjectiveStoreCtx } from "./ctx"

export const completionOps = (
  ctx: ObjectiveStoreCtx,
): Pick<ObjectiveCore, "applyManualCompletion" | "applyVerifierCompletion" | "recordUsage"> => {
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
      // `check.id` matches the receipt's `checkId` and the result passed. Refuses
      // (⇒ null) a manual/missing criterion or an id/verdict mismatch.
      const c = cells.get(threadId)?.criteria.find((x) => x.id === criterionId)
      if (c === undefined || c.kind !== "checked" || c.check === undefined) return null
      if (receipt.checkId !== c.check.id) return null
      if (receipt.verifierResult.passed !== true) return null
      return mutate(threadId, (cell) => {
        cell.criteria = cell.criteria.map((x) =>
          x.id === criterionId ? { ...x, met: true, completion: receipt } : x,
        )
      })
    },

    recordUsage(threadId, used): Objective | null {
      return mutate(threadId, (cell) => {
        const dTokens = finiteNonNegInt(used?.tokens)
        const dTurns = finiteNonNegInt(used?.turns)
        if (dTokens !== undefined) cell.tokensUsed += dTokens
        if (dTurns !== undefined) cell.turnsUsed += dTurns
      })
    },
  }
}
