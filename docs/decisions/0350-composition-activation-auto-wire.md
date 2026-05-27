# ADR-0350 — Composition-root `cfg.activatePlugins` auto-wire

## Status
Accepted. Slice landed: `autoWirePluginActivation` helper +
`apps/agent/assemble.ts` 1-call wire + hellgate.

## Context

ADR-0346 added the loop-side hook (`resolvePluginActivationForTurn` in
`src/agent/loop-activation-hook.ts`) that calls `cfg.activatePlugins?`
once per turn inside `prepareTurnContext`. ADR-0340 declared the slot on
`AgentConfig.activatePlugins?` and ADR-0336/0338/0339 shipped the
underlying primitives (`PluginRegistryPort`, `McpLauncherPort`,
`PluginMcpRegistry`, plugin skill-extension resolver). ADR-0347 wired
the session-keyed resource registry into `assemble.ts`.

But the value gap remained: **no composition root populates
`cfg.activatePlugins`**. The loop hook short-circuits at its first check
because the slot is permanently `undefined`. A host wanting plugin
activation has to hand-build the registry + launcher + handler and
assign the closure itself — boilerplate that ADR-0346 explicitly said
was the composition root's responsibility.

The four ADR-0334 composition roots have differing deps policies (see
ADR-0347 §"Why only assemble.ts?"):

| Root | Auto-wire? | Rationale |
|---|---|---|
| `src/apps/agent/assemble.ts` | **YES** | Rich-deps root; runs in node host with fs access. |
| `src/apps/agent/run.ts` | NO | Belt-and-suspenders + caller-override-precedence covers this transitively. |
| `src/apps/agent/mode-presets/interactive.ts` | NO | Documentary install; idempotent under filled slots. |
| `src/apps/bench/eval/driver.ts` | NO | Empty-deps for replay determinism. Plugin spawn is by definition non-deterministic. |

## Decision

Add `autoWirePluginActivation(cfg, deps?)` to the
`@/agent/plugin-activation-handler` slice. It performs the assembly:

1. Caller-override-precedence: `cfg.activatePlugins` already set ⇒ no-op.
2. Cwd guard: malformed cfg without `cfg.cwd` ⇒ no-op.
3. Discovery: `discoverPlugins(<cwd>/.quanta/plugins, fs)` via an
   injectable `FilesystemPort` (defaults to a sync `node:fs` shim).
4. Empty-discovery short-circuit: zero manifests ⇒ slot stays undefined
   ⇒ loop hook degrades to the legacy byte-identical path.
5. Registry + launcher + handler construction:
   - `pluginRegistry = createInMemoryPluginRegistry(manifests)`
   - `mcpRegistry = createInMemoryPluginMcpRegistry()`
   - `mcpLauncherPort = createIsolatedMcpLauncherPort()`
   - `handler = createPluginActivationHandler({pluginRegistry, mcpLauncherPort, mcpRegistry})`
6. Slot assignment: `cfg.activatePlugins = (mentions, opts) =>
   activatePluginsFromMentions(mentions, handler, opts)`.
7. NO-THROW: every step is wrapped; any failure leaves the slot
   untouched (legacy fallback).

`assemble.ts` calls `autoWirePluginActivation(cfg)` AFTER
`installCodexR2Wires` — a single line. No other composition root is
modified.

### Why `assemble.ts` only?

Mirrors the ADR-0347 wire matrix exactly:

- `run.ts` and `interactive.ts` are idempotent under filled slots
  (ADR-0332). They do NOT need their own auto-wire — assemble already
  ran by the time those see the cfg.
- `bench/eval/driver.ts` intentionally stays empty-deps. Plugin spawn
  is non-deterministic by definition (subprocess scheduling, IsolatedMcp
  client timing) — the bench's byte-identical replay invariant would
  break the first time a plugin handle's `ready: false` race shifted.

### Why omit `skillRegistry` from the auto-assembled handler?

Three reasons:

1. **Async barrier.** Building the production skill registry requires
   `buildSkillBlock(config)` (an async `discoverSkills` + system-skill
   fold). `assemble.ts` is synchronous; making it async would ripple
   through every caller (CLI, web-daemon, bench, every mode preset).
2. **Already covered.** Skills declared on a plugin manifest's `skills`
   array are forwardable but the canonical activation pipeline for a
   host that wants plugin-declared skills is to set `cfg.activatePlugins`
   explicitly with a fully configured handler (caller-override-
   precedence). The auto-wire targets the **default-OFF → MCP-on**
   transition specifically.
