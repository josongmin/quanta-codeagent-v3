/** Env-flag check for isolated MCP spawn (ADR-0162 / C-F1).
 *
 *  Lives in its own module so {@link defaultTransportFor} can consume it
 *  without importing `isolated-client.ts` (that file is a facade over
 *  `McpClient`, which would cycle through the factory). */

export const ISOLATED_MCP_ENV_VAR = "MCP_USE_ISOLATED_SPAWN"

/** Env-flag check. Exported so wire code in `@/agent` (or apps/cli) can
 *  branch on the same source of truth, instead of re-reading the env. */
export const isolatedMcpEnabledFromEnv = (env?: Record<string, string | undefined>): boolean => {
  const source = env ?? (process.env as Record<string, string | undefined>)
  const v = source[ISOLATED_MCP_ENV_VAR]
  return v === "1" || v === "true" || v === "yes"
}
