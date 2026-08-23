/**
 * ADR-0394 objective store — the snapshot codec.
 *
 * Whole-store `to/fromSnapshot` plus the RFC-03 C1 per-thread pair the mutation
 * authority uses for EXACT undo. `snapshotThread` captures one thread's full
 * serializable state; `restoreThread` writes it back verbatim.
 */

import { errMessage, logger } from "@/shared"
import type { ObjectiveThreadSnapshot } from "../model"
import type { ObjectiveCore } from "../store"
import type { ObjectiveSnapshot } from "../types"
import { isNonEmptyString, toObjective, toSnapshotObjective } from "./cell"
import type { ObjectiveStoreCtx } from "./ctx"
import { cellFromObjective, cellFromThreadSnapshot } from "./rehydrate"

export const snapshotOps = (
  ctx: ObjectiveStoreCtx,
): Pick<ObjectiveCore, "toSnapshot" | "fromSnapshot" | "snapshotThread" | "restoreThread"> => {
  const { cells, enforce, clockNow } = ctx
  return {
    toSnapshot(): ObjectiveSnapshot {
      try {
        const t = clockNow()
        return Object.freeze({
          objectives: Object.freeze(
            [...cells.values()].map((c) => toSnapshotObjective(c, enforce, t)),
          ),
        })
      } catch {
        return Object.freeze({ objectives: Object.freeze([]) })
      }
    },

    fromSnapshot(snap): void {
      try {
        cells.clear()
        const objectives = (snap as ObjectiveSnapshot | undefined)?.objectives
        if (!Array.isArray(objectives)) return
        for (const o of objectives) {
          const cell = cellFromObjective(o)
          if (cell !== null) cells.set(cell.threadId, cell)
        }
      } catch {
        // leave whatever survived; never throw
      }
    },

    // RFC-03 C1 — per-thread exact snapshot/restore for the authority's undo.
    snapshotThread(threadId): ObjectiveThreadSnapshot | null {
      try {
        if (!isNonEmptyString(threadId)) return null
        const cell = cells.get(threadId)
        if (cell === undefined) return null
        return Object.freeze({
          objective: toObjective(cell, enforce, clockNow()),
          explicitStatus: cell.explicitStatus,
          ...(cell.usageLimitedUntil !== undefined
            ? { usageLimitedUntil: cell.usageLimitedUntil }
            : {}),
        })
      } catch (e) {
        // RFC-03 C1 — NO-THROW contract preserved (still `null`), but the fault is
        // now attributed: a snapshot that silently returns null is indistinguishable
        // from "no objective on this thread", which would make the authority's undo
        // look like a no-op instead of a failure.
        logger.warn(`objective.snapshotThread: ${errMessage(e)}`)
        return null
      }
    },

    restoreThread(threadId, state): boolean {
      try {
        if (!isNonEmptyString(threadId)) return false
        // A null prior state means the objective did not exist at snapshot time:
        // exact undo of a `set` is DELETION of the thread's objective.
        if (state === null) return cells.delete(threadId)
        const cell = cellFromThreadSnapshot(threadId, state)
        if (cell === null) return false
        cells.set(threadId, cell)
        return true
      } catch (e) {
        // Same contract, same `false` — but an undo that fails to restore is a
        // DATA-LOSS class event for the caller's rollback, so it must not be silent.
        logger.warn(`objective.restoreThread: ${errMessage(e)}`)
        return false
      }
    },
  }
}
