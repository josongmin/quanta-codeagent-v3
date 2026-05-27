/**
 * ADR-0340 — `activatePluginsFromMentions`.
 *
 * Given the parsed mentions from one turn (ADR-0325 `ParsedMention[]`),
 * activate EVERY `kind === "plugin"` entry by delegating to the per-plugin
 * activation handler closure. Skill mentions (`@skill`) and app mentions
 * (`@@app`) are ignored — those flow through ADR-0330 mention-runner
 * (skill) / future ADR (app).
 *
 * # Output shape
 *
 * Returns an {@link AggregatedActivation} carrying:
 *   - `handles`: every `McpServerHandle` produced across all activations,
 *     IN ORDER OF MENTION OCCURRENCE then per-handler launch order. NOT
 *     deduped — the launcher already guarantees per-`(pluginId, serverName)`
 *     idempotency.
 *   - `resolvedSkills`: every plugin-resolved `ActiveSkillDescriptor`,
 *     DEDUPED by `name` (first occurrence wins — mirrors
 *     `unionActiveSkills`'s caller-override-precedence rule applied as
 *     plugins fold together).
 *
 * The caller is responsible for the LAST union step: merging
 * `aggregated.resolvedSkills` into its own `activeSkills` via
 * {@link unionActiveSkills} (which retains caller-override-precedence
 * over plugin-resolved entries — see ADR-0339).
 *
 * # NO-THROW + isolation
 *
 * One plugin throwing (the handler is contractually NO-THROW; this is
 * a belt-and-suspenders catch) does NOT abort other plugins. The
 * failing plugin contributes empty arrays.
 *
 * # Empty mentions
 *
 * Empty / all-non-plugin mentions ⇒ `{ handles: [], resolvedSkills: [] }`.
 * Fresh array on every call (no aliasing).
 */

import type { ParsedMention } from "@/agent/mention-injection"
import type { McpServerHandle } from "@/agent/plugin-mcp-launcher"
import type { ActiveSkillDescriptor } from "@/agent/plugin-skill-extension"
import type { ActivationCallOpts, ActivationHandler, AggregatedActivation } from "./types"

/** Filter the closed `MentionKind` enum to plugin-only entries.
 *  Pure. Preserves order. Deduped by `target` (first wins) so a turn
 *  with `plugin://github plugin://github` activates github once. */
const pluginIdsFromMentions = (mentions: readonly ParsedMention[]): readonly string[] => {
  if (mentions.length === 0) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of mentions) {
    if (m.kind !== "plugin") continue
    if (typeof m.target !== "string" || m.target.length === 0) continue
    if (seen.has(m.target)) continue
    seen.add(m.target)
    out.push(m.target)
  }
  return out
}

/** Activate one plugin, swallowing any handler throw. Handler is
 *  contractually NO-THROW; this catch is a defense layer. Returns an
 *  empty-arrays result on failure (matches the handler's own NO-THROW
 *  shape for lookup miss). */
const safeActivateOne = async (
  handler: ActivationHandler,
  pluginId: string,
  opts: ActivationCallOpts | undefined,
): Promise<{
  readonly handles: readonly McpServerHandle[]
  readonly skills: readonly ActiveSkillDescriptor[]
}> => {
  try {
    const result = opts === undefined ? await handler(pluginId) : await handler(pluginId, opts)
    return { handles: result.mcpHandles, skills: result.resolvedSkills }
  } catch {
    return { handles: [], skills: [] }
  }
}

/** Fold one plugin's resolved skills into the aggregate, deduping by
 *  name. Mutates `out` + `seen`. Extracted out of the main loop to
 *  keep cognitive complexity ≤ 15 (biome cap). */
const foldSkills = (
  out: ActiveSkillDescriptor[],
  seen: Set<string>,
  skills: readonly ActiveSkillDescriptor[],
): void => {
  for (const s of skills) {
    if (s === null || s === undefined) continue
    if (typeof s.name !== "string") continue
    if (seen.has(s.name)) continue
    seen.add(s.name)
    out.push(s)
  }
}

/**
 * Activate every plugin mention in the input list. See module docstring
 * for the dedup / order / NO-THROW contract.
 *
 * @param mentions — ADR-0325 parsed mentions for the current turn.
 * @param handler  — closure built by {@link createPluginActivationHandler}.
 * @param opts     — optional `turnId` for skill_activation event
 *                   correlation. Forwarded to the per-plugin handler.
 */
export const activatePluginsFromMentions = async (
  mentions: readonly ParsedMention[],
  handler: ActivationHandler,
  opts?: ActivationCallOpts,
): Promise<AggregatedActivation> => {
  if (!Array.isArray(mentions) || mentions.length === 0) {
    return { handles: [], resolvedSkills: [] }
  }
  const ids = pluginIdsFromMentions(mentions)
  if (ids.length === 0) return { handles: [], resolvedSkills: [] }

  const allHandles: McpServerHandle[] = []
  const allSkills: ActiveSkillDescriptor[] = []
  const seenSkillNames = new Set<string>()

  for (const id of ids) {
    const { handles, skills } = await safeActivateOne(handler, id, opts)
    for (const h of handles) allHandles.push(h)
    foldSkills(allSkills, seenSkillNames, skills)
  }

  return { handles: allHandles, resolvedSkills: allSkills }
}
