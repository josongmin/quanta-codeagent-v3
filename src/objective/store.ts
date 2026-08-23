/**
 * ADR-0394 — In-memory `ObjectivePort` implementation.
 *
 * Zero-dep reference store. The single mutator of the `Objective` model.
 * Determinism:
 *   - frozen snapshots returned to callers (no post-return mutation leaks).
 *   - injected `now` clock seam (default `Date.now`) for stable timestamps.
 *
 * NO-THROW contract: every method wraps its body in a try/catch and degrades
 * to `null` (mutators / get) or an empty result (`list`) on ANY internal
 * error or malformed input. No method ever throws.
 *
 * Status is NEVER stored as the source of truth on its own. We persist the
 * caller's last EXPLICIT `updateStatus` value separately and DERIVE the
 * public `status` on every read/write from the derivation rule (see
 * `./types` doc + ADR-0394). This keeps the blocked/completed invariants
 * impossible to violate via field drift.
 *
 * exactOptional: budget `max*` keys are OMITTED when absent.
 */

import { type Cell, isNonEmptyString, toObjective } from "./core-store/cell"
import { completionOps } from "./core-store/completion-ops"
import { criteriaOps } from "./core-store/criteria-ops"
import type { ObjectiveStoreCtx } from "./core-store/ctx"
import { objectiveOps } from "./core-store/objective-ops"
import { snapshotOps } from "./core-store/snapshot-ops"
import type {
  CriterionKind,
  ManualCompletionReceipt,
  VerifierCompletionReceipt,
} from "./criteria/model"
import type { ObjectiveThreadSnapshot } from "./model"
import type { Objective, ObjectivePort } from "./types"

/**
 * RFC-03 C1 — the store's per-thread snapshot/restore surface, consumed by the
 * mutation authority (`./authority`) for EXACT undo. Extends `ObjectivePort`
 * with two per-thread methods the whole-store `to/fromSnapshot` codec cannot
 * express (they operate on ALL threads). `snapshotThread` captures the full
 * serializable state of one thread; `restoreThread` writes it back verbatim.
 */
export interface ObjectiveCore extends ObjectivePort {
  /** Full serializable state of one thread's objective, or `null` if unset. */
  snapshotThread(threadId: string): ObjectiveThreadSnapshot | null
  /** Restore one thread's objective from a snapshot; `true` iff it applied. When
   *  `state` was captured as absent the thread is DELETED (exact undo of a set). */
  restoreThread(threadId: string, state: ObjectiveThreadSnapshot | null): boolean
  /** RFC-03 C4 — read a criterion's kind + check identity for the authority's
   *  policy decisions (verifier-only enforcement). `null` ⇒ no such criterion. */
  getCriterion(
    threadId: string,
    criterionId: string,
  ): { readonly kind: CriterionKind; readonly met: boolean; readonly checkId: string | null } | null
  /** RFC-03 C4 — complete/uncomplete a MANUAL criterion with an authority-minted
   *  receipt (`null` ⇒ set met with no receipt / clear on unmark). Refuses (⇒
   *  `null`) a CHECKED criterion (verifier-only) or a missing one. */
  applyManualCompletion(
    threadId: string,
    criterionId: string,
    met: boolean,
    receipt: ManualCompletionReceipt | null,
  ): Objective | null
  /** RFC-03 C4 — the VERIFIER-ONLY checked completion. Sets met:true + the
   *  verifier receipt ONLY when the criterion is CHECKED and the receipt's
   *  `checkId` matches the declared `check.id`; refuses (⇒ `null`) otherwise. */
  applyVerifierCompletion(
    threadId: string,
    criterionId: string,
    receipt: VerifierCompletionReceipt,
  ): Objective | null
}

/** RFC-03 C1 — the raw in-memory objective CORE. Renamed from the historical
 *  `createObjectiveStore`; the public `createObjectiveStore` now lives in
 *  `./authority` and wraps this core so every mutation is revisioned + CAS-gated
 *  (there is no un-revisioned store constructor in production). */
export const createObjectiveCoreStore = (opts?: {
  now?: () => number
  /** H17 — when true the public `status` derives `"budget_limited"` once a
   *  configured cap is reached (see `deriveStatus`/`budgetExhausted`). Default
   *  false ⇒ budget is purely informational and the status is byte-identical
   *  to ADR-0394 (this flag is the SSOT for whether the store enforces; the
   *  host wires it from `QUANTA_OBJECTIVE_BUDGET_ENFORCE`). */
  enforceBudget?: boolean
}): ObjectiveCore => {
  const now = opts?.now ?? Date.now
  const enforce = opts?.enforceBudget === true
  const cells = new Map<string, Cell>()

  const clockNow = (): number => {
    try {
      const t = now()
      return Number.isFinite(t) ? t : Date.now()
    } catch {
      return Date.now()
    }
  }

  /** Resolve a cell by threadId, run `fn`, stamp updatedAt, return projection.
   *  Unknown thread ⇒ null. Any throw ⇒ null. */
  const mutate = (threadId: string, fn: (cell: Cell) => void): Objective | null => {
    try {
      if (!isNonEmptyString(threadId)) return null
      const cell = cells.get(threadId)
      if (cell === undefined) return null
      fn(cell)
      const t = clockNow()
      cell.updatedAt = t
      return toObjective(cell, enforce, t)
    } catch {
      return null
    }
  }

  const ctx: ObjectiveStoreCtx = { cells, enforce, clockNow, mutate }

  return {
    ...objectiveOps(ctx),
    ...criteriaOps(ctx),
    ...completionOps(ctx),
    ...snapshotOps(ctx),
  }
}
