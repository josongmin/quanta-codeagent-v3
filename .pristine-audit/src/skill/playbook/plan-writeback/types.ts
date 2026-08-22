/**
 * Plan-writeback types (ADR-0259).
 *
 * Devin's playbook runner is bidirectional: skill execution can record a
 * finding back against the active plan, surfaced on the next plan re-render.
 * quanta absorbs this as a closed-port slice; this file defines the data
 * shapes ONLY. No runtime, no I/O, no clock.
 *
 * Slice posture: SELF-CONTAINED. Pure data shapes. NO imports from anywhere.
 * Default-OFF: nothing here is invoked unless a host calls one of the surface
 * functions on the `PlanWriteback` port.
 */

/**
 * A finding emitted by a running skill against the active plan.
 *
 * - `kind`     — closed 3-arm union (Devin convergence):
 *   - `"discovery"`   — neutral fact discovered during execution
 *   - `"blocker"`     — a precondition / dependency is unmet
 *   - `"opportunity"` — a follow-on improvement surfaced
 * - `text`     — non-empty human-readable description. Whitespace-only or
 *                empty strings are rejected as `WritebackError("empty-text")`.
 * - `severity` — closed 3-arm union: "info" | "warn" | "critical".
 *                Mirrors standard logging severities; the host renderer chooses
 *                how to surface each level.
 */
export interface Finding {
  readonly kind: "discovery" | "blocker" | "opportunity"
  readonly text: string
  readonly severity: "info" | "warn" | "critical"
}

/**
 * Envelope returned by `recordFinding` and held inside `getUpdates`.
 *
 * - `planId`     — the plan id the writeback instance was constructed for.
 * - `skillId`    — id of the skill that emitted this finding.
 * - `finding`    — the typed {@link Finding} payload.
 * - `recordedAt` — strictly-increasing per-instance ordinal. Implementations
 *                  MUST use a monotonic source (internal counter, NOT
 *                  `Date.now()`) so two record calls in the same wall-clock
 *                  millisecond remain order-stable. The value is opaque to
 *                  consumers — they only rely on the strict-increase invariant.
 *
 * Both the `PlanUpdate` object AND the array returned by `getUpdates` are
 * `Object.freeze`-d so consumers cannot mutate writeback state.
 */
export interface PlanUpdate {
  readonly planId: string
  readonly skillId: string
  readonly finding: Finding
  readonly recordedAt: number
}

/**
 * Closed 3-arm reason a `recordFinding` call refused to enqueue.
 *
 * - `"plan-not-found"` — the supplied call is for a planId other than the one
 *                         this writeback instance was constructed for.
 * - `"empty-text"`      — `finding.text` was empty or whitespace-only.
 * - `"skill-id-empty"`  — the supplied `skillId` was empty or whitespace-only.
 */
export type WritebackError =
  | { readonly kind: "plan-not-found" }
  | { readonly kind: "empty-text" }
  | { readonly kind: "skill-id-empty" }

/**
 * Local Result shape — closed-port + zero deps. Compatible in spirit with
 * `@/shared` Result but intentionally local to keep this slice leaf-only.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }
