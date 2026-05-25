import type { CapabilityExpectation, CapabilityManifest } from "@/protocol/session"
import { normalizeCapabilityManifest, SessionProtocolValidationError } from "@/protocol/session"
import type { SessionDeps } from "@/runner/assemble"

export const buildCapabilityManifestFromSessionDeps = (deps: SessionDeps): CapabilityManifest =>
  normalizeCapabilityManifest({
    approvals: "operator",
    tools: deps.registry.all().length > 0,
    memory:
      deps.store !== undefined ||
      deps.memoryConsolidator !== undefined ||
      deps.memoryConfig !== undefined,
    artifacts: true,
    subagents:
      deps.subagentConfig !== undefined ||
      deps.delegation !== undefined ||
      deps.subagentBackground !== undefined,
    automation: deps.automationEngine !== undefined,
    shellSnapshot: deps.shellSnapshot !== undefined,
    transport: "inproc",
  })

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
