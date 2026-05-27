# ADR-0338 — Plugin-declared MCP server launcher primitive

## Status
Accepted. Slice landed (`src/agent/plugin-mcp-launcher/`) + production
adapter for `@/mcp` `IsolatedMcpClient`. The wiring of an actual
plugin-activation event to `launchPluginMcpServers` is deliberately
deferred (see _Non-goals_) — this ADR ships the primitive only.

## Context

ADR-0039 (`src/skill/plugin-manifest.ts` + `src/skill/plugin-loader.ts`)
already absorbed the Codex plugin layout and parses both files we care
about:

  - `<plugin>/.quanta-plugin/plugin.json` (the manifest, including an
    optional inline `mcpServers` record).
  - `<plugin>/.mcp.json` (sibling MCP server registry, parsed by
    `MCPRootSchema` and merged into `LoadedPlugin.mcpServers`).

What ADR-0039 did NOT close:

  1. There is no primitive that takes a `LoadedPlugin` (or
     `PluginManifest`) and actually _spawns_ the declared MCP servers.
  2. There is no registry that tracks spawned-on-behalf-of-plugin
     handles, so the host cannot perform a tidy shutdown on
     deactivation / session end.
  3. The spawn path (`@/mcp/client` direct `Bun.spawn` or `@/mcp/isolated-client`)
     is wired only at composition-root scope for OS-MCP servers from a
     top-level `.mcp.json` (see `src/apps/cli/internal.ts:480-510`).
     Plugin-supplied servers have no equivalent code path.

The first item — "we already parse `.mcp.json` but nothing launches
what we parsed" — is the gap this ADR closes. The pre-existing task
brief framed (1) as "add `.mcp.json` parser" because it assumed
ADR-0336 had not yet shipped a parser. In fact ADR-0039 ships one. This
ADR therefore concentrates on the launcher + registry primitives and
explicitly notes the parser redundancy below.

### Two plugin manifest systems coexist on main

A subsequent fact-check found ADR-0336 (`src/agent/plugin-discovery/`)
also landed in the R5 close-out sprint. Main therefore carries **two
plugin manifest shapes** in parallel:

- **ADR-0039** (`@/skill/plugin-manifest`): `.quanta-plugin/plugin.json` +
  sibling `.mcp.json`, with `MCPServerSpec` (`{command, args, env?}`)
  wrapped in `Record<string, MCPServerSpec>`. Production loader exists
  (`@/skill/plugin-loader`).
- **ADR-0336** (`@/agent/plugin-discovery`): `.codex-plugin/plugin.json`
  Codex-style manifest with `mcpServers?: readonly {name: string; command?: string}[]`
  (different shape — array of {name, command}, no args / env).

This launcher consumes the **ADR-0039 shape verbatim** (`MCPServerSpec`).
An ADR-0336 manifest cannot feed `launchPluginMcpServers` directly
without an adapter. The two systems are deliberately kept disjoint by
this ADR — picking a unified manifest shape requires a separate decision
ADR (which Codex variant to canonicalise? does Codex's array shape need
`args`/`env`? how does `.mcp.json` sibling vs in-manifest `mcpServers`
differ?). Until that ADR lands, callers that have an ADR-0336
`PluginManifest` and want to launch its declared servers must convert
each entry to `MCPServerSpec` at the call site.

## Decision

Ship a new leaf slice `src/agent/plugin-mcp-launcher/`:

```
src/agent/plugin-mcp-launcher/
  types.ts                    # McpLauncherPort, McpServerHandle, PluginMcpRegistry
  registry.ts                 # createInMemoryPluginMcpRegistry()
  launcher.ts                 # launchPluginMcpServers(manifest, registry, port)
  isolated-launcher-port.ts   # createIsolatedMcpLauncherPort() — production adapter
  index.ts                    # barrel
  __tests__/
    launcher.hellgate.test.ts
    registry.hellgate.test.ts
```

### Closed ports

