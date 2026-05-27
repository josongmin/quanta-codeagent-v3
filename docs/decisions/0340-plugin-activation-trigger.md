# ADR-0340 — Plugin activation trigger handler

## Status
Accepted. Slice landed (`src/agent/plugin-activation-handler/`) + the
matching `AgentConfig.activatePlugins?` slot in `src/agent/types.ts`.
The handler closes the dangling ADR-0338 / ADR-0339 primitives. The
loop-side hook that actually invokes the closure once per turn is
deliberately deferred (see _Wiring_) — `loop.ts` is a user-in-flight
area this sprint and the composition root is the safer surface.

## Context

ADR-0338 shipped `launchPluginMcpServers(manifest, registry, port)` plus
the `McpLauncherPort` + `PluginMcpRegistry` + isolated adapter — a
primitive that, given an ADR-0039 `PluginManifest`, spawns every
declared MCP server.

ADR-0339 shipped `resolvePluginSkillsForActivation(skillNames, cfg,
opts)` plus `unionActiveSkills(existing, pluginResolved)` — primitives
that resolve a plugin's `skills[]` against the read-only skill registry
and merge them into the per-turn active-skill list.

ADR-0336 shipped `PluginRegistryPort.lookup(id) → PluginManifest | null`
— the per-id lookup over discovered plugin manifests.

ADR-0325 / 0330 ship the per-turn mention parser
(`parseMentions(text) → ParsedMention[]`) and a skill-only resolver
(`createMentionInjector`).

**What is still missing:** a single closure that ties these together,
so that a mention like `plugin://github` actually causes (a) the plugin's
MCP servers to spawn and (b) the plugin's declared skills to enter the
active-skill list. Today every primitive is reachable from a composition
root but nothing calls them on a per-turn signal — the seam is dangling.

### Two shape gaps to bridge

1. **MCP server shape.** ADR-0336 `PluginManifest.mcpServers` is
   `readonly { name: string; command?: string }[]`. ADR-0338 launcher
   accepts ADR-0039 `MCPServerSpec` = `{ command: string; args: string[];
   env?: Record<string, string> }` wrapped in a record. The activation
   handler receives the ADR-0336 manifest from `PluginRegistryPort`
   so it must adapt. A follow-up ADR (ADR-0341) will unify the two
   shapes; until then the adapter (`mcp-shape-adapter.ts`) bridges.

2. **Composition root vs. loop.** The closure needs the
   `PluginRegistryPort` + `McpLauncherPort` + `PluginMcpRegistry` +
   `SkillRegistryReadOnly` — all composition-root concerns. Calling it
   on a per-turn signal needs to happen during the agent loop's turn
   prep. The simplest seam is an `AgentConfig.activatePlugins?` function
   slot that the composition root fills and the loop / a surface hook
   may call. This ADR ships the slot; calling it from the loop is a
   follow-up.

## Decision

Ship `src/agent/plugin-activation-handler/` with four exports:

### `adaptMcpServersToSpec(sources)`

Bridges the ADR-0336 `PluginMcpServer[]` shape to ADR-0039
`MCPServerSpec`. Drops entries missing a non-empty `command` (the
launcher needs a real command). Defaults `args` to `[]`. NO-THROW.

This adapter is a TEMPORARY seam. Once ADR-0341 unifies the two shapes
the adapter is RETIRED — the handler will call `port.launch` with the
unified shape directly.

### `createPluginActivationHandler(cfg) → ActivationHandler`

Per-session closure factory. Returns:

```ts
type ActivationHandler = (
  pluginId: string,
  opts?: { turnId?: string },
) => Promise<ActivationResult>

interface ActivationResult {
  readonly pluginId: string
  readonly mcpHandles: readonly McpServerHandle[]
  readonly resolvedSkills: readonly ActiveSkillDescriptor[]
}
```

Closed config:

```ts
interface ActivationHandlerConfig {
  readonly pluginRegistry: PluginRegistryPort           // required (ADR-0336)
  readonly mcpLauncherPort?: McpLauncherPort            // optional (ADR-0338)
  readonly mcpRegistry?: PluginMcpRegistry              // optional (ADR-0338)
  readonly skillRegistry?: SkillRegistryReadOnly        // optional (ADR-0330)
  readonly emit?: (event: SkillActivationEventLike) => void   // optional (ADR-0339)
  readonly now?: () => number
}
```

**Invariants** (asserted by 22 hellgate cases in
`__tests__/handler.hellgate.test.ts`):

1. NO-THROW end-to-end. Every external call wrapped. Lookup miss,
   port throw, skill registry throw, emit throw — all degrade to
   empty arrays.
2. Idempotent per `pluginId`. A `Map<string, ActivationResult>` cache
   in the closure returns the FIRST result on every subsequent call.
   No re-spawn, no re-emit, no re-resolve.
3. Per-step isolation. MCP step failure does NOT abort skill step;
   skill step failure does NOT discard MCP handles.
4. Each absent optional dep degrades the matching step to a no-op
   (mcp absent ⇒ skip MCP, skill registry absent ⇒ skip skills).

### `activatePluginsFromMentions(mentions, handler, opts?) → AggregatedActivation`

