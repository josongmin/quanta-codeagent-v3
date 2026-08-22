/**
 * RFC-12-2 — MCP server sub-resolver for the composite mention resolver.
 * Codex `atMentionList.mcpServers` parity: `@mcp:<server>` injects the named
 * server's exposed tool list so the model sees WHICH tools that server offers.
 *
 * Owner reuse (NO new store/registry): this slice NEVER spins up an MCP client
 * itself. The composition root injects a {@link McpServerListingPort} — a thin
 * read-only port backed by the ALREADY-LIVE loaded-tools set (the host's
 * `loadMcpTools` result: server name → its `Tool[]`), exactly as the git
 * resolver takes an injected `GitContextProvider` rather than spawning git. A
 * test injects a canned port for deterministic replay.
 *
 * Body: `mcp: <server>` header + one line per tool (`- <name> — <first line of
 * description>`), bounded to {@link McpResolverOptions.maxTools} tool lines
 * (orientation, not the full schema dump). A server with zero tools ⇒ a
 * present-but-header-only body (the server EXISTS, it just exposes nothing yet)
 * — distinct from an UNKNOWN server, which the port reports as `null` (skip).
 *
 * NO-THROW: a throwing / rejecting port ⇒ `null`. The ADR-0325 `safeCall`
 * wrapper is the belt-and-suspenders second line.
 */

import type { MentionResolverPort } from "@/agent/mention-injection"
import { errMessage, logger } from "@/shared"

/** One tool a server exposes (the read-only projection the port yields). */
export interface McpToolInfo {
  readonly name: string
  readonly description?: string
}

/**
 * Injected read-only MCP-server listing port. Returns the tool list for a
 * named server, or `null` when NO server by that name is loaded (⇒ the mention
 * is skipped). An EMPTY array means "server known, zero tools". MUST be
 * NO-THROW per the resolver contract; the wrapper catches regardless.
 */
export type McpServerListingPort = (server: string) => Promise<readonly McpToolInfo[] | null>

/** Options for {@link createMcpResolver}. */
export interface McpResolverOptions {
  /** Injected listing port. Absent ⇒ every `@mcp:` mention resolves to `null`. */
  readonly listing: McpServerListingPort
  /** Max tool lines spliced before truncation. Default {@link DEFAULT_MCP_MAX_TOOLS}. */
  readonly maxTools?: number
}

/** Default per-server tool-line cap. */
export const DEFAULT_MCP_MAX_TOOLS = 64

const resolveMaxTools = (raw: number | undefined): number =>
  typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.trunc(raw)
    : DEFAULT_MCP_MAX_TOOLS

/** First line of a tool description (LF / CRLF tolerant). Pure. */
const firstLineOf = (description: string | undefined): string => {
  if (typeof description !== "string" || description.length === 0) return ""
  const nl = description.indexOf("\n")
  const slice = nl === -1 ? description : description.slice(0, nl)
  return (slice.endsWith("\r") ? slice.slice(0, -1) : slice).trim()
}

/** Project one tool into its body line (`- name — first-line-desc`), or `null`
 *  for a nameless tool (skipped). Pure. */
const toolLine = (t: McpToolInfo): string | null => {
  if (typeof t?.name !== "string" || t.name.length === 0) return null
  const desc = firstLineOf(t.description)
  return desc.length > 0 ? `- ${t.name} — ${desc}` : `- ${t.name}`
}

/** Render the bounded body for a known server's tool list. Extracted from the
 *  resolver closure so that stays under the cognitive-complexity ratchet. */
const renderMcpBody = (server: string, tools: readonly McpToolInfo[], maxTools: number): string => {
  const lines: string[] = [`mcp: ${server}`]
  let shown = 0
  for (const t of tools) {
    if (shown >= maxTools) {
      lines.push(`… (${tools.length - shown} more tools)`)
      break
    }
    const line = toolLine(t)
    if (line === null) continue
    lines.push(line)
    shown += 1
  }
  return lines.join("\n")
}

/**
 * Build the `resolveMcp` method of a {@link MentionResolverPort}.
 *
 * @param opts — injected listing port + optional tool-line cap. An absent port
 *               ⇒ every `@mcp:` mention resolves to `null` (graceful omit).
 */
export const createMcpResolver = (
  opts: McpResolverOptions,
): NonNullable<MentionResolverPort["resolveMcp"]> => {
  const listing = opts?.listing
  const maxTools = resolveMaxTools(opts?.maxTools)
  return async (target: string) => {
    if (typeof listing !== "function") return null
    if (typeof target !== "string" || target.length === 0) return null
    try {
      const tools = await listing(target)
      // null ⇒ unknown server (skip). An empty array ⇒ known-but-toolless.
      if (tools === null || tools === undefined) return null
      return { bodyText: renderMcpBody(target, tools, maxTools) }
    } catch (e) {
      logger.warn(`mention.mcp-resolver: ${errMessage(e)}`)
      return null
    }
  }
}