```ts
interface McpLauncherPort {
  launch(spec: MCPServerSpec, opts: McpLaunchOpts): Promise<McpServerHandle>
}
interface McpServerHandle {
  readonly serverId: string         // `${pluginId}::${serverName}`
  readonly ready: boolean           // false ⇒ launch failed
  readonly error?: string           // present iff ready === false
  shutdown(): Promise<void>         // idempotent NO-THROW
}
interface PluginMcpRegistry {
  track(pluginId: string, handle: McpServerHandle): void
  handlesFor(pluginId: string): readonly McpServerHandle[]
  hasServerId(serverId: string): boolean
  shutdownAll(): Promise<void>
}
```

`MCPServerSpec` is consumed _verbatim_ from `@/skill/plugin-manifest`
(ADR-0039 schema). The launcher does NOT redefine the shape; aliasing
to `PluginMcpServerSpec` in `types.ts` is a local convenience export so
adapter authors do not need to cross the `@/skill` slice in their
type-only imports.

### NO-THROW everywhere

Every public surface in this slice is NO-THROW:

  - `launchPluginMcpServers` catches port exceptions, registry mutation
    exceptions, and adapter-returned wrong serverIds. Failures are
    reported through `ready: false` handles.
  - `createInMemoryPluginMcpRegistry().shutdownAll()` catches per-
    handle shutdown exceptions.
  - `createIsolatedMcpLauncherPort()` wraps every `IsolatedMcpClient`
    construction + `.start()` in try/catch, and performs best-effort
    cleanup on partial-start failures.

A composition root can therefore call `launchPluginMcpServers` from a
hot path (e.g. inside a mention-handler closure) without defensive
try/catch of its own.

### Idempotency

The launcher consults `registry.hasServerId(canonicalId)` before each
spawn. A `(pluginId, serverName)` pair that is already tracked is NOT
respawned — the existing handle is returned instead. This guarantees
that re-firing an activation event for a plugin never produces a
process leak.

### Deterministic launch order

Servers are launched in the **lexicographic order** of their keys
under `mcpServers`. JS object iteration is insertion-ordered, but
`MCPRootSchema` runs over a JSON file whose ordering reflects author
whim; sorting locks test output and makes the readable launch trace
stable.

### Production adapter — `createIsolatedMcpLauncherPort()`

A thin factory that wraps `@/mcp/isolated-client` `IsolatedMcpClient`.
The adapter:

  1. Converts `MCPServerSpec { command, args, env? }` to
     `McpServerConfig { name, command: [command, ...args], env? }`.
     Mirrors the existing pattern at `src/apps/cli/internal.ts:480`
     (`pluginSpecToServerConfig`). Kept private to this slice so we
     don't cross the CLI internals boundary.
  2. Calls `client.start()`, which under the hood invokes the
     `IsolatedProcessSpawnerPort` (default = Bun spawner). The 5 s
     spawn timeout + SIGTERM grace from ADR-0162 apply automatically.
  3. Wraps the live client in a `McpServerHandle` whose `shutdown()`
     calls `client.stop()`. `IsolatedMcpClient.stop()` is already
     idempotent (`if (this.stopped) return`), but we still defend with
     a try/catch in the handle.

Choosing the isolated client (over the legacy `McpClient` in
`@/mcp/client`) for the canonical adapter: plugin-supplied servers are
the highest-uncertainty MCP spawn target (third-party binaries, unsigned
native libs, crash-loops). The isolated client's spawn-timeout / SIGTERM
grace / service-name sanitiser are directly useful here. Hosts that
have already standardised on the legacy client can author a 15-line
`McpLauncherPort` alternative — the slice surface stays open.

## Why not extend `@/skill/plugin-loader` instead

`plugin-loader.ts` is a filesystem read primitive (ADR-0039). Calling
into `@/mcp` from there would invert the dependency direction — the
skill slice is meant to remain spawn-agnostic so it can run in
sandboxed scopes (e.g. tests that read manifests but never spawn).
Keeping the launcher in `@/agent/plugin-mcp-launcher` preserves
plane-clean separation: the agent slice is allowed to consume
`@/mcp` + `@/skill`, but not the reverse.

## Why not auto-wire activation in this ADR

