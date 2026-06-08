# Ticket 03 — `plugin-session/`: session-scoped enable-state + lifecycle

**Date:** 2026-06-08 · **Wave:** A (independent core) · **Kind:** NEW slice `src/agent/plugin-session/` + EXTEND `src/agent/types.ts` (one slot)
**Gate:** `QUANTA_PLUGIN_MODE` (raw `@/shared` `gateOn`) · default-OFF byte-identical
**Deps:** none. **Feeds:** 04 (routing-preference reads enabled-set), 06 (`/plugins` list/enable/disable surface), 07 (gate + comp-root mints the slot).

---

## Gap

Per `00-index.md` gap #3: activation is **purely `@mention`-driven** and there is **NO enabled-state**. The doc's model (`00-index.md:18-21`) is *"enabled plugins are visible + preferred"* — a plugin that is discovered + enabled should be available to the turn (routing preference, surface listing) **without** the user re-typing `plugin://x` every turn. Today:

- A turn with **zero plugin mentions** activates **zero plugins** — there is no "always-on for enabled plugins" path.
- There is **no registry of enable/disable state**. `/plugins enable github` has nothing to write to, `/plugins list` has no enabled-flag to read, and ticket 04's routing layer has no "currently-enabled set" to prefer over standalone skills.

This ticket builds the missing **session-scoped enable-set + lifecycle hook** as a new pure slice, mirroring the `worktree-slot` closure-handle pattern, minted at the comp-root behind the gate (07 wires; this ticket defines the slot + slice + tests).

## Current (file:line — verified)

| Fact | Evidence |
|---|---|
| Activation returns EMPTY when no mentions ⇒ no always-on | `src/agent/loop-activation-hook.ts:281` `if (mentions.length === 0) return EMPTY` (inside `resolvePluginActivationForTurn`, lines 263-311). Also short-circuits at `:268` (no `activatePlugins`), `:269` (empty user text). |
| Mention→activation fans out per plugin id, **no enable filter** | `src/agent/plugin-activation-handler/composite-activation.ts:47-59` `pluginIdsFromMentions` (filters `kind==="plugin"`, dedupes by target) → `:122-126` loop calls `safeActivateOne` for **every** id. This is the seam a disabled-set must intercept. |
| `PluginRegistryPort` is **stateless** — `lookup`/`list` only | `src/agent/plugin-discovery/types.ts:115-122`. No enable-state, no mutation. |
| In-memory registry adapter (the discovered-set producer) | `src/agent/plugin-discovery/in-memory-registry.ts:23-48` `createInMemoryPluginRegistry(manifests)`; snapshots at construction; `:54` `emptyPluginRegistry`. |
| `discoverPlugins` returns the discovered manifest list | `src/agent/plugin-discovery/discovery.ts:94` `(rootDir, fs): readonly PluginManifest[]`. |
| `enablePlugin` / `disablePlugin` / `pluginSession` / `PluginSession` **grep = 0** in non-test `src/` | verified `grep -rn` → empty. `QUANTA_PLUGIN` grep = 0 in non-test `src/` too. |
| MCP lifetime owned by comp-root's `PluginMcpRegistry`; `shutdownAll()` is teardown | `src/agent/plugin-mcp-launcher/registry.ts:54-74` `shutdownAll` (snapshot → clear → sequential per-handle `shutdown()`, NO-THROW). Port contract: `src/agent/plugin-mcp-launcher/types.ts:69-87`. The loop hook explicitly **does NOT own** this lifetime: `src/agent/loop-activation-hook.ts:24-25, 77-81`. |
| `mcpRegistry` already created per-session in the auto-wire | `src/agent/plugin-activation-handler/auto-wire.ts:138` `createInMemoryPluginMcpRegistry()` — but the handle is **dropped** (local const, never retained for shutdown). 07 must retain it; this ticket's `lifecycle.ts` is where the retained handle's `shutdownAll` is invoked. |
| Precedent: session-scoped closure-handle minted at comp-root | `src/agent/worktree-slot.ts:25-41` `createWorktreeSlot` (closure over private `active`, returns `{current,set,clear,...}`); `:52-58` `mintActiveWorktreeSlot(env, cwd)` = gate-aware factory (`gateOn(env,"QUANTA_WORKTREE_TOOL") ? create : undefined`). |
| Precedent slot on `AgentConfig` | `src/agent/types.ts:854` `activeWorktreeSlot?: import("@/tool").WorktreeSlotHandle` (doc `:844-853`); also `:910` `skillMcpSession?`. The `FeaturesConfig` Pick lists `"activeWorktreeSlot"` at `:2355`. |
| Plugin slot precedent for the activation closure | `src/agent/types.ts:2204-2207` `activatePlugins?` (doc `:2191-2203`: "composition root retains the `PluginMcpRegistry` lifetime and calls `shutdownAll()` on session end"). |
| Gate vocab SSOT | `src/shared/env-flag.ts:73` `gateOn(env,name)`; re-exported `src/shared/index.ts:22-23`. |
| Knob registries are **disjoint** — raw host-gates live in `knob-inventory.ts`, typed runtime-config fields in `runtime-config-knobs.ts` | disjointness asserted by `tests/unit/cli/knob-registry-disjoint-hellgate.test.ts:6-13`. `QUANTA_WORKTREE_TOOL` (raw `gateOn`) is declared in `src/config/knob-inventory.ts:78-85` (`group:"host-gate"`, `home:"runtime-config"`, `readSite:"agent/worktree-slot.ts"`); `QUANTA_SKILL_MCP_DEPS` is in `src/shared/runtime-config-knobs.ts:291` because it is read via `runtimeConfig()`. **`QUANTA_PLUGIN_MODE` is a raw-`gateOn` host-gate ⇒ it belongs in `knob-inventory.ts`, NOT `runtime-config-knobs.ts`.** (07 declares it; this ticket only references it.) |

