import type { LlmTransportSelection, SelectTransportInput } from "../llm"
import { selectLlmTransport } from "../llm"

/** Why the effective transport was chosen. Never a credential value. */
export type LlmTransportReason = "explicit-transport" | "env-signal" | "legacy-default"

/**
 * Diagnostics DTO for boot/status/doctor. Credential provider and actual
 * transport stay separate fields so `/status` cannot report Anthropic BYOK
 * as Bedrock.
 */
export interface LlmTransportProjection {
  readonly requestedTransport: string | undefined
  readonly credentialProvider: string
  readonly effective: LlmTransportSelection
  readonly effectiveId: string
  readonly reason: LlmTransportReason
}

export interface ProjectLlmTransportInput extends SelectTransportInput {
  /** `pickProvider` result — credential/vendor identity, not the cloud transport. */
  readonly credentialProvider: string
}

const requestedOf = (raw: string | undefined): string | undefined => {
  const t = raw?.trim()
  return t !== undefined && t.length > 0 ? t : undefined
}

const reasonOf = (
  requested: string | undefined,
  effective: LlmTransportSelection,
): LlmTransportReason => {
  if (requested !== undefined) return "explicit-transport"
  if (effective.kind === "legacy") return "legacy-default"
  return "env-signal"
}

/** Project the existing transport selector into a log/status-safe DTO. */
export const projectLlmTransport = (input: ProjectLlmTransportInput): LlmTransportProjection => {
  const requestedTransport = requestedOf(input.transport)
  const effective = selectLlmTransport({ transport: input.transport, env: input.env })
  const effectiveId = effective.kind === "legacy" ? "legacy" : effective.providerId
  return {
    requestedTransport,
    credentialProvider: input.credentialProvider,
    effective,
    effectiveId,
    reason: reasonOf(requestedTransport, effective),
  }
}

export const formatLlmTransportProjection = (p: LlmTransportProjection): string =>
  `${p.credentialProvider} · transport=${p.effectiveId} (${p.reason})`
