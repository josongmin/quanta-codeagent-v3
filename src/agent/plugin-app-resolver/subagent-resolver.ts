/**
 * RFC-12-2 — Subagent (named-agent role) sub-resolver for the composite
 * mention resolver. Codex `atMentionList.{liveAgents,customAgents}` parity:
 * `@subagent:<name>` injects the registered role's handle + a one-line
 * description of its role.
 *
 * Owner reuse (NO new store/registry): the resolver is backed by the EXISTING
 * repo-controlled {@link NamedAgentResolver} (`@/agent/named-agent-registry`) —
 * the same read-only port the subagent runner consults for spawn-time role
 * identity. `resolve(agentType)` yields a `NamedAgentDefinition` whose `system`
 * body is the role's system prompt; the injected body is the FIRST LINE of that
 * body (orientation, not the whole prompt — mirrors the skill resolver's
 * first-line policy and keeps the envelope small).
 *
 * FOREIGN-LINEAGE SAFETY (RFC-07): the named-agent registry is populated ONLY
 * from repo-controlled definition files (`.quanta/agents` / `.claude/agents`)
 * loaded for THIS workspace — it never holds another task's live child roster,
 * so a `@subagent:` mention can only ever surface a role the current repo
 * declares. There is no cross-session / cross-task child handle to leak. A miss
 * (unknown handle) ⇒ `null` (skip), never a fabricated stub.
 *
 * NO-THROW: a throwing registry ⇒ `null`. The ADR-0325 `safeCall` wrapper is
 * the belt-and-suspenders second line.
 */

import type { MentionResolverPort } from "@/agent/mention-injection"
import type { NamedAgentResolver } from "@/agent/named-agent-registry"
import { errMessage, logger, mentionFirstLine } from "@/shared"

/**
 * Build the `resolveSubagent` method of a {@link MentionResolverPort}.
 *
 * @param registry — read-only named-agent resolver. Omit ⇒ every `@subagent:`
 *                   mention resolves to `null` (skipped — graceful omit,
 *                   byte-identical to the pre-RFC-12-2 path).
 */
export const createSubagentResolver = (
  registry?: NamedAgentResolver,
): NonNullable<MentionResolverPort["resolveSubagent"]> => {
  return async (target: string) => {
    if (registry === undefined) return null
    if (typeof target !== "string" || target.length === 0) return null
    try {
      const def = registry.resolve(target)
      if (def === undefined || def === null) return null
      const desc = mentionFirstLine(def.system)
      // Handle line is always present; the role description line only when the
      // body yields a non-empty first line.
      const bodyText =
        desc.length > 0 ? `subagent: ${def.agentType}\n${desc}` : `subagent: ${def.agentType}`
      return { bodyText }
    } catch (e) {
      logger.warn(`mention.subagent-resolver: ${errMessage(e)}`)
      return null
    }
  }
}
