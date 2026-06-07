/**
 * CLI wiring for the `fetch_rules` tool (gap-other-agent GAP 6, ADR-0509).
 *
 * Lives in `src/apps/cli/` (the surface layer) because it bridges two planes:
 * the rule loader (`@/agent/glob-rules#loadRequestableRules`) + the matcher
 * (`@/agent/agent-requested-rules#matchRulesByDescription`) on one side, and the
 * plane-clean `fetch_rules` tool / `FetchRulesPort` on the other. The composition
 * root may not import `@/agent` into `@/tool`, so this app-layer adapter does it.
 *
 * The port LAZILY loads the requestable-rules index on each call (keyed by cwd) —
 * `fetch_rules` is a rare tool, and a lazy load avoids a sync-fs read at the
 * (synchronous) tooling-assembly seam. Loaded rules are cached per-cwd so repeated
 * calls within a session do not re-walk the rule dirs.
 *
 * Default-OFF: `buildCliFetchRulesTool` returns `null` unless `QUANTA_FETCH_RULES`
 * is on (byte-identical menu — the agent never sees `fetch_rules`).
 */

import { matchRulesByDescription } from "@/agent/agent-requested-rules"
import { loadRequestableRules } from "@/agent/glob-rules"
import { gateOn } from "@/shared"
import type { Tool } from "@/tool"
import { type FetchRulesPort, fetchRulesTool } from "@/tool/fetch-rules"

/** Build a {@link FetchRulesPort} that lazily loads + caches the requestable
 *  index for `cwd`, then ranks it with the pure matcher. NO-THROW: a load
 *  failure yields an empty match set (the tool reports "no matching rules"). */
export const fetchRulesPortForCwd = (cwd: string): FetchRulesPort => {
  let cache: Awaited<ReturnType<typeof loadRequestableRules>> | undefined
  return {
    fetch: async (query, limit) => {
      if (cache === undefined) {
        try {
          cache = await loadRequestableRules(cwd)
        } catch {
          cache = []
        }
      }
      return matchRulesByDescription(query, cache, limit)
    },
  }
}

/**
 * Build the CLI `fetch_rules` tool, or `null` when it should not be registered.
 * Returns the tool ONLY when `QUANTA_FETCH_RULES` is on. Off ⇒ `null` ⇒ the tool
 * is absent (byte-identical menu). The index is loaded lazily on first call, so
 * an enabled gate with zero requestable rules simply returns "no matching rules".
 */
export const buildCliFetchRulesTool = (
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Tool | null => {
  if (!gateOn(env, "QUANTA_FETCH_RULES")) return null
  return fetchRulesTool(fetchRulesPortForCwd(cwd)) as Tool
}
