/**
 * Identity provider port (ADR-0198).
 *
 * The closed-port surface for the per-mode identity slot. A provider yields
 * 1..=3 identity lines for each `IdentityMode`; the prompt builder splices
 * the lines between the intro and the persona slot.
 *
 * Pure-by-contract: implementations MUST NOT touch IO, the clock, or any
 * global mutable state. Tests inject hand-rolled providers; the
 * `defaultIdentityProvider` is the production default-impl.
 */

import { QuantaError } from "@/shared"
import type { AgentMode } from "../prompt"

/** Identity-only superset of {@link AgentMode}. `onboarding` is a virtual
 *  mode that exists for first-session priming; it does NOT participate in
 *  dispatch admissibility or the per-turn mode-notice routing. The legacy
 *  `AgentMode` enum stays untouched (4 values) — adding `onboarding` to
 *  that enum would force a fail-closed admissibility-table update across
 *  the whole codebase for a slot that is identity-only. */
export type IdentityMode = AgentMode | "onboarding"

/** Iteration order for the closed enum (deterministic; tests + future
 *  surface knobs rely on this order). ADR-0211 extends with `architect`
 *  + `editor` — both are new `AgentMode` values, so they appear here
 *  automatically by virtue of `IdentityMode = AgentMode | "onboarding"`. */
export const IDENTITY_MODES: ReadonlyArray<IdentityMode> = [
  "default",
  "plan",
  "review",
  "audit",
  "architect",
  "editor",
  "onboarding",
] as const

/** Identity provider port (ADR-0198). Single method: yield the identity
 *  lines for a mode. The return type is `readonly string[]` so callers
 *  cannot mutate the provider's table. Unknown mode values resolve to a
 *  typed `unknown-mode` line rather than throwing (the prompt path must
 *  not crash on a stale mode flag from a future enum extension). */
export interface IdentityProvider {
  identityFor(mode: IdentityMode): readonly string[]
}

/** Thrown by {@link assertValidIdentityLines} when an identity line contains
 *  an embedded newline / CR or is empty after trim. Embedded newlines would
 *  forge a section header inside the cached prefix; empty entries would emit
 *  a stray blank line that visually collides with the persona/Policy
 *  separator. No silent normalization. */
export class IdentityLineError extends QuantaError {
  readonly lineIndex: number
  readonly received: string
  constructor(lineIndex: number, received: string, reason: string) {
    super(
      "identity_line_invalid",
      `Identity line at index ${lineIndex} is invalid (${reason}). ` +
        `Lines must be non-empty single-line strings (no \\n / \\r). ` +
        `Got: ${JSON.stringify(received)}`,
    )
    this.lineIndex = lineIndex
    this.received = received
  }
}

/** Validate every entry in a caller-supplied identity-line array. Throws
 *  {@link IdentityLineError} on the first offending entry; returns the
 *  validated array unchanged on success. Pure. */
export const assertValidIdentityLines = (lines: readonly string[]): readonly string[] => {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (line.trim().length === 0) {
      throw new IdentityLineError(i, line, "empty after trim")
    }
    if (line.includes("\n")) {
      throw new IdentityLineError(i, line, "contains LF")
    }
    if (line.includes("\r")) {
      throw new IdentityLineError(i, line, "contains CR")
    }
  }
  return lines
}
