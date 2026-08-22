/**
 * Bounded transition rules for the adaptive-escalation controller (jun-22 v5
 * Wave-1 skeleton, group D — pure core).
 *
 * The controller must NEVER run an open-ended autonomous loop. These pure
 * functions classify each {@link AdaptiveAction} and enforce hard budgets:
 * a per-instance total-step cap, an expensive-escalation cap, and a per-action
 * cap. When no legal next step remains the controller emits a TYPED stop reason
 * (never a fake candidate-red). The actual LLM call + phase execution are wired
 * by the Wave-3 controller; this module owns only the deterministic admission
 * logic, so it is fully unit-testable.
 */

import type { AdaptiveAction } from "./decision-schema"

/** Actions that consume executable budget (sandbox repro / repo-test runs). */
const EXPENSIVE: ReadonlySet<AdaptiveAction> = new Set<AdaptiveAction>([
  "run_public_repro",
  "run_proof_clean",
  "repair_with_proof",
])

/** Actions that END the run (finalize the current candidate, or stop). */
const TERMINAL: ReadonlySet<AdaptiveAction> = new Set<AdaptiveAction>([
  "accept_thin",
  "stop_infra_or_budget",
])

/** Actions that rebuild the evidence packet and RE-ROUTE (loop risk → bounded). */
const REROUTE: ReadonlySet<AdaptiveAction> = new Set<AdaptiveAction>([
  "run_public_repro",
  "run_proof_clean",
  "repair_with_proof",
  "deeper_localize",
])

export const isExpensiveAction = (a: AdaptiveAction): boolean => EXPENSIVE.has(a)
export const isTerminalAction = (a: AdaptiveAction): boolean => TERMINAL.has(a)
export const isRerouteAction = (a: AdaptiveAction): boolean => REROUTE.has(a)

/** Every action falls into exactly one control class (exhaustive partition). */
export type ActionClass = "terminal" | "reroute" | "finalize_after"
export const classifyAction = (a: AdaptiveAction): ActionClass =>
  isTerminalAction(a) ? "terminal" : isRerouteAction(a) ? "reroute" : "finalize_after"

export interface AdaptiveLimits {
  /** Hard cap on total routing steps per instance. */
  readonly maxTotalSteps: number
  /** Hard cap on EXPENSIVE escalations per instance. */
  readonly maxExpensive: number
  /** Hard cap on entries of any single action (anti-thrash). */
  readonly maxPerAction: number
}

/** Conservative defaults: short, bounded, no open loop. */
export const DEFAULT_ADAPTIVE_LIMITS: AdaptiveLimits = {
  maxTotalSteps: 4,
  maxExpensive: 2,
  maxPerAction: 2,
}

export type StopReason =
  | "max_steps_exhausted"
  | "max_expensive_exhausted"
  | "max_per_action_exhausted"
  | "terminal_action"
  | "infra_or_budget"

export type Admission =
  | { readonly admit: true }
  | { readonly admit: false; readonly stopReason: StopReason }

/**
 * Decide whether `next` may run given the prior `history` (actions already taken
 * this instance) and `limits`. Pure: terminal actions never count against the
 * budget here (they are handled by {@link terminalStopReason}); this guards the
 * NON-terminal escalations against unbounded looping.
 */
export const admitNextStep = (
  history: readonly AdaptiveAction[],
  next: AdaptiveAction,
  limits: AdaptiveLimits = DEFAULT_ADAPTIVE_LIMITS,
): Admission => {
  if (isTerminalAction(next)) return { admit: true }
  if (history.length >= limits.maxTotalSteps)
    return { admit: false, stopReason: "max_steps_exhausted" }
  if (isExpensiveAction(next)) {
    const spent = history.filter(isExpensiveAction).length
    if (spent >= limits.maxExpensive) return { admit: false, stopReason: "max_expensive_exhausted" }
  }
  const sameCount = history.filter((a) => a === next).length
  if (sameCount >= limits.maxPerAction)
    return { admit: false, stopReason: "max_per_action_exhausted" }
  return { admit: true }
}

/** Typed terminal reason for a terminal action (controller writes it to report). */
export const terminalStopReason = (a: AdaptiveAction): StopReason | undefined =>
  a === "stop_infra_or_budget"
    ? "infra_or_budget"
    : a === "accept_thin"
      ? "terminal_action"
      : undefined
