/**
 * `@/host/bootstrap/bootstrap-session/bootstrap-fault` — the ONE failure-path
 * pair every bootstrap stage shares.
 *
 * SINGLE RESPONSIBILITY: how a bootstrap stage ABORTS, and how the fleet it may
 * already have started is torn down.
 *   - {@link failSessionBootstrap} — the typed `never` throw (kind + message +
 *     cause) each stage short-circuits through, so every abort reaches the
 *     surface as one `SessionBootstrapError` shape.
 *   - {@link stopMcpClients} — best-effort stop of the loaded MCP fleet, used by
 *     both the session shutdown hook and the bootstrap's own rethrow cleanup.
 *
 * Split out of `bootstrap-session.ts` (god-module cap) — VERBATIM relocation, no
 * behavior delta. The dependency edge is ONE-WAY: the bootstrap and its sibling
 * stages import this; it imports none of them.
 */

import {
  type BootstrapFeatures,
  SessionBootstrapError,
  type SessionBootstrapFailureKind,
} from "../types"

export const failSessionBootstrap = (
  kind: SessionBootstrapFailureKind,
  message: string,
  cause?: unknown,
): never => {
  throw new SessionBootstrapError(kind, message, cause)
}

export const stopMcpClients = async (clients: BootstrapFeatures["mcpClients"]): Promise<void> => {
  for (const client of clients) await client.stop().catch(() => undefined)
}
