import type { CapabilityExpectation, CapabilityManifest } from "@/protocol/session"
import { normalizeCapabilityManifest, SessionProtocolValidationError } from "@/protocol/session"

export interface DerivedRuntimeCapabilitiesInput {
  readonly approvals: boolean
  readonly tools: boolean
  readonly memory: boolean
  readonly artifacts: boolean
  readonly subagents: boolean
  readonly automation: boolean
  readonly shellSnapshot: boolean
  readonly transport?: CapabilityManifest["transport"]
}

const freezeCapabilityManifest = (manifest: CapabilityManifest): CapabilityManifest =>
  Object.freeze({ ...manifest })

export const buildCapabilityManifest = (
  manifest: Partial<CapabilityManifest> | undefined,
): CapabilityManifest => freezeCapabilityManifest(normalizeCapabilityManifest(manifest))

export const deriveCapabilityManifest = (
  input: DerivedRuntimeCapabilitiesInput,
): CapabilityManifest =>
  freezeCapabilityManifest(
    normalizeCapabilityManifest({
      approvals: input.approvals ? "operator" : "none",
      tools: input.tools,
      memory: input.memory,
      artifacts: input.artifacts,
      subagents: input.subagents,
      automation: input.automation,
      shellSnapshot: input.shellSnapshot,
      transport: input.transport ?? "inproc",
    }),
  )

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
