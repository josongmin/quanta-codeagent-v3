/**
 * ADR-0394 objective store — the closure the operation groups share.
 *
 * The factory owns the thread map, the clock seam and (GOAL-01) the objective
 * generation id minter; each group receives them through this context instead
 * of closing over them, which is what lets the port methods live in cohesive
 * modules instead of one god factory.
 */

import type { ObjectiveIdFactory } from "../identity"
import type { Objective } from "../types"
import type { Cell } from "./cell"

export interface ObjectiveStoreCtx {
  /** Per-thread cells, keyed by threadId. The store's only mutable state. */
  readonly cells: Map<string, Cell>
  /** H17 — when true a reached budget cap derives `"budget_limited"`. */
  readonly enforce: boolean
  /** GOAL-06 — product autonomous attempt cap (≤ the product value; tests may lower it). */
  readonly productAutonomousTurnCap: number
  /** The injected clock, already guarded: never throws, never non-finite. */
  readonly clockNow: () => number
  /** GOAL-01 — objective generation id minter (authority-owned). */
  readonly idFactory: ObjectiveIdFactory
  /** Resolve a cell, mutate it, stamp `updatedAt`, project. Unknown thread or
   *  ANY throw ⇒ null — the shape that gives every mutator its no-throw
   *  contract for free. */
  readonly mutate: (threadId: string, fn: (cell: Cell) => void) => Objective | null
}
