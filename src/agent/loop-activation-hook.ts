/**
 * ADR-0346 — Loop integration for ADR-0340 plugin activation trigger.
 *
 * `prepareTurnContext` (in `./loop.ts`) calls `resolvePluginActivationForTurn`
 * once per attempt, BEFORE `buildTurnContext`. The returned `resolvedSkills`
 * are unioned with the caller-supplied `activeSkills` via
 * {@link unionActiveSkills} (ADR-0339) so plugin-declared skills surface on
 * the active-skills channel for the same turn that the mention was parsed.
 *
 * Wiring closes the dangling ADR-0340 seam:
 *
 *   - ADR-0340 introduced `AgentConfig.activatePlugins?` but left invocation
 *     to the caller. With this hook in place, composition roots that set
 *     `cfg.activatePlugins` get per-turn activation FOR FREE — no extra
 *     surface code required.
 *   - ADR-0338 (`launchPluginMcpServers`) is invoked transitively by the
 *     activation handler the composition root assembled, so this hook is
 *     also the trigger for plugin MCP-server spawn (follow-up #3 of
 *     ADR-0338).
 *
 * Non-goals:
 *   - This module does NOT mutate `AgentConfig` (no new slot).
 *   - This module does NOT touch `@/agent/prompt` (`buildTurnContext`).
 *   - This module does NOT own MCP-handle lifetime — that stays with the
 *     composition root's `PluginMcpRegistry` (ADR-0338 lifetime contract).
 *
 * Slice fence:
 *   - imports `@/agent/mention-injection` (parseMentions + ParsedMention
 *     type) and `@/agent/plugin-skill-extension` (ActiveSkillDescriptor
 *     type) — both are pure leaf primitives by design.
 *   - imports `@/agent/plugin-activation-handler` ONLY for the
 *     AggregatedActivation type.
 *   - MUST NOT import `@/agent/loop`, `@/agent/dispatch`, `@/agent/prompt`
 *     to keep the slice acyclic — `loop.ts` imports US, not the reverse.
 *
 * NO-THROW invariants (per defence-in-depth):
 *   - `config.activatePlugins === undefined` ⇒ no work, empty resolvedSkills.
 *   - empty / missing user text ⇒ no work.
 *   - thrown `parseMentions` ⇒ swallow, empty resolvedSkills.
 *   - thrown `activatePlugins` ⇒ swallow, empty resolvedSkills.
 *   - any other failure ⇒ swallow.
 *
 *   This means absent / failing activation can NEVER break a turn. With
 *   `cfg.activatePlugins` absent the hook returns
 *   `{ resolvedSkills: [] }` so the caller's `unionActiveSkills` is a
 *   byte-identical pass-through (existing entries kept, no plugin entries
 *   appended).
 */

import type { ParsedMention } from "@/agent/mention-injection"
import type { AggregatedActivation } from "@/agent/plugin-activation-handler"
import { type ActiveSkillDescriptor, unionActiveSkills } from "@/agent/plugin-skill-extension"

/**
 * Narrow subset of `AgentConfig` that the hook reads. Kept structural so
 * tests can pass a 1-field object without conjuring an entire AgentConfig.
 */
export interface ActivationHookConfigLike {
  readonly activatePlugins?: (
    mentions: readonly ParsedMention[],
    opts?: { readonly turnId?: string },
  ) => Promise<AggregatedActivation>
}

/**
 * Result shape — narrow on purpose. The caller only needs
 * `resolvedSkills` to union into `TurnContextInput.activeSkills`. Handles
 * are intentionally OMITTED here: their lifetime is owned by the
 * composition root's `PluginMcpRegistry` (ADR-0338), not the loop. The
 * underlying activation handler already retained them in the registry
 * before this function returned.
 */
export interface ResolvedPluginActivation {
  readonly resolvedSkills: readonly ActiveSkillDescriptor[]
}

const EMPTY: ResolvedPluginActivation = Object.freeze({
  resolvedSkills: Object.freeze([]) as readonly ActiveSkillDescriptor[],
})

/**
 * Convenience: union the caller's `activeSkills` with the plugin-resolved
 * skills returned by `resolvePluginActivationForTurn`, projecting the
 * `readonly ActiveSkillDescriptor[]` result into the mutable
 * `{name,description}[]` shape that downstream `TurnContextInput.activeSkills`
 * expects (legacy shape pre-readonly).
 *
 * Byte-identical no-op path:
 *   - When `resolvedSkills` is empty, returns the caller's `activeSkills`
 *     reference VERBATIM (same identity, no allocation). The trade-off:
 *     we cannot freeze the result, so callers must continue to treat
 *     `activeSkills` as opaque.
 *   - When plugin skills exist, allocates a single new mutable array.
 *
 * Pure function — extracted from `prepareTurnContext` purely to keep the
 * loop's cognitive complexity inside the biome ceiling.
 */
export const augmentActiveSkillsWithPlugin = (
  callerActiveSkills: { name: string; description: string }[] | undefined,
  pluginActivation: ResolvedPluginActivation,
): { name: string; description: string }[] | undefined => {
  if (pluginActivation.resolvedSkills.length === 0) return callerActiveSkills
  const merged = unionActiveSkills(callerActiveSkills, pluginActivation.resolvedSkills)
  return merged.map((s) => ({ name: s.name, description: s.description }))
}

/**
 * Per-turn plugin activation hook. Called by `prepareTurnContext` AFTER
 * memory recall / compaction but BEFORE `buildTurnContext` so the
 * resulting skills ride the SAME prompt build.
 *
 * @param config             — narrow AgentConfig view; only
 *                             `activatePlugins?` is read.
 * @param latestUserText     — last user-role text content in working memory
 *                             (loop.ts derives this via `latestUserTextFromWm`).
 *                             Absent / empty ⇒ no work.
 * @param turnId             — opaque per-turn id forwarded to the activation
 *                             handler for correlation only. May be undefined.
 * @returns                  — `{ resolvedSkills: readonly ... }`. NEVER throws.
 *                             Absent activator OR empty user text OR zero
 *                             mentions ⇒ canonical-empty `EMPTY` constant.
 */
export const resolvePluginActivationForTurn = async (
  config: ActivationHookConfigLike,
  latestUserText: string | undefined,
  turnId: string | undefined,
): Promise<ResolvedPluginActivation> => {
  if (config.activatePlugins === undefined) return EMPTY
  if (latestUserText === undefined || latestUserText.length === 0) return EMPTY
  let mentions: readonly ParsedMention[]
  try {
    // Lazy import keeps this slice's static import graph minimal — the
    // mention-injection module is only loaded when an activation handler
    // is actually wired. parseMentions itself is pure + sync, but the
    // dynamic import bounds the slice fence even tighter.
    const mod = await import("@/agent/mention-injection")
    mentions = mod.parseMentions(latestUserText)
  } catch {
    return EMPTY
  }
  if (mentions.length === 0) return EMPTY
  try {
    const opts = turnId !== undefined ? { turnId } : undefined
    const agg = await config.activatePlugins(mentions, opts)
    // Defensive narrow: an activation closure SHOULD return
    // `{ handles, resolvedSkills }` but a non-conforming impl must not
    // poison the loop. Treat anything non-array as empty.
    const resolved = Array.isArray(agg?.resolvedSkills) ? agg.resolvedSkills : []
    return { resolvedSkills: resolved }
  } catch {
    return EMPTY
  }
}
