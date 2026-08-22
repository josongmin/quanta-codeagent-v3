import type { AgentConfig } from "@/agent"

/**
 * Surface-agnostic verify-guard config assembly (Tier 0 safety hardening,
 * ADR-0011). Default OFF: `enabled !== true` ⇒ `undefined` so the key is
 * omitted and the loop is byte-identical (no tool-history, no finish
 * interception). When enabled, a finish right after an unverified mutating
 * tool is blocked, forcing one more turn up to `maxTrips` (else default 2).
 */

export interface VerifyGuardConfigAssembleInput {
  /** Equivalent of `QUANTA_VERIFY_GUARD !== undefined`. */
  enabled: boolean
  /** `QUANTA_VERIFY_GUARD_MAX_TRIPS` parsed → finite int. */
  maxTrips?: number | undefined
}

export const buildVerifyGuardConfigCore = (
  input: VerifyGuardConfigAssembleInput,
): AgentConfig["verifyGuard"] | undefined => {
  if (!input.enabled) return undefined
  return input.maxTrips !== undefined && Number.isFinite(input.maxTrips)
    ? { maxTrips: input.maxTrips }
    : {}
}