The brief proposed `cfg.pluginActivationHandler?` on `AgentConfig`. We
defer this for two reasons:

  1. The activation _trigger_ has multiple candidate sources — mention
     resolution (`plugin://name`), an explicit `/plugin enable` slash
     command, admin policy preload, restored from session checkpoint.
     Each has subtly different ordering relative to
     `dispatch.ts` and the typed-event store. Picking one without an
     ADR risks an ADR-0327-family-style follow-up cleanup.
  2. The composition-root closure pattern (ADR-0327 et seq.) suggests
     the trigger should live in a wire-install helper, not on
     `AgentConfig` directly. That helper is the natural follow-up
     ADR's deliverable.

The primitive in this ADR is sufficient for a host to wire the trigger
itself in one of `apps/cli/repl/session-setup.ts` or
`apps/web-daemon/runtime-factory.ts` if they want to ship without
waiting for the follow-up.

## Non-goals

  - Re-parsing `.mcp.json`. The shape (`MCPRootSchema`) and the
    sibling-file loader are already in `@/skill/plugin-manifest` /
    `@/skill/plugin-loader` (ADR-0039). The launcher consumes the
    already-parsed `mcpServers` field on the manifest.
  - Validating `.mcp.json` beyond what `MCPRootSchema.strict()`
    already enforces. Stricter checks (e.g. command-on-disk
    existence, env-key whitelisting) belong in a separate review-time
    skill or admin-policy check.
  - Mention → launch event wiring. Deferred to a follow-up ADR.
  - Persistent cross-session registry. The in-memory registry suffices
    for a single REPL session. Cross-session re-attach (resume a
    plugin's MCP server after `/resume <session>`) is a follow-up
    ADR; the port shape is already prepared for it (handles carry a
    stable `serverId`).
  - Hot-swap (`shutdown old + launch new` on plugin manifest change).
    Out of scope; a host that wants this calls `shutdownAll()` then
    `launchPluginMcpServers()` itself.

## Wiring

Composition roots opt in by:

```ts
import {
  createInMemoryPluginMcpRegistry,
  createIsolatedMcpLauncherPort,
  launchPluginMcpServers,
} from "@/agent/plugin-mcp-launcher"

const registry = createInMemoryPluginMcpRegistry()
const port = createIsolatedMcpLauncherPort()

// On plugin activation (trigger is a follow-up ADR):
await launchPluginMcpServers(loadedPlugin.manifest, registry, port)

// On session end:
await registry.shutdownAll()
```

`AgentConfig` is not modified.

## Plane-clean / slice-fence

  - `src/agent/plugin-mcp-launcher/` may import `@/mcp`,
    `@/mcp/isolated-client`, `@/skill/plugin-manifest`, `@/shared`.
  - It MUST NOT import `@/agent/loop`, `@/agent/dispatch`, or any
    other `@/agent/*` slice (plane-clean / ADR-0190).
  - No existing `@/mcp/*` file is mutated; no existing `@/skill/*`
    file is mutated. The slice is purely additive.

## Tests

  - `__tests__/launcher.hellgate.test.ts` — 11 cases covering no
    `mcpServers`, empty object, single + multi server, port-throws,
    per-server isolation, idempotency, wrong-serverId rewrap,
    registry-throws (NO-THROW), shutdownAll-then-relaunch, and
    `composeServerId`.
  - `__tests__/registry.hellgate.test.ts` — 11 cases covering empty
    state, track + handlesFor (insertion order), shutdownAll on
    populated and empty, multi-plugin isolation, duplicate-serverId
    no-op, NO-THROW shutdown with a throwing handle, snapshot
    semantics on `handlesFor`, cross-plugin `hasServerId`.

## Related

  - ADR-0039 — plugin manifest layout (`.quanta-plugin/plugin.json` +
    `.mcp.json`).
  - ADR-0155 / ADR-0160 — MCP Skybridge & microVM impl (the
    larger-scope MCP sandboxing trajectory).
  - ADR-0162 — `@/plugin-isolation` (the spawner port the isolated
    adapter ultimately calls).
  - ADR-0190 — plane-clean / slice-fence policy.
  - ADR-0327 family — composition-wire helpers; this ADR uses the same
    closure-pattern philosophy without occupying an `AgentConfig` slot.
