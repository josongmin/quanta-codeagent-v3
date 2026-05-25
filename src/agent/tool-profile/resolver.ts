/**
 * Tool profile resolver (ADR-0213).
 *
 * Builds the {@link ToolProfileResolver} that the host calls per-tool-call.
 * Evaluation precedence (first match wins):
 *   1. explicit per-tool entry in the preset's `tools` map
 *   2. category fallback (defaultReadOnly / defaultMutating)
 *
 * No-throw public surface: an UNKNOWN profile name at construction time
 * throws {@link UnknownToolProfileError} (programmer error — the host's
 * CLI / RPC parse should have caught it earlier); the per-call resolve
 * NEVER throws because the profile is validated at the seam.
 *
 * Composability note: the resolver returns a `ToolPolicy` that the host
 * folds INTO the permission stack (ADR-0046) + the HITL tier inference
 * (ADR-0055). The profile NUDGES decisions UP toward stricter (allow →
 * confirm, confirm → deny) — it NEVER nudges DOWN (deny → allow). The
 * helper {@link composeToolProfileWithBaseline} encodes that rule for
 * callers that want a single composed decision.
 */

import {
  type ToolPolicy,
  type ToolProfileAdmissibility,
  type ToolProfileName,
  type ToolProfileResolver,
  UnknownToolProfileError,
} from "./port"
import { defaultToolProfileRegistry, type ToolProfileRegistry } from "./registry"

/** Construct the default {@link ToolProfileResolver}. `registry` is
 *  optional — absent ⇒ {@link defaultToolProfileRegistry} is used. The
 *  resolver validates the active profile at construction time so a typo
 *  surfaces here rather than at the per-call seam. */
export const defaultToolProfileResolver = (opts?: {
  readonly registry?: ToolProfileRegistry
}): ToolProfileResolver => {
  const registry = opts?.registry ?? defaultToolProfileRegistry()
  return {
    resolve(input: {
      profileName: ToolProfileName
      toolName: string
      isReadOnly: boolean
    }): ToolPolicy {
      const preset = registry.getPreset(input.profileName)
      if (preset === undefined) {
        throw new UnknownToolProfileError(input.profileName)
      }
      const explicit = preset.tools[input.toolName]
      if (explicit !== undefined) {
        return {
          kind: explicit,
          reason: `tool-profile "${input.profileName}" explicit rule for "${input.toolName}"`,
        }
      }
      const fallback: ToolProfileAdmissibility = input.isReadOnly
        ? preset.defaultReadOnly
        : preset.defaultMutating
      return {
        kind: fallback,
        reason: `tool-profile "${input.profileName}" default for ${input.isReadOnly ? "read-only" : "mutating"} tools`,
      }
    },
  }
}

/** Strictest-wins composition with a baseline admissibility (the
 *  permission stack's verdict). The profile may only NUDGE UP toward
 *  stricter outcomes:
 *
 *    deny    overrides everything
 *    confirm overrides allow
 *    allow   is overridden by both
 *
 *  Pure. Exposed so the host's dispatch seam can fold the profile result
 *  into the existing permission decision stream with ONE call. */
export const composeToolProfileWithBaseline = (
  baseline: ToolProfileAdmissibility,
  profile: ToolProfileAdmissibility,
): ToolProfileAdmissibility => {
  if (baseline === "deny" || profile === "deny") return "deny"
  if (baseline === "confirm" || profile === "confirm") return "confirm"
  return "allow"
}
