/**
 * ADR-0340 — Plugin activation trigger handler types.
 *
 * Closed-port surface for the activation handler that wires ADR-0338
 * (`launchPluginMcpServers`) + ADR-0339 (`resolvePluginSkillsForActivation`
 * + `unionActiveSkills`) into a single closure: given a `pluginId`, spawn
 * the plugin's declared MCP servers and resolve its declared skills into
 * `ActiveSkillDescriptor[]`. The caller (composition root / loop hook)
 * decides how to union the resolved skills with caller-side `activeSkills`
 * (via {@link unionActiveSkills}) and how to retain `mcpHandles` for the
 * session shutdown.
 *
 * Slice fence:
 *   - depends on `@/agent/plugin-discovery` (ADR-0336 PluginRegistryPort),
 *     `@/agent/plugin-mcp-launcher` (ADR-0338 launcher port + handle +
 *     registry), `@/agent/plugin-skill-extension` (ADR-0339 types +
 *     SkillActivationEventLike), and `@/agent/mention-injection` (ADR-0325
 *     ParsedMention for composite).
 *   - MUST NOT import `@/agent/loop`, `@/agent/dispatch`, `@/agent/prompt`,
 *     `@/agent/types` (AgentConfig — circular). Composition roots wire the
 *     activation handler onto a typed `AgentConfig.activatePlugins?` slot
 *     declared in `@/agent/types`.
 *
 * Closed-enum design:
 *   - {@link ActivationResult.mcpHandles}    — readonly McpServerHandle[]
 *   - {@link ActivationResult.resolvedSkills} — readonly ActiveSkillDescriptor[]
 *   - Both are NEVER undefined. Empty array ≠ missing field.
 */

import type { PluginRegistryPort } from "@/agent/plugin-discovery"
import type {
  McpLauncherPort,
  McpServerHandle,
  PluginMcpRegistry,
} from "@/agent/plugin-mcp-launcher"
import type {
  ActiveSkillDescriptor,
  SkillActivationEventLike,
} from "@/agent/plugin-skill-extension"
import type { SkillRegistryReadOnly } from "@/skill/registry-readonly"

/**
 * Per-plugin activation result. Always populated — empty arrays signal
 * "no servers declared" / "no skills resolved" rather than failure.
 *
 * Invariants (enforced by {@link createPluginActivationHandler}):
 *   - `pluginId` is the input id, verbatim (NOT renamed from manifest).
 *   - `mcpHandles[]` order matches the launcher's deterministic order
 *     (lexicographic by server name; see ADR-0338 launcher).
 *   - `resolvedSkills[]` order matches the manifest's `skills[]` input
 *     order with registry-miss entries dropped (see ADR-0339).
 */
export interface ActivationResult {
  readonly pluginId: string
  readonly mcpHandles: readonly McpServerHandle[]
  readonly resolvedSkills: readonly ActiveSkillDescriptor[]
}

/**
 * Aggregated activation across multiple plugins (for one turn's worth of
 * `plugin://x` mentions). Skills are DEDUPED by name across plugins;
 * see {@link unionActiveSkills}'s caller-override-precedence rule applied
 * pairwise as plugins are folded together (first plugin wins on collision
 * — semantic mirrors `unionActiveSkills` "existing wins").
 *
 * Handles are NOT deduped — the launcher already guarantees per-plugin
 * idempotency via `(pluginId, serverName)` composition.
 */
export interface AggregatedActivation {
  readonly handles: readonly McpServerHandle[]
  readonly resolvedSkills: readonly ActiveSkillDescriptor[]
}

/**
 * Closed config for {@link createPluginActivationHandler}.
 *
 * Every dep is optional except `pluginRegistry`:
 *   - `pluginRegistry`: required. ADR-0336 read-only lookup.
 *   - `mcpLauncherPort`: optional. Absent ⇒ skip the MCP spawn step
 *     (skills-only activation).
 *   - `mcpRegistry`: optional. Absent ⇒ skip the MCP spawn step too —
 *     the launcher's idempotency contract requires a real registry,
 *     and ownership of the registry's lifetime is the composition
 *     root's call (not the handler's). So a session that wants MCP
 *     spawning MUST supply BOTH port + registry; absence of either
 *     degrades the MCP step to no-op.
 *   - `skillRegistry`: optional. Absent ⇒ skip skill resolution
 *     (MCP-only activation).
 *   - `emit`: optional. Forwarded to {@link resolvePluginSkillsForActivation}.
 *   - `now`: optional. Defaults to `Date.now` (mirrors ADR-0339).
 */
export interface ActivationHandlerConfig {
  readonly pluginRegistry: PluginRegistryPort
  readonly mcpLauncherPort?: McpLauncherPort
  readonly mcpRegistry?: PluginMcpRegistry
  readonly skillRegistry?: SkillRegistryReadOnly
  readonly emit?: (event: SkillActivationEventLike) => void
  readonly now?: () => number
}

/**
 * Per-call options for the activation closure. `turnId` correlates the
 * emitted `skill_activation` events with the surrounding turn (see
 * ADR-0320). Absent ⇒ events are emitted without `turnId`.
 */
export interface ActivationCallOpts {
  readonly turnId?: string
}

/**
 * The activation closure shape. IDEMPOTENT per pluginId: the second call
 * with the same id returns the cached first result (no re-spawn, no
 * re-emit). NO-THROW: any internal failure produces a partial
 * {@link ActivationResult} (empty arrays for failed steps).
 */
export type ActivationHandler = (
  pluginId: string,
  opts?: ActivationCallOpts,
) => Promise<ActivationResult>