---

## Design

### Slice: `src/agent/plugin-session/`

A **pure, I/O-free** slice: a closure-handle over the **discovered** manifest set, carrying an in-memory enable-set. Mirrors `worktree-slot.ts` (closure over private state, gate-aware mint) + the `plugin-discovery` slice conventions (closed port type, in-memory adapter, NO-THROW, default-OFF barrel not re-exported from `@/agent`).

#### `types.ts` — `PluginSessionHandle`

```ts
export interface PluginSessionHandle {
  /** The enabled plugin ids, in discovery order, filtered to currently-enabled. */
  enabled(): readonly string[]
  /** True iff `id` is a discovered AND currently-enabled plugin. */
  isEnabled(id: string): boolean
  /** Enable a discovered plugin. NO-THROW; unknown/empty id ⇒ no-op (NOT an error). */
  enable(id: string): void
  /** Disable a plugin. NO-THROW; unknown id ⇒ no-op. */
  disable(id: string): void
  /** The full discovered manifest set (enabled + disabled), discovery order. */
  all(): readonly PluginManifest[]
}
```

Design notes / invariants:
- `PluginManifest` imported from `@/agent/plugin-discovery` (the canonical type — re-exported via that barrel `index.ts:30-32`). **Do not redefine.**
- `enable`/`disable` operate over **discovered** ids only. `enable("does-not-exist")` is a **no-op**, never an error: discovery is the source of truth for *which plugins exist*; the session only tracks *which discovered ones are on*. This keeps the surface (06) able to call `enable(arbitraryUserString)` without a throw path.
- `isEnabled(id)` for an unknown id ⇒ `false` (a non-discovered plugin can never be enabled). For an `enable`d-then-`disable`d id ⇒ `false`.
- `enabled()` returns the **intersection** (discovered ∩ enable-set) in **discovery order** (so 04's routing preference and 06's listing are deterministic). It is derived from `all()` order, not insertion order of `enable()` calls.
- All methods NO-THROW (mirrors `plugin-discovery` types.ts:112-113 NO-THROW contract). Non-string / empty id ⇒ ignored.

#### `session-registry.ts` — `createPluginSession`

```ts
export const createPluginSession = (args: {
  readonly discovered: readonly PluginManifest[]
  readonly initialEnabled?: readonly string[]   // override the default seed
}): PluginSessionHandle
```