3. **Hold the line on slice fence.** The handler's `skillRegistry` slot
   is OPTIONAL; absence is documented as "skip skill resolution". This
   ADR uses that contract as designed instead of inventing a sync
   skill registry adapter that the rest of the codebase would have to
   support.

### Plugin root default

`<cwd>/.quanta/plugins` — workspace-anchored. Matches the convention
noted in `@/agent/plugin-discovery/discovery.ts` (`e.g.
~/.quanta/plugins`) but per-workspace so different repos ship different
plugin sets without colliding. Override via `deps.pluginRoot`.

## Consequences

### Positive

- ADR-0346 hook + ADR-0340 slot become useful in production without any
  per-surface boilerplate. A host that ships a `.quanta/plugins/`
  directory gets per-turn activation automatically.
- ADR-0338 follow-up #3 (`.mcp.json` launch on mention) closes
  transitively — the auto-wired handler invokes the launcher.
- Default-OFF preserved at four layers:
  (a) host pre-sets `cfg.activatePlugins` ⇒ helper is no-op,
  (b) plugin root missing / empty ⇒ slot stays undefined,
  (c) parse / construction error ⇒ slot stays undefined,
  (d) ADR-0346 hook short-circuits when slot is undefined.

### Negative

- Production node hosts touch the fs once per assemble (a `readdirSync`
  on `<cwd>/.quanta/plugins`). Costs one syscall per session start. The
  scanner is BREADTH-1; the cost does not scale with plugin tree depth.
- The `IsolatedMcpClient` is real, so a malformed manifest's
  `command/args` triggers a real `spawn` attempt that fails and yields
  a `ready: false` handle. We judge this acceptable — the handle's
  `error` field carries the spawn error and the rest of the activation
  is unaffected. Tests use a fake `FilesystemPort` so this does not
  fire during the hellgate.

## Non-goals

- **No `prompt.ts` / `loop.ts` mutation.** Both are already wired by
  ADR-0346.
- **No `run.ts` / `interactive.ts` / bench mutation.** Caller-override-
  precedence + empty-deps stay intact.
- **No `AgentConfig` slot mutation.** ADR-0340's `activatePlugins?` is
  the single switch.
- **No skill registry construction.** See "Why omit `skillRegistry`"
  above. Plugin-declared skills remain the host's explicit-wire path.

## Wiring

Composition roots that DO want plugin activation just call
`assembleAgentConfig(req)` as before — the auto-wire fires
transitively. Composition roots that DO NOT want it (test seams,
hermetic e2e) pre-set `cfg.activatePlugins` to a no-op closure or use
the bench driver (which never calls assemble).

## Tests

Hellgate: `tests/unit/composition-activation-auto-wire-hellgate.test.ts`
(12 cases):

1. Caller-override-precedence — pre-set activator preserved.
2. Empty discovery — slot stays undefined.
3. Discovery throw — fs port throwing degrades to empty.
4. Discovery success — slot populated + callable.
5. Closure activation — plugin mention reaches the launcher.
6. Non-plugin mention — skill-only mentions yield empty.
7. Frozen cfg — NO-THROW (slot stays absent).
8. Bench-like cfg (no cwd) — slot stays undefined.
9. Per-call independence — two cfgs get distinct registries.
10. Idempotent — second wire on the same cfg is a no-op.
11. Custom `deps.pluginRoot` — discovery anchored at override.
12. Malformed manifest — silently skipped.

Regression: every ADR-0336 / 0338 / 0339 / 0340 / 0346 / 0347 slice test
stays green.

## Slice fence

- New module: `src/agent/plugin-activation-handler/auto-wire.ts` —
  imports `@/agent/plugin-discovery`, `@/agent/plugin-mcp-launcher`,
  `@/agent/types`, `node:fs`, `node:path`. NO imports of
  `@/agent/loop`, `@/agent/dispatch`, `@/agent/prompt`.
- Barrel update: `@/agent/plugin-activation-handler/index.ts` re-exports
  `autoWirePluginActivation` + `AutoWireDeps`.
- `src/apps/agent/assemble.ts`: +1 import, +1 call (4 lines counting the
  preceding ADR-0350 comment block).
- New test: `tests/unit/composition-activation-auto-wire-hellgate.test.ts`.
- No mutation of `@/agent/loop`, `@/agent/prompt`, `@/agent/types`,
  `@/agent/plugin-discovery`, `@/agent/plugin-mcp-launcher`,
  `@/agent/plugin-activation-handler/{handler,composite-activation,types}`,
  `src/apps/agent/run.ts`, `src/apps/agent/mode-presets/*`,
  `src/apps/bench/eval/driver.ts`.
