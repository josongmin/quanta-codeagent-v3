/**
 * ADR-0161 Phase C — Automation lifecycle helpers.
 *
 * Pure: no clock / fs / env / network. Helpers that need ms-epoch take it as
 * an argument. The store (next-door) handles persistence; the runtime
 * (sibling) handles firing. This module is the single place transitions are
 * named so the lifecycle stays observable in one file.
 *
 * 4-arm lifecycle (closed):
 *   active   — the only fire-eligible state.
 *   paused   — host-controlled hold; resumes to `active` on operator request.
 *   deleted  — terminal; never returns to active (caller's UX should hide).
 *   error    — runtime set this when `chooseModel` returned `all-unavailable`.
 *              UX recovery is operator-driven (paused → resume after fixing).
 */

import type { Automation, AutomationStatus, RRule } from "./types"

export interface CreateAutomationInput {
  readonly id: string
  readonly title: string
  readonly rule: RRule
  readonly prompt: string
  readonly modelPreference: string
  readonly modelFallbacks: ReadonlyArray<string>
  readonly createdAt: number
}

/**
 * Construct a fresh `active` automation with `fireCount = 0` and the
 * optional `lastFiredAt` / `lastErrorMessage` KEYS OMITTED (exactOptional).
 */
export const createAutomation = (input: CreateAutomationInput): Automation => ({
  id: input.id,
  title: input.title,
  rule: input.rule,
  prompt: input.prompt,
  status: "active",
  modelPreference: input.modelPreference,
  modelFallbacks: input.modelFallbacks,
  createdAt: input.createdAt,
  fireCount: 0,
})

/** Transition to a new status. `deleted` is terminal — returning the prior
 *  automation unchanged is the rejection signal (callers ignore deleted in
 *  any path that wouldn't survive a deleted source). */
export const transitionStatus = (a: Automation, next: AutomationStatus): Automation => {
  if (a.status === "deleted") return a
  if (a.status === next) return a
  return { ...a, status: next }
}

/** Record a successful fire. Returns a new automation with `lastFiredAt`,
 *  `fireCount + 1`, and `lastErrorMessage` cleared (key omitted). */
export const recordFire = (a: Automation, firedAt: number): Automation => {
  // Strip lastErrorMessage by reconstruction (exactOptional — can't set to undefined).
  const base = {
    id: a.id,
    title: a.title,
    rule: a.rule,
    prompt: a.prompt,
    status: a.status,
    modelPreference: a.modelPreference,
    modelFallbacks: a.modelFallbacks,
    createdAt: a.createdAt,
    lastFiredAt: firedAt,
    fireCount: a.fireCount + 1,
  }
  return base
}

/** Mark the automation as `error` with a closed message. Preserves
 *  `lastFiredAt` (the error doesn't erase the last successful fire). */
export const markError = (a: Automation, message: string): Automation => {
  return {
    ...a,
    status: "error",
    lastErrorMessage: message,
  }
}

/** Predicate — fire eligibility. */
export const isFireEligible = (a: Automation): boolean => a.status === "active"