- Snapshots `discovered` at construction (mirror `in-memory-registry.ts:28-35` — post-construction mutation of the caller's array must not leak). Build `byId: Map<string, PluginManifest>` (drop entries with non-string / empty `id`, last-write-wins — identical guard to `in-memory-registry.ts:30-34`) + an ordered `discoveredIds: string[]`.
- Private `enabledSet: Set<string>` seeded by the **enable-default** below.
- `enable(id)` / `disable(id)`: trim, guard `byId.has(id)`, mutate `enabledSet`.

##### Enable-default decision (analyzed)

**Recommendation: default-ALL-enabled** when the session is minted (i.e. seed `enabledSet` from every discovered id) **unless** `initialEnabled` is explicitly supplied.

Rationale:
- The doc's model is *"enabled plugins are visible + preferred"* (`00-index.md:18-21`). The slot is **only minted when `QUANTA_PLUGIN_MODE` is on AND at least one plugin is discovered** (see lifecycle/mint below + auto-wire's empty-discovery short-circuit precedent `auto-wire.ts:135`). Turning the gate on is the operator's explicit *"I want plugin host mode"* signal; the natural expectation is that the plugins they placed under `<cwd>/.quanta/plugins` are then *active*, not silently dormant pending a per-plugin `enable`.
- Default-NONE would reproduce gap #3 (nothing on until you mention/enable each one), which is the exact thing this ticket removes.
- `initialEnabled` is the override seam: 06's surface + 07's comp-root can pass a persisted/explicit subset (see persistence) without changing the default. Passing `initialEnabled: []` yields a deliberate all-disabled session.

**Risk acknowledged (see Risks):** default-ALL-enabled means enabling the gate eagerly makes every discovered plugin's skills/MCP *eligible*. This is bounded by (a) the gate being default-OFF, (b) MCP spawn being **lazy** not eager (see lifecycle), and (c) the `enabled()` set being mutable down to `[]` at any time.

#### `lifecycle.ts` — teardown hook to `PluginMcpRegistry.shutdownAll()`

This slice **does NOT own** the MCP registry's lifetime — the comp-root constructs the `PluginMcpRegistry` (`auto-wire.ts:138` today drops it; 07 retains it) and is responsible for calling `shutdownAll()`. This slice only **exposes the hook** so the session-end sequence has one call site:

```ts
export interface PluginSessionLifecycle {
  /** Idempotent NO-THROW session-end teardown. Delegates to the
   *  comp-root-owned PluginMcpRegistry.shutdownAll(). After resolve,
   *  the registry holds no handles. Safe to call when the registry is
   *  absent (gate off / no MCP) — pure no-op. */
  endSession(): Promise<void>
}

export const createPluginSessionLifecycle = (deps: {
  readonly mcpRegistry?: import("@/agent/plugin-mcp-launcher").PluginMcpRegistry
}): PluginSessionLifecycle
```

- `endSession()` ⇒ `await deps.mcpRegistry?.shutdownAll()` wrapped in try/catch (defence — `shutdownAll` is already NO-THROW per `registry.ts:67-72`, but the wrapper guarantees the session-end sequence cannot be broken by a hostile registry injection).
- **The slice imports the `PluginMcpRegistry` *type* only** (and at runtime merely calls a method on an injected object) — it never constructs the registry, never imports the launcher's concrete factory. This keeps the lifetime ownership at the comp-root (matching `loop-activation-hook.ts:24-25`).
- Why a separate lifecycle object (vs. a method on `PluginSessionHandle`)? Separation of concerns: the *enable-set* (pure, no I/O, no async) and the *MCP teardown* (async, owns a foreign handle) have different test surfaces and different fences. Keeping them apart lets `PluginSessionHandle` stay a synchronous pure value object (trivially unit-testable, no async) and lets `lifecycle.ts` be the single place that touches the `@/agent/plugin-mcp-launcher` type.

#### `index.ts` — barrel

Export `createPluginSession`, `createPluginSessionLifecycle`, and the two interface types. **Default-OFF discipline:** this barrel is **NOT** re-exported from `@/agent` (mirror `plugin-discovery/index.ts:6-10` and `plugin-activation-handler` — callers reach the slice via the explicit `@/agent/plugin-session` path from the comp-root only).

