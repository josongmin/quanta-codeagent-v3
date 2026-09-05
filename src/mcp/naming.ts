/**
 * Canonical MCP identifier / bridged-tool name contract.
 *
 * One character policy for server and tool segments used by health keys,
 * CLI surface keys, and bridged `mcp__<server>__<tool>` names. Callers may
 * format their outer shape; they must not copy the replacement regex.
 *
 * Frozen behavior (do not "improve" silently):
 *   - each maximal run of non `[A-Za-z0-9_]` characters becomes one `_`
 *   - case is preserved
 *   - leading/trailing underscores from replacement are preserved
 *   - empty input stays empty
 *   - collisions (`a-b` vs `a/b`) are a separate detection contract
 */

export const sanitizeMcpNameSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_]+/g, "_")

export const mcpToolName = (server: string, tool: string): string =>
  `mcp__${sanitizeMcpNameSegment(server)}__${sanitizeMcpNameSegment(tool)}`
