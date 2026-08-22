/**
 * Tool profile preset port (ADR-0213).
 *
 * The closed-port surface for named tool-profile bundles ("write" / "ask" /
 * "minimal" / "code-only"). A profile is NOT a permission policy — it is a
 * NAMED bundle of {allow-set, deny-set, default-confirm-set} that the host
 * applies on top of ADR-0046 (permission stack) and ADR-0055
 * (`inferToolTier`).
 *
 * Composition order at runtime (host responsibility):
 *   1. ADR-0213 tool profile        — coarse "what may even be considered"
 *   2. ADR-0055 inferToolTier       — per-tool HITL tier (hand-off / always
 *                                     confirm / pre-approval-ok / none)
 *   3. ADR-0046 permission stack    — per-call evidence + scope decision
 *
 * The profile NEVER calls the lower layers — it returns a typed policy
 * object the host folds into the permission decision stream. Pure-by-
 * contract: every implementation MUST be free of IO, clock reads, and
 * global mutable state.
 *
 * No-throw public surface: unknown profile names return a typed Result
 * shape (`{ok:false, error}`) rather than throw — the resolver path is
 * called from prompt-build / CLI flag parsing and should not crash a
 * REPL session on a typo.
 */

import { QuantaError } from "@/shared"

/** The 4 named profiles (ADR-0213). Closed enum — adding a new profile
 *  requires updating {@link ALL_TOOL_PROFILE_NAMES}, the registry, AND
 *  the cross-check test in `tool-profile-preset-hellgate.test.ts`. The
 *  test fails loudly if the three drift. */
export type ToolProfileName = "write" | "ask" | "minimal" | "code-only"

/** Iteration order — deterministic; tests and the CLI `--tool-profile`
 *  completion rely on this order. */
export const ALL_TOOL_PROFILE_NAMES: ReadonlyArray<ToolProfileName> = [
  "write",
  "ask",
  "minimal",
  "code-only",
] as const

/** Per-tool admissibility under a profile. `allow` = tool may run with
 *  the host's normal permission flow; `confirm` = tool requires explicit
 *  user confirmation even if the underlying permission stack would auto-
 *  approve (the profile NUDGES the HITL tier UP, never DOWN — see
 *  {@link ToolPolicy.composeWithTier}); `deny` = tool is rejected
 *  outright at the profile layer. */
export type ToolProfileAdmissibility = "allow" | "confirm" | "deny"

/** The typed policy a profile emits for one (toolName, isReadOnly) pair.
 *  `kind` is the discriminator; `reason` is a short user-facing string
 *  the host can fold into a deny / confirm message ("ask profile blocks
 *  bash mutations"). */
export interface ToolPolicy {
  readonly kind: ToolProfileAdmissibility
  readonly reason: string
}

/** Resolver port. ONE method: given a profile name and a tool descriptor,
 *  return the typed policy. The resolver is built once per session via
 *  {@link defaultToolProfileResolver} (separate file). */
export interface ToolProfileResolver {
  resolve(input: {
    readonly profileName: ToolProfileName
    readonly toolName: string
    readonly isReadOnly: boolean
  }): ToolPolicy
}

/** Surfaced by the resolver factory when the caller passes an unknown
 *  profile name (out of {@link ALL_TOOL_PROFILE_NAMES}). The error
 *  carries the received string so a typo's source is obvious. */
export class UnknownToolProfileError extends QuantaError {
  readonly received: string
  constructor(received: string) {
    super(
      "unknown_tool_profile",
      `Tool profile ${JSON.stringify(received)} is not registered. ` +
        `Known profiles: ${ALL_TOOL_PROFILE_NAMES.join(", ")}.`,
    )
    this.received = received
  }
}

/** Type guard for the closed {@link ToolProfileName} enum. Used at CLI /
 *  RPC parse boundaries where the input arrives as `string`. */
export const isToolProfileName = (s: unknown): s is ToolProfileName => {
  if (typeof s !== "string") return false
  return (ALL_TOOL_PROFILE_NAMES as ReadonlyArray<string>).includes(s)
}