Composite over `ParsedMention[]`. Filters to `kind === "plugin"`,
dedupes by target, calls the handler per id, folds the per-plugin
results:

- `handles[]`: concatenated, NOT deduped (the launcher's
  `(pluginId, serverName)` dedupe is sufficient).
- `resolvedSkills[]`: deduped by `name` (first plugin wins on
  collision — mirrors `unionActiveSkills`'s caller-override rule
  applied as plugins fold).

**Caller responsibility:** after `activatePluginsFromMentions`, the
caller MUST union `aggregated.resolvedSkills` into its existing
`activeSkills` via `unionActiveSkills(existing, aggregated.resolvedSkills)`
so caller-side entries retain override precedence over plugin entries
(ADR-0339).

### `AgentConfig.activatePlugins?` slot

Function-shaped slot on `AgentConfig`:

```ts
activatePlugins?: (
  mentions: readonly ParsedMention[],
  opts?: { readonly turnId?: string },
) => Promise<AggregatedActivation>
```

A composition root fills this slot by `cfg.activatePlugins =
(mentions, opts) => activatePluginsFromMentions(mentions, handler,
opts)`. The closure-pattern slot (vs. an exposed
`ActivationHandlerConfig` field on AgentConfig) avoids further
bloating the god-config with port wiring.

## Wiring (composition root)

```ts
// 1. Build the per-session prerequisites.
const pluginRegistry = createInMemoryPluginRegistry(discoveredManifests)
const skillRegistry  = createReadOnlySkillRegistry(skills)
const mcpLauncherPort = createIsolatedMcpLauncherPort(...)
const mcpRegistry    = createInMemoryPluginMcpRegistry()

// 2. Build the handler closure (idempotent cache lives in closure scope).
const handler = createPluginActivationHandler({
  pluginRegistry,
  mcpLauncherPort,
  mcpRegistry,
  skillRegistry,
  emit: (event) => typedHistoryStore.append(event),
})

// 3. Fill the AgentConfig slot. The loop / surface may call
//    cfg.activatePlugins?(mentions, { turnId }) once per turn.
cfg.activatePlugins = (mentions, opts) =>
  activatePluginsFromMentions(mentions, handler, opts)

// 4. On session shutdown:
await mcpRegistry.shutdownAll()
```

A loop-side hook that actually calls `cfg.activatePlugins?(...)` once
per turn is **deferred to a follow-up ADR**. `src/agent/loop.ts` is a
user-in-flight area this sprint; mutating it would risk a merge
hazard. The slot ships now so a composition root can opt in
externally (e.g. by calling the closure on user-input arrival and
splicing the resolved skills into the turn context before `loop.run`).

## Non-goals

- `loop.ts` mutation. Deferred to a follow-up ADR.
- `installCodexR2Wires` extension. The install helper currently fills
  6 slots; adding `activatePlugins` would require new deps on the dep
  bag (pluginRegistry, mcpLauncherPort, mcpRegistry, skillRegistry).
  Slice-fence safety: this ADR does not touch `install.ts`. Either a
  follow-up ADR extends the helper, or composition roots wire the
  closure directly (the recipe above is a single 5-line block).
- ADR-0341 (shape unification). Once landed, `mcp-shape-adapter.ts` is
  retired — the handler calls `port.launch` with the unified shape.
- Skill mention activation. `kind === "skill"` mentions flow through
  ADR-0330 mention-runner; `@@app` mentions are a future ADR. Only
  `kind === "plugin"` triggers MCP spawn + skill set extension.
- Plugin deactivation. The handler does not own `mcpRegistry`
  lifetime — the composition root calls `mcpRegistry.shutdownAll()`
  on session end (ADR-0338).

## Invariants enforced by tests

- `mcp-shape-adapter.hellgate` — 13 cases — adapter purity + NO-THROW
  + drop-missing-command + args=[] + fresh-array.
- `handler.hellgate` — 21 cases — NO-THROW + idempotent cache + per-
  step isolation + absent-dep degradation + emit forwarding + turnId
  propagation + ADR-0336 array shape acceptance + clock injection.
- `composite-activation.hellgate` — 13 cases — plugin-only filtering
  + dedup by target + handler-throw isolation + skill cross-plugin
  dedup + mention/handler order preservation + non-array input
  degradation.

Total: ≥ 47 hellgate cases across 3 files.

## Slice fence

`src/agent/plugin-activation-handler/` MAY import:
- `@/agent/plugin-discovery` (ADR-0336 PluginRegistryPort + types)
- `@/agent/plugin-mcp-launcher` (ADR-0338 launcher port + registry)
- `@/agent/plugin-skill-extension` (ADR-0339 resolver + types)
- `@/agent/mention-injection` (ADR-0325 ParsedMention type)
- `@/skill/plugin-manifest` (ADR-0039 MCPServerSpec type)
- `@/skill/registry-readonly` (ADR-0330 read-only port)

It MUST NOT import `@/agent/loop`, `@/agent/dispatch`, `@/agent/prompt`,
or `@/agent/types` (would create a circular dependency through
AgentConfig — the slot in `@/agent/types` uses a lazy `import(...)`
type reference back to this slice, but this slice resolves the slot
only through the AgentConfig facade at the composition root).
