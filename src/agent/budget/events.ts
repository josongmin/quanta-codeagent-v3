/**
 * Discriminated-union event shapes emitted from `BudgetMeter` for trajectory
 * recording. Pure data — no I/O, no clock. The meter does NOT emit these
 * itself (it has no stream port by design); instead consumers (loop, tests)
 * can construct them from `snapshot()` / `checkExhausted()` at well-known
 * sites.
 */

import type { BudgetCaps, BudgetDials, BudgetUsage, TickKind } from "./types"

/** Recorded each time `tick(kind, n?)` is called. */
export interface BudgetTickEvent {
  type: "budget_tick"
  kind: TickKind
  delta: number
  /** Cumulative count for this kind AFTER the tick. */
  observed: number
}

/** Fired by the loop when `checkExhausted()` returns exhausted=true. */
export interface BudgetExhaustedEvent {
  type: "budget_exhausted"
  /** Which dimension fired. */
  kind: TickKind | "wall_clock_ms" | "cost_usd" | "cost_per_turn" | "total_tokens"
  budget: number
  observed: number
  /** Snapshot of every counter at the moment exhaustion was detected. */
  usage: BudgetUsage
}

/** Fired by `clampDials` when a requested dial exceeds the mode cap. */
export interface BudgetClampEvent {
  type: "budget_clamp"
  /** The dial field name that was clamped (keyof BudgetDials). */
  dial: keyof BudgetDials & string
  requested: number
  cap: number
}

/** All budget events the loop may surface (closed union). */
export type BudgetEvent = BudgetTickEvent | BudgetExhaustedEvent | BudgetClampEvent

/** Type guard helper (callers may want this for filtering). */
export const isBudgetEvent = (e: { type: string }): e is BudgetEvent =>
  e.type === "budget_tick" || e.type === "budget_exhausted" || e.type === "budget_clamp"

/** Construct a `BudgetClampEvent`. Pure factory — no I/O. */
export const makeClampEvent = (
  dial: keyof BudgetDials & string,
  requested: number,
  cap: number,
): BudgetClampEvent => ({
  type: "budget_clamp",
  dial,
  requested,
  cap,
})

/** Sentinel type-narrowing helper: a `BudgetCaps` is structurally a
 *  `BudgetDials` — assertion documents the relationship. */
export const asDials = (caps: BudgetCaps): BudgetDials => caps
