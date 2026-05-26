import type { CapabilityExpectation, CapabilityManifest } from "@/protocol/session"
import { normalizeCapabilityManifest, SessionProtocolValidationError } from "@/protocol/session"

export const buildCapabilityManifest = (
  manifest: Partial<CapabilityManifest> | undefined,
): CapabilityManifest => normalizeCapabilityManifest(manifest)

export const assertCapabilityExpectation = (
  expected: CapabilityExpectation | undefined,
  actual: CapabilityManifest,
): void => {
  if (expected === undefined) return
  for (const [key, value] of Object.entries(expected) as Array<
    [keyof CapabilityManifest, unknown]
  >) {
    if (value !== undefined && actual[key] !== value) {
      throw new SessionProtocolValidationError(
        `capability_mismatch_${key}`,
        `expected capability ${key}=${String(value)}, got ${String(actual[key])}`,
      )
    }
  }
}
