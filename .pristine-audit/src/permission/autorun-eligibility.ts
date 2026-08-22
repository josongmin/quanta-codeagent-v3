/**
 * ADR-0453 — Heartbeat autorun eligibility (Codex heartbeat-automation model).
 *
 * A PURE, TOTAL function that decides whether a background auto-run (the
 * scheduler's RRULE fire, the reactor's self-wake) is permitted to dispatch
 * for a thread, given ONLY structural inputs:
 *
 *   - the thread's {@link ThreadPermission.approvalPolicy} (`never` |
 *     `on-request` | `on-failure` | `always`),
 *   - the prior turn outcome ({@link AutorunPriorOutcome}, mirrors ADR-0131's
 *     4-state outcome), and
 *   - whether a manual approval / request is currently present (the
 *     `on-request` gate's structural signal).
 *
 * NO HEURISTICS: there is no clock, no `Date.now`, no `Math.random`, no invented
 * threshold. The verdict is a deterministic function of the closed enums above.
 * The `mode` is carried purely so the resolver / audit trail can record WHICH
 * agent mode the decision applied to; it does NOT change the verdict (modes are
 * orthogonal to the approval policy — a `never` thread is ineligible in every
 * mode). It is part of the input so the reason string can anchor the mode, and
 * so a future mode-scoped policy can extend this WITHOUT changing the signature.
 *
 * SLICE: `@/permission` — lives next to {@link ThreadPermission} because the
 * eligibility verdict is a pure projection of the per-thread approval policy.
 * Imports NOTHING (no `node:` I/O, no other slice). Both `@/scheduler` and
 * `@/reactor` consume the verdict through an injected resolver port (the
 * composition root reads the thread's policy from the store and calls this).
 *
 * Default-OFF: this module fires nothing. It is a value-returning evaluator.
 * Scheduler / reactor only consult it when the composition root injects a
 * resolver; with no resolver injected their behavior is byte-identical to the
 * pre-ADR-0453 code path.
 */

import type { ThreadPermission } from "./permission-store"

/** The approval policy axis the eligibility verdict is a function of.
 *  Aliased from {@link ThreadPermission} so this module owns no duplicate
 *  string union (single source of truth stays the store). */
export type AutorunApprovalPolicy = ThreadPermission["approvalPolicy"]

/**
 * Prior-turn outcome. Mirrors ADR-0131's 4-state outcome enum AND the
 * reactor's `LastTurnOutcome` so the composition root can pass either through
 * without translation. `partial` / `uncertain` are non-failure; `fail` is the
 * only outcome that satisfies the `on-failure` policy.
 */
export type AutorunPriorOutcome = "success" | "partial" | "uncertain" | "fail"

/** All prior outcomes — closed array for runtime exhaustiveness sanity. */
export const ALL_AUTORUN_PRIOR_OUTCOMES: ReadonlyArray<AutorunPriorOutcome> = [
  "success",
  "partial",
  "uncertain",
  "fail",
]

/**
 * Agent mode the decision applies to. Carried for audit anchoring only —
 * orthogonal to the verdict (see module docstring). Open-ended string so the
 * caller's mode taxonomy (architect / editor / debug / …) need not be mirrored
 * here; the evaluator never branches on it.
 */
export type AutorunMode = string

/**
 * Closed, enum-like reason set. NOT free text — every reason maps 1:1 to a
 * branch of the pure decision so a test (and an operator reading telemetry)
 * can assert WHY a fire was allowed or blocked. Adding a branch is a
 * compile-error in the exhaustiveness guard.
 */
export type AutorunEligibilityReason =
  /** approvalPolicy === "always" ⇒ unconditionally eligible. */
  | "policy-always"
  /** approvalPolicy === "never" ⇒ unconditionally blocked. */
  | "policy-never"
  /** approvalPolicy === "on-failure" AND priorOutcome === "fail" ⇒ eligible. */
  | "on-failure-failed"
  /** approvalPolicy === "on-failure" AND prior outcome is NOT a failure. */
  | "on-failure-not-failed"
  /** approvalPolicy === "on-request" AND a manual approval/request present. */
  | "on-request-present"
  /** approvalPolicy === "on-request" AND no manual approval/request present. */
  | "on-request-absent"

/** All reasons — closed array for runtime exhaustiveness sanity tests. */
export const ALL_AUTORUN_ELIGIBILITY_REASONS: ReadonlyArray<AutorunEligibilityReason> = [
  "policy-always",
  "policy-never",
  "on-failure-failed",
  "on-failure-not-failed",
  "on-request-present",
  "on-request-absent",
]

/**
 * Inputs to {@link evaluateAutorunEligibility}. All structural — no clock, no
 * I/O handle. The caller (a composition-root resolver) reads the thread's
 * policy from the permission store and assembles this record.
 */
export interface AutorunEligibilityInput {
  readonly approvalPolicy: AutorunApprovalPolicy
  /** Prior turn outcome. Absent (`undefined`) is treated as a NON-failure
   *  (`partial`-equivalent) so an unknown / first-turn state never satisfies
   *  the `on-failure` gate — fail toward NOT auto-running. */
  readonly priorOutcome?: AutorunPriorOutcome
  /** Whether a manual approval / request is currently present for this thread.
   *  The `on-request` policy is eligible ONLY when this is `true`. Absent /
   *  `false` ⇒ no standing request ⇒ blocked. */
  readonly manualApprovalPresent?: boolean
  /** Agent mode (audit anchor only — does not change the verdict). */
  readonly mode?: AutorunMode
}

/**
 * The verdict. `eligible` is the gate; `reason` is the closed enum anchor.
 */
export interface AutorunEligibility {
  readonly eligible: boolean
  readonly reason: AutorunEligibilityReason
}

const isFailure = (outcome: AutorunPriorOutcome | undefined): boolean => outcome === "fail"

/**
 * PURE, TOTAL eligibility evaluator. Same input ⇒ same verdict, always.
 *
 * Mapping (structural — no heuristics):
 *   - `always`     ⇒ eligible (`policy-always`).
 *   - `never`      ⇒ NOT eligible (`policy-never`).
 *   - `on-failure` ⇒ eligible IFF `priorOutcome === "fail"`
 *                    (`on-failure-failed` / `on-failure-not-failed`).
 *   - `on-request` ⇒ eligible IFF `manualApprovalPresent === true`
 *                    (`on-request-present` / `on-request-absent`).
 */
export const evaluateAutorunEligibility = (input: AutorunEligibilityInput): AutorunEligibility => {
  switch (input.approvalPolicy) {
    case "always":
      return { eligible: true, reason: "policy-always" }
    case "never":
      return { eligible: false, reason: "policy-never" }
    case "on-failure":
      return isFailure(input.priorOutcome)
        ? { eligible: true, reason: "on-failure-failed" }
        : { eligible: false, reason: "on-failure-not-failed" }
    case "on-request":
      return input.manualApprovalPresent === true
        ? { eligible: true, reason: "on-request-present" }
        : { eligible: false, reason: "on-request-absent" }
    default: {
      // Exhaustiveness guard — a new approvalPolicy arm is a compile error here.
      const _exhaustive: never = input.approvalPolicy
      throw new Error(`unhandled approvalPolicy: ${JSON.stringify(_exhaustive)}`)
    }
  }
}
