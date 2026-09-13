/**
 * Dispatch-guard port (ADR-0229).
 *
 * Closed single-method port. Pure boundary: given a tool name + raw input,
 * return a {@link GuardDecision}. The implementation MAY inspect the input
 * for path / shell-command / URL fields, MUST NOT perform I/O, MUST NOT
 * mutate the input, and MUST be deterministic.
 *
 * Default implementation (`./default-guard.ts`) composes three pure
 * detectors that already ship in the repo:
 *   - `@/permission`           `gitWriteProtectReason`
 *   - `@/permission`           `decideBranchOnly`
 *   - `@/runtime`              `isHostAllowed`
 *
 * Sibling impl (`./no-op-guard.ts`) is a frozen pass-through used as the
 * default when no guard is wired (byte-identical to the pre-ADR path).
 *
 * Plane-clean: this file imports ONLY `./types` (sibling). Cross-slice imports
 * are confined to the concrete impls + the `@/agent/dispatch.ts` wire site.
 */

import type { GuardDecision } from "./types"

export interface DispatchGuard {
  /** Return the guard's decision for one prospective tool dispatch.
   *
   *  Invariants (HELL-DG-11):
   *   - Pure: no I/O, no global state, no clock/random.
   *   - Deterministic: N invocations on the same (tool, input) return the
   *     STRUCTURALLY-EQUAL decision.
   *   - Total: every input returns a decision; never throws. Bad / unknown
   *     input degrades to `{ kind: "allow" }` (the dispatch path below has
   *     additional security gates — this port is an EARLY filter, not the
   *     final word).
   *
   *  `facts` carries what the dispatch seam already derived for this call, so the guard
   *  judges the same thing the permission policy does. Absent ⇒ the guard falls back to
   *  reading input fields. */
  check(tool: string, input: unknown, facts?: GuardCallFacts): GuardDecision
}

/** Facts the dispatch seam computes once per call and hands to the guard. */
export interface GuardCallFacts {
  /** `registry.extractShellCommand(tool, input)` — the HARD_DENY signal. `null` ⇒ the
   *  tool exposes no shell command for this input. */
  readonly shellCommand: string | null
}