Optionally add a gate-aware mint helper mirroring `mintActiveWorktreeSlot` (`worktree-slot.ts:52-58`) — **but** keep the env-read at the comp-root in 07 rather than baking discovery into this slice (this slice is pure; discovery is I/O). Recommended shape (pure, env+discovered in, handle-or-undefined out):

```ts
export const mintPluginSession = (
  env: Readonly<Record<string, string | undefined>>,
  discovered: readonly PluginManifest[],
  initialEnabled?: readonly string[],
): PluginSessionHandle | undefined =>
  gateOn(env, "QUANTA_PLUGIN_MODE") && discovered.length > 0
    ? createPluginSession({ discovered, initialEnabled })
    : undefined
```

This makes the comp-root gate unit-testable without a full session boot (exact `mintActiveWorktreeSlot` precedent). `gateOn` from `@/shared` is the only env touch and is pure.

### Slot: `AgentConfig.pluginSession?` (EXTEND `src/agent/types.ts`)

Add ONE optional slot next to `activeWorktreeSlot` (`types.ts:854`) and the `activatePlugins` slot (`:2204`):

```ts
/** ticket-03 (jun-8 plugin host) — OPTIONAL session-scoped plugin enable-set.
 *  The composition root mints ONE handle per session (over the discovered set)
 *  ONLY when QUANTA_PLUGIN_MODE is on AND ≥1 plugin is discovered (ticket 07
 *  wires the mint). The activation seam (composite-activation) filters mention-
 *  driven AND always-on activation through this set; the /plugins surface
 *  (ticket 06) reads+mutates it; the routing layer (ticket 04) prefers its
 *  enabled() set. Absent ⇒ activation is mention-only AND unfiltered, i.e.
 *  byte-identical to today (default-OFF). Duck-typed via inline import so
 *  @/agent need not eagerly load the slice. */
pluginSession?: import("@/agent/plugin-session").PluginSessionHandle
```

- **Inline `import("...")` type** (not a top-of-file import) — matches `activeWorktreeSlot` (`:854`) and `skillMcpSession` (`:910`); keeps `@/agent/types`'s eager dependency graph unchanged so the default-OFF byte-identity holds at module-load time.
- The MCP-teardown `PluginSessionLifecycle` is **NOT** a new `AgentConfig` slot in this ticket — it is held by the comp-root's session-end sequence (07), constructed from the same `mcpRegistry` the comp-root retains. (Adding it to `AgentConfig` is a 07 decision; this ticket leaves the slot surface minimal.)
- **`FeaturesConfig` Pick:** if 06's surface registration is gated on slot-presence the way worktree tools are (`types.ts:2355` lists `"activeWorktreeSlot"`), 07/06 add `"pluginSession"` to that Pick. This ticket only notes it — the Pick edit belongs to whichever ticket wires the surface.

### How the enable-set is consumed (defines the seam for 04/06/07; not implemented here)

The **red-on-injection invariant** (a disabled plugin MUST NOT contribute skills/MCP) is enforced at the activation fan-out. Today `composite-activation.ts:122` loops over **every** mention-derived id. The consuming tickets (07 wiring) must filter that loop through `cfg.pluginSession?.isEnabled(id)` **before** `safeActivateOne` runs — so a disabled plugin never reaches the launcher (`auto-wire.ts:141-148` handler) and never contributes a handle or a skill. This ticket's tests assert the *handle contract* (`isEnabled` returns false for a disabled id); the wired red-on-injection e2e lives in 07 (it needs the real activation seam). This ticket includes a **slice-level** red-on-injection test (below) that proves the handle cannot report a disabled plugin as enabled.

When the slot is **absent** (`cfg.pluginSession === undefined`), the wiring falls back to today's path: mention-only, unfiltered ⇒ byte-identical.

### Persistence decision (analyzed)

**Recommendation: ephemeral-first (session-scoped, in-memory). Persistence is an explicit follow-up, not in this ticket.**

