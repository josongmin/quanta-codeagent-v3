/** Env-flag check for isolated MCP spawn (ADR-0162 / C-F1).
 *
 *  The parser is deliberately pure: the host composition root owns environment
 *  access and injects the resulting policy into `McpClient`. */

export const ISOLATED_MCP_ENV_VAR = "MCP_USE_ISOLATED_SPAWN"

/** Parse the isolated-spawn flag from caller-owned environment input. */
export const isolatedMcpEnabledFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
): boolean => {
  const v = env[ISOLATED_MCP_ENV_VAR]
  return v === "1" || v === "true" || v === "yes"
}
