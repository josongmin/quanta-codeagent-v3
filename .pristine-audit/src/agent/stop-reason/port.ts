/**
 * Stop-reason policy port (ADR-0242).
 *
 * Closed single-method port. Pure boundary: given the provider's reported
 * `stop_reason` string (potentially unknown vocabulary), return a closed
 * {@link StopAction}. The implementation MUST be deterministic, MUST NOT
 * perform I/O, MUST NOT mutate caller state, and MUST be total — every
 * input returns an action; never throws. An unknown / unrecognised string
 * MUST collapse to `{ kind: "continue" }` so the legacy mapping in
 * `recovery.decideOnAssembled` retains the final word (fallback).
 *
 * Default implementation (`./default-policy.ts`) is the Cursor 3.2.16
 * 8-arm routing table verbatim. Sibling impl (`./no-op-policy.ts`) is a
 * frozen pass-through used as the explicit byte-identical opt-in (the loop
 * itself short-circuits on `config.stopReasonPolicy === undefined` for
 * zero allocation; no-op is for tests + explicit composition roots).
 *
 * Plane-clean: this file imports ONLY `./types` (sibling).
 */

import type { StopAction } from "./types"

export interface StopReasonPolicy {
  /** Classify one provider `stop_reason` string into a {@link StopAction}.
   *
   *  Invariants (HELL-SR-09..11):
   *   - Pure: no I/O, no global state, no clock/random.
   *   - Deterministic: N invocations on the same string return the
   *     STRUCTURALLY-EQUAL action.
   *   - Total: every string returns an action; never throws. Unknown /
   *     unrecognised inputs MUST return `{ kind: "continue" }` so the
   *     legacy `decideOnAssembled` mapping stays the final authority.
   */
  handle(stopReason: string): StopAction
}