Surface analysis:
- There is a `<cwd>/.quanta/plugins` **discovery** convention (`auto-wire.ts:130`, `:36-41`) — that directory is the *source of plugins*, not a state file. Writing enabled-state there (e.g. `<cwd>/.quanta/plugins.json`) is a plausible future home.
- There is a `settings.json` surface (`src/config/index.ts:46-50` `PROJECT_SETTINGS_FILE`/`USER_SETTINGS_FILE`; managed-settings `src/config/managed-path.ts:30-37`) which is the established place for *operator config*. A persisted enabled-set could live under a `plugins.enabled` key there.

Why ephemeral-first:
1. **Smallest correct slice.** Enable/disable within a session is the immediate need (gap #3: 04 routing + 06 surface both consume the *current* set). Persistence adds a writer, a file format, a read-on-boot merge, and a conflict policy (managed vs project vs user precedence) — all orthogonal to the enable-set mechanism.
2. **`initialEnabled` is the forward-compat seam.** When persistence lands, the comp-root reads the persisted set and passes it as `initialEnabled` to `createPluginSession` — **no change to this slice**. The default (all-enabled) is the no-persisted-state behavior.
3. **Matches the precedent.** `worktree-slot` is ephemeral session state (`worktree-slot.ts:23-24` "Starts empty"); the MCP registry is in-memory with a noted future ADR for cross-session re-attach (`plugin-mcp-launcher/types.ts:65-68`). Ephemeral-first is the house style for session-scoped holders.

**Follow-up (with why + ROI), per house format:** *persist enabled-state* (feature) so an operator's enable/disable choices survive process restart instead of resetting to all-enabled each boot (why); ROI = medium — needed once a user curates a large plugin set, but until 06's surface exists there is nothing to persist; sequence it after 06. Decision needed at that point: file home (`.quanta/plugins.json` vs `settings.json#plugins`) + precedence merge.

### Default-OFF / byte-identity

- Gate `QUANTA_PLUGIN_MODE` (raw `gateOn`, default-OFF). Gate off ⇒ comp-root (07) does **not** mint the slot ⇒ `cfg.pluginSession === undefined`.
- Gate on but **zero** discovered plugins ⇒ `mintPluginSession` returns `undefined` (the `discovered.length > 0` guard mirrors `auto-wire.ts:135`) ⇒ slot absent ⇒ byte-identical.
- Slot absent ⇒ the activation seam skips the enable-filter (mention-only, unfiltered) ⇒ **byte-identical to today**, including the EMPTY short-circuit at `loop-activation-hook.ts:281`.

---

## Files

**NEW** `src/agent/plugin-session/`
- `index.ts` — barrel (`createPluginSession`, `createPluginSessionLifecycle`, `mintPluginSession`, `PluginSessionHandle`, `PluginSessionLifecycle`). NOT re-exported from `@/agent`.
- `types.ts` — `PluginSessionHandle`, `PluginSessionLifecycle` (closed ports; NO-THROW contract documented).
- `session-registry.ts` — `createPluginSession(...)` + `mintPluginSession(...)`.
- `lifecycle.ts` — `createPluginSessionLifecycle({ mcpRegistry? })`.
- `__tests__/` (or `tests/unit/plugin-session-*.test.ts` per repo convention — match siblings: `plugin-discovery` uses `__tests__/`).

**EXTEND** `src/agent/types.ts`
- Add `pluginSession?: import("@/agent/plugin-session").PluginSessionHandle` (next to `:854` / `:910`), with the doc-comment above.

**Not touched here** (other tickets): `composite-activation.ts` enable-filter wire (07), `auto-wire.ts` registry retention (07), `knob-inventory.ts` `QUANTA_PLUGIN_MODE` declaration (07), `/plugins` surface (06), routing prompt consumption (04), `FeaturesConfig` Pick (06/07).

**tsconfig:** the `@/agent/*` wildcard already covers a new `src/agent/plugin-session/` dir (`00-index.md:9` — new agent sub-slices need no new path). Verify no explicit per-slice path is required (the sibling `plugin-discovery` has none).

---

## TDD — red-first hellgate

Write tests RED first (slice doesn't exist ⇒ import fails ⇒ red), then implement to green. All tests are **pure** (no fs, no spawn) except the lifecycle teardown which uses a fake registry.

1. **enable / disable / isEnabled / enabled-list — core state machine.**
   - `createPluginSession({discovered:[a,b,c], initialEnabled:[]})` ⇒ `enabled()===[]`, `isEnabled("a")===false`.
   - `enable("a")` ⇒ `isEnabled("a")===true`, `enabled()===["a"]`. `disable("a")` ⇒ back to `[]`.
   - `enabled()` returns **discovery order** not enable-call order: discovered `[a,b,c]`, `enable("c"); enable("a")` ⇒ `enabled()===["a","c"]`.
   - `enable`/`disable` idempotent: double-`enable("a")` ⇒ still single entry; `disable` of a not-enabled id ⇒ no-op no-throw.
2. **default-enabled-on-gate (enable-default).**
   - `createPluginSession({discovered:[a,b]})` (no `initialEnabled`) ⇒ `enabled()===["a","b"]` (default-ALL).
   - `mintPluginSession({QUANTA_PLUGIN_MODE:"1"}, [a,b])` ⇒ defined handle with `enabled()===["a","b"]`.
   - `mintPluginSession({/* gate off */}, [a,b])` ⇒ `undefined`.
   - `mintPluginSession({QUANTA_PLUGIN_MODE:"1"}, [])` ⇒ `undefined` (zero-discovery short-circuit).
   - `initialEnabled:["a"]` overrides default ⇒ `enabled()===["a"]` even though `b` discovered.
3. **all() = discovered set, snapshot-isolated.**
   - `all()` returns every discovered manifest (enabled + disabled), discovery order.
   - mutating the caller's `discovered` array after construction does NOT change `all()` (snapshot isolation — mirror `in-memory-registry` test).
   - duplicate-id discovered list ⇒ last-write-wins single entry (mirror `in-memory-registry.ts:30-34`).
4. **shutdownAll called on teardown.**
   - `createPluginSessionLifecycle({mcpRegistry: fake}).endSession()` ⇒ fake's `shutdownAll` called exactly once.
   - absent `mcpRegistry` ⇒ `endSession()` resolves, no throw, no call.
   - `shutdownAll` that **rejects** ⇒ `endSession()` still resolves (NO-THROW wrapper) — assert no rejection escapes.
5. **absent-slot ⇒ mention-only byte-identical (slice-level proof).**
   - A config-like `{pluginSession: undefined}` passed to a tiny filter helper (the predicate the wiring will use: `id => cfg.pluginSession?.isEnabled(id) ?? true`) ⇒ returns `true` for every id (no filtering) ⇒ behavioral equality with no-session. (Full byte-identity e2e through the real activation seam is 07; this asserts the predicate's default.)
6. **red-on-injection — a disabled plugin MUST NOT report enabled / leak into the enabled-set.**
   - INVARIANT: for any sequence of `enable`/`disable`, after `disable("p")` (or never-enabled "p"), `isEnabled("p")===false` AND `"p" ∉ enabled()`.
   - Adversarial: `enable("p"); disable("p")` ⇒ `isEnabled("p")===false`. A test that *asserts the wrong thing* (e.g. expects a disabled id still in `enabled()`) MUST go **red** — i.e. the invariant assertion is the hellgate. Pair with: `enable("not-discovered")` ⇒ `isEnabled("not-discovered")===false` (cannot enable a non-discovered plugin ⇒ it can never contribute skills/MCP through the consuming seam).
   - Hostile inputs: `enable(undefined as any)`, `enable("")`, `enable("   ")`, `isEnabled(123 as any)` ⇒ all no-op / `false`, never throw (NO-THROW contract).

**Audit discipline (`00-index.md:11`):** any "100% / complete" claim ⇒ ≥3 adversarial audits, especially the enable-default reasoning and the red-on-injection seam.

---

## Slice-fence (biome `noRestrictedImports`, AST-enforced)

`plugin-session/` is a **pure leaf** (mirror `plugin-discovery` + `plugin-activation-handler` fences: `plugin-activation-handler/types.ts:19-22`, `loop-activation-hook.ts:31-34`).

**MAY import:**
- `@/agent/plugin-discovery` — `PluginManifest` type only.
- `@/agent/plugin-mcp-launcher` — `PluginMcpRegistry` type only (lifecycle.ts; type + a method-call on the injected object, never the concrete factory).
- `@/shared` — `gateOn` (mint helper).

**MUST NOT import** (the fence, identical wildcard shape to the `registry-surface.ts` precedent `biome.json:1750`):
- `@/agent/loop`, `@/agent/dispatch`, `@/agent/prompt` (acyclic — they import US, never the reverse; this is the same rule the activation slices carry).
- `@/agent/types` (AgentConfig — would be circular: `types.ts` imports the slice's `PluginSessionHandle` via inline type, so the slice MUST NOT import back; mirror `plugin-activation-handler/types.ts:20-22`).
- any surface (`@/apps/**`, `@/runner/**`, `@/host/**`).

Add a `biome.json` override block per NEW file (mirror lines `1741-1750`), e.g.:
```json
{"includes": ["**/src/agent/plugin-session/**"],
 "linter": {"rules": {"style": {"noRestrictedImports": {"level": "error", "options":
   {"patterns": [
     {"group": ["@/agent/loop", "@/agent/loop/**"], "message": "Slice fence: plugin-session must not import @/agent/loop."},
     {"group": ["@/agent/dispatch", "@/agent/dispatch/**"], "message": "Slice fence: plugin-session must not import @/agent/dispatch."},
     {"group": ["@/agent/prompt", "@/agent/prompt/**"], "message": "Slice fence: plugin-session must not import @/agent/prompt."}
   ]}}}}}}
```
(The `@/agent/types` self-edge is naturally prevented by the inline-import-only convention + the circular-import would fail typecheck; add it to the pattern list too if the slice grows.)

---

## Risks

| Risk | Mitigation |
|---|---|
| **Default-enable surprise** — gate on ⇒ every discovered plugin's skills/MCP become eligible without per-plugin opt-in. | Bounded by: (a) gate default-OFF (`QUANTA_PLUGIN_MODE`); (b) slot only minted with ≥1 discovered plugin (`mintPluginSession` guard); (c) `enabled()` is mutable to `[]` at any time via 06's surface; (d) MCP spawn is **lazy** (next row) so default-enabled ≠ default-spawned. The default is explicit + documented in the slot doc-comment. Alternative (default-NONE) reproduces gap #3 — rejected. If the surprise is judged too sharp, 07 can pass `initialEnabled:[]` to make enabling opt-in per-plugin — a one-line comp-root choice, no slice change. |
| **MCP eager-spawn vs lazy.** Default-ALL-enabled must NOT eagerly spawn every plugin's MCP at session start. | This slice does **not** spawn anything — it holds enable-state only. Spawn stays driven by the activation seam (07: a plugin's MCP launches when it is *activated for a turn*, gated by `isEnabled`). Lazy by construction. Eager-spawn would be a 07 anti-pattern; flag it in 07's audit. |
| **Persistence absent** — enable/disable resets to all-enabled each boot. | Accepted for v1 (ephemeral-first, analyzed above). `initialEnabled` is the no-slice-change seam for the persistence follow-up (sequence after 06). |
| **Slot/registry lifetime split** — the enable-set (this slice) and the MCP registry (comp-root) are separate; a leak occurs if 07 retains the session but drops the registry (today `auto-wire.ts:138` drops it). | `lifecycle.ts` makes `shutdownAll` a single explicit call site; 07's session-end test must assert `endSession()` is invoked. This ticket's test #4 proves the hook fires; the wired teardown is 07's responsibility (and 07's audit). |
| **`enabled()` order non-determinism** breaking 04 routing / 06 listing. | `enabled()` is defined as discovery-order intersection (test #1c), not Set-iteration order — deterministic. |

---

## Deps

- **Upstream:** none (wave-A, fully independent core — `00-index.md:65`).
- **Downstream (this slice feeds):** 04 (routing-preference reads `enabled()`), 06 (`/plugins` list/enable/disable mutates the handle), 07 (mints the slot behind `QUANTA_PLUGIN_MODE`, retains the `PluginMcpRegistry`, wires the `isEnabled` filter into `composite-activation`, calls `endSession()` at session end, declares the gate in `knob-inventory.ts`, adds the `FeaturesConfig` Pick entry if surface-gated).
