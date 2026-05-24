/**
 * Default identity provider factory (ADR-0198).
 *
 * Closed-port default-impl: returns a provider whose `identityFor(mode)`
 * looks up the bundled {@link DEFAULT_IDENTITIES} table; an optional
 * `overrides` map shallow-replaces entries at construction time.
 *
 * Pure: the factory and the returned provider take no IO, no clock,
 * no global mutable state. Returned arrays are defensive copies so a
 * caller mutating the result cannot poison subsequent lookups.
 */

import { DEFAULT_IDENTITIES, UNKNOWN_MODE_IDENTITY } from "./default-identities"
import {
  assertValidIdentityLines,
  IDENTITY_MODES,
  type IdentityMode,
  type IdentityProvider,
} from "./port"

/** Build the default {@link IdentityProvider}. `overrides` is an optional
 *  partial map keyed by {@link IdentityMode}; supplied entries replace the
 *  default table for THAT mode only — every absent key falls through to
 *  {@link DEFAULT_IDENTITIES}. Each override array is validated by
 *  {@link assertValidIdentityLines} once at construction time so a forged
 *  newline-bearing or empty entry surfaces immediately, not deep inside the
 *  prompt-build path. */
export const defaultIdentityProvider = (
  overrides?: Partial<Record<IdentityMode, readonly string[]>>,
): IdentityProvider => {
  const table: Record<IdentityMode, readonly string[]> = {
    default: DEFAULT_IDENTITIES.default,
    plan: DEFAULT_IDENTITIES.plan,
    review: DEFAULT_IDENTITIES.review,
    audit: DEFAULT_IDENTITIES.audit,
    onboarding: DEFAULT_IDENTITIES.onboarding,
  }
  if (overrides !== undefined) {
    for (const mode of IDENTITY_MODES) {
      const o = overrides[mode]
      if (o !== undefined) {
        table[mode] = assertValidIdentityLines(o)
      }
    }
  }
  return {
    identityFor(mode: IdentityMode): readonly string[] {
      const lines = (table as Record<string, readonly string[] | undefined>)[mode]
      // Defensive copy so a caller mutating the returned array cannot
      // affect the next lookup (HELL-ID-10).
      return lines !== undefined ? [...lines] : [...UNKNOWN_MODE_IDENTITY]
    },
  }
}
