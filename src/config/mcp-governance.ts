/**
 * §12.4 LIVE-wire — pure MCP launch-policy filter (E2/E1-sub enforcement half).
 *
 * The central-config merge resolves `mcpEnabledServers` / `mcpDeniedServers`
 * (see `merge.ts`), but resolution alone is INERT — this filter is what a
 * launcher applies to the materialized server list before any spawn.
 *
 * Semantics (chosen to avoid a behavior cliff):
 *   - `deniedServers` — HARD drop, always (tightening; mirrors permission
 *     `deny`, which also survives untrust).
 *   - `enabledServers` — when NON-EMPTY it is an exclusive allowlist (only
 *     listed servers launch); when EMPTY/absent it filters NOTHING, so a
 *     deployment that turns central-config on WITHOUT configuring
 *     `mcp.enabledServers` keeps its `.mcp.json` servers byte-identically.
 *   - Deny wins over enable (defense-in-depth, same rule as the merge).
 *
 * PURE + slice-clean: no gate read (the HOST owns `runtimeConfig().centralConfig`
 * — same design as the rest of `@/config`), no IO, and no `@/mcp` import (the
 * server shape is structural: anything with a `name`).
 */

/** The slice of {@link ResolvedSettings} this filter consumes. */
export interface McpLaunchPolicy {
  readonly enabledServers: readonly string[]
  readonly deniedServers: readonly string[]
}

export interface McpFilterResult<T> {
  /** Servers allowed to launch, original order + references preserved. */
  readonly kept: readonly T[]
  /** Dropped servers + why — the caller surfaces these (warn/log), so
   *  governance is observable, never a silent disappearance. */
  readonly dropped: readonly { readonly name: string; readonly reason: "denied" | "not-enabled" }[]
}

/** Apply the launch policy to a materialized server list. Pure; never throws. */
export const filterMcpServersByPolicy = <T extends { readonly name: string }>(
  servers: readonly T[],
  policy: McpLaunchPolicy,
): McpFilterResult<T> => {
  const denied = new Set(policy.deniedServers)
  const allowlistActive = policy.enabledServers.length > 0
  const enabled = new Set(policy.enabledServers)
  const kept: T[] = []
  const dropped: { name: string; reason: "denied" | "not-enabled" }[] = []
  for (const s of servers) {
    if (denied.has(s.name)) {
      dropped.push({ name: s.name, reason: "denied" })
      continue
    }
    if (allowlistActive && !enabled.has(s.name)) {
      dropped.push({ name: s.name, reason: "not-enabled" })
      continue
    }
    kept.push(s)
  }
  return { kept, dropped }
}
