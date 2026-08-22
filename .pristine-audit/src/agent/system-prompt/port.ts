/**
 * System-prompt mode-variant port (ADR-0211).
 *
 * The closed-port surface for the per-mode system-prompt variant slot. This
 * slice sits ABOVE the identity slice (ADR-0198) and the persona slot
 * (ADR-0068): callers pick a `ModeVariantKey`, the variant registry yields
 * an identity-line override, and the builder threads it through
 * `buildSystemPrompt({ identity })` — which is already byte-stable when the
 * override is absent.
 *
 * Pure-by-contract: every implementation MUST be free of IO, clock reads, and
 * global mutable state. Tests inject hand-rolled registries; the default
 * registry (`defaultModeVariantRegistry`) is the production default-impl.
 */

import { QuantaError } from "@/shared"
import type { AgentMode } from "../prompt"

/** The closed enum of mode-variant keys the registry accepts. Aligned 1:1
 *  with {@link AgentMode} (ADR-0211 extended the upstream enum with
 *  `architect` + `editor`); re-exported under this distinct alias so the
 *  slice surface is independent of the upstream name in case the posture
 *  enum widens to non-prompt-relevant values in a later round. */
export type ModeVariantKey = AgentMode

/** Iteration order for the closed enum — deterministic; tests rely on this
 *  order to assert variants. Mirrors `IDENTITY_MODES` ordering convention
 *  (default first, then plan/review/audit, then ADR-0211 extensions). */
export const MODE_VARIANT_KEYS: ReadonlyArray<ModeVariantKey> = [
  "default",
  "plan",
  "review",
  "audit",
  "architect",
  "editor",
] as const

/** One variant entry — the per-mode identity lines that the system-prompt
 *  builder splices through `buildSystemPrompt({ identity })`. Multi-line
 *  identities must be expressed as multiple array entries; embedded LF/CR
 *  is rejected at construction time (see {@link assertValidVariantLines}). */
export interface ModeVariant {
  readonly mode: ModeVariantKey
  readonly identity: readonly string[]
}

/** The variant registry port. A registry yields the variant for a given
 *  mode key. Unknown mode values return a typed fallback rather than
 *  throwing — the prompt path must not crash on a stale mode flag from a
 *  future enum extension. */
export interface SystemPromptVariantRegistry {
  variantFor(mode: ModeVariantKey): ModeVariant
}

/** Thrown by {@link assertValidVariantLines} when an identity line is empty
 *  after trim or contains an embedded newline / CR. The same hygiene rules
 *  the identity slice enforces (ADR-0198) apply here because the lines flow
 *  into the SAME splice site and the SAME cached prefix. */
export class ModeVariantLineError extends QuantaError {
  readonly mode: ModeVariantKey
  readonly lineIndex: number
  readonly received: string
  constructor(mode: ModeVariantKey, lineIndex: number, received: string, reason: string) {
    super(
      "mode_variant_line_invalid",
      `Mode-variant identity line (mode="${mode}", index=${lineIndex}) is invalid (${reason}). ` +
        `Lines must be non-empty single-line strings (no \\n / \\r). ` +
        `Got: ${JSON.stringify(received)}`,
    )
    this.mode = mode
    this.lineIndex = lineIndex
    this.received = received
  }
}

/** Validate every entry in a caller-supplied variant identity-line array.
 *  Throws {@link ModeVariantLineError} on the first offending entry. Pure. */
export const assertValidVariantLines = (
  mode: ModeVariantKey,
  lines: readonly string[],
): readonly string[] => {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (line.trim().length === 0) {
      throw new ModeVariantLineError(mode, i, line, "empty after trim")
    }
    if (line.includes("\n")) {
      throw new ModeVariantLineError(mode, i, line, "contains LF")
    }
    if (line.includes("\r")) {
      throw new ModeVariantLineError(mode, i, line, "contains CR")
    }
  }
  return lines
}
