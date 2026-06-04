/**
 * Skill→MCP composition wire (ADR-0476 — composition-layer adapter).
 *
 * WHAT: builds the per-session `SkillMcpSession` the loop drives
 * (`reconcileSkillMcpForTurn` / `shutdownAll`), wiring the slice's transport-
 * agnostic `AttachMcpPort` onto REAL infra:
 *   - stdio carriers ➝ `@/agent/plugin-mcp-launcher` (`createIsolatedMcpLauncherPort`),
 *   - HTTP carriers  ➝ `@/mcp` `McpClient` over the ADR-0391 Streamable-HTTP/SSE
 *     transport (`HttpSseMcpTransport`).
 *
 * This is the ONE place allowed to adapt those concrete infra modules down onto
 * the skill-mcp slice's injected PORT shapes — exactly like `lsp-bridge.ts` /
 * `edit-repair-wire.ts`. The slice (`@/skill/skill-mcp-deps`) imports `@/shared`
 * ONLY and never reaches a launcher or socket itself.
 *
 * NO-THROW (boundary contract): a connect that rejects mid-handshake collapses
 * to a degraded outcome inside the attach adapter (the identity is left
 * untracked so a later reconcile retries); a teardown that throws is swallowed.
 * Nothing here escapes as an exception past the port boundary.
 *
 * DEFAULT-OFF: this builder is INERT until the composition root (assembler
 * `maybeWireSkillMcp`) calls it behind `QUANTA_SKILL_MCP_DEPS=1`; constructing
 * the session attaches nothing — only `reconcileSkillMcpForTurn` does.
 */

import { HttpSseMcpTransport, McpClient } from "@/mcp"
import { errMessage } from "@/shared"
import {
  createSkillMcpSession,
  type McpServerSpec,
  type SkillMcpDepsEnv,
  type SkillMcpSession,
} from "@/skill/skill-mcp-deps"
import { createIsolatedMcpLauncherPort } from "./plugin-mcp-launcher"
import {
  createSkillMcpAttachAdapter,
  type HttpMcpConnection,
  type HttpMcpConnectPort,
} from "./skill-mcp-attach-adapter"

/**
 * Build the HTTP-carrier connect port: open an `McpClient` over the
 * Streamable-HTTP/SSE transport (ADR-0391) for an HTTP-carrier skill dep, never
 * spawning a process. The returned `HttpMcpConnection.stop()` is idempotent +
 * NO-THROW (it wraps `McpClient.stop()`, itself `if (stopped) return`).
 *
 * Contract: a connect FAILURE REJECTS (the attach adapter catches the rejection
 * and leaves the identity untracked for a later retry). On a partial start we
 * best-effort stop the client so a failed handshake never leaks a carrier.
 */
export const buildSkillMcpHttpConnect = (): HttpMcpConnectPort => ({
  connect: async (spec: McpServerSpec, id: string): Promise<HttpMcpConnection> => {
    const url = spec.url ?? ""
    if (url.trim().length === 0) {
      // Defensive: an HTTP-carrier spec ALWAYS carries a url (parseSkillMcpDeps
      // rejects an http dep with no url as malformed before it ever reaches a
      // spec). Reject rather than open a client against "" so a contract
      // violation upstream degrades to attached:false, never a half-open client.
      throw new Error(`skill-mcp http connect: empty url for ${spec.serviceName}`)
    }
    const transport = new HttpSseMcpTransport({ url, name: spec.serviceName })
    const client = new McpClient({ name: spec.serviceName, command: [], url }, { transport })
    try {
      await client.start()
    } catch (e) {
      // Partial handshake — drop the half-open client, then REJECT so the
      // adapter records attached:false (NO leak, retry-able next reconcile).
      await client.stop().catch(() => undefined)
      throw new Error(`skill-mcp http connect failed for ${spec.serviceName}: ${errMessage(e)}`)
    }
    return {
      id,
      stop: async () => {
        await client.stop().catch(() => undefined)
      },
    }
  },
})

/**
 * Mint ONE per-session `SkillMcpSession` bound to the REAL stdio launcher + HTTP
 * connect port. The session's resolver is gate-aware (`QUANTA_SKILL_MCP_DEPS`),
 * so a gate-off session reconciles to the empty set (attaches nothing) — the
 * assembler still gates construction itself so the typical path allocates
 * nothing.
 *
 * @param env — the surface-owned env projection (never `process.env`); captured
 *              once for the session's gate reads.
 */
export const buildSkillMcpSession = (env: SkillMcpDepsEnv): SkillMcpSession => {
  const adapter = createSkillMcpAttachAdapter({
    launcher: createIsolatedMcpLauncherPort(),
    httpConnect: buildSkillMcpHttpConnect(),
  })
  return createSkillMcpSession(adapter.ports, env)
}
