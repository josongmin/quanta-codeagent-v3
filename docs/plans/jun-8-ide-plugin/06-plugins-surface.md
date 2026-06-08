# Ticket 06 — `/plugins` CLI surface (list · enable · disable · status)

**Date:** 2026-06-08
**Gap:** #4 (surface half) — there is **NO `/plugins` slash command** to list / enable / disable / inspect discovered plugins.
**Kind:** NEW surface (3 files) + EXTEND 4 wiring files.
**Deps:** needs **ticket 03** (`plugin-session/` enable-state + handle, exposed via `runtimeContext`); **feeds ticket 07** (gate `QUANTA_PLUGIN_MODE` + comp-root assembly + default-OFF e2e).
**Discipline:** default-OFF byte-identical · TDD red-first · ≥3R audit · biome slice-fence.

---

## Gap

`grep '"/plugins"' src/` over non-test source = **0** (the only hits are
`discoverPlugins("/plugins", …)` *path-arg* literals in
`src/agent/plugin-discovery/__tests__/discovery.hellgate.test.ts:41-57`, not a slash command).
`QUANTA_PLUGIN*` gate grep = 0 (00-index.md:45, gap #4). So a user who has
plugins discovered under `<cwd>/.quanta/plugins` has **no surface** to see which
are available, which are enabled, what each advertises (shortDescription /
capabilities), or to toggle one for the session. The enable-state itself is the
job of **ticket 03** (`AgentConfig.pluginSession`, 00-index.md:55); this ticket
is its **read/mutate surface**.

The whole jun-8 north-star is *agent-state observability* (what is active / why) —
plugins being active-but-invisible is exactly the anti-pattern. `/plugins` makes
the plugin layer legible and toggleable from the CLI, mirroring the `/model` +
`/effort` interactive-picker UX that already exists.

---

## Current — the EXACT `/model` wiring chain to mirror (file:line, all verified)

`/model` (jun-8 ticket 14) is the freshest, closest template — a session-state
slot read/mutated through a ctx adapter, default-OFF degrading to "not wired".
The full chain, end to end:

1. **Pure core** — `src/apps/cli/slash/model-picker.ts`
   - `formatModelLine(meta, current)` (line 72): renders **one** candidate row —
     a leading `*`/` ` current-marker column, the id `padEnd(20)`, then only the
     metadata segments that are present (graceful degrade), `\n`-terminated.
   - `pickModel(requested, candidates)` (line 108): resolve precedence **exact →
     case-insensitive → throw `UnknownModelError`** (class at line 87, carries
     `requested` + `known[]`). Input `.trim()`ed. Pure, no I/O.
   - Leaf discipline: **type-only** imports (`@/agent`, `@/llm/provider-metadata`).

2. **Command module** — `src/apps/cli/slash/model-cmd.ts`
   - Imports the pure picker (line 29). Header (lines 22-26) states the load-bearing
     rule: *lives in its own `*-cmd.ts` so its picker import is allowed under the
     ADR-0306 fence — the registry brings it in as an opaque `SlashCommand`.*
   - `modelCmd` (line 82): `name:"/model"`, `category:"config"`.
     - `ctx.model === undefined` (line 87) ⇒ `ctx.out("/model: not wired in this surface\n")` + `return 0`. **This is the default-OFF degrade.**
     - `args.length === 0` ⇒ `renderList` (line 35): prints `current()` + each `candidates()` via `formatModelLine` + a `use:` hint.
     - one arg ⇒ `resolveChosen` (line 46, catches `UnknownModelError` → `ctx.err` + `return 1`) → `await model.set(chosen)` → typed outcome handled (`invalid-mode` / `write-error` → `ctx.err`, exit 1).
     - `complete` (line 117): `ctx.model === undefined || args.length >= 1 ? [] : candidates filtered by lower-cased prefix → {value, kind:"argument"}`.

3. **Ctx slot type** — `src/apps/cli/slash-contract.ts:136-151`
   - `readonly model?: { current; candidates; set; effortSupport } | undefined`.
     Inline structural type (no import of the CLI-internal adapter), `| undefined`
     explicit (`exactOptionalPropertyTypes:true`, lines 13-15).

4. **REPL-side adapter** — `src/apps/cli/repl/ctx-adapters/model-adapter.ts`
   - `buildModelAdapter(args)` (line 103) returns `{ current, candidates, set, effortSupport }`.
   - Projects render metadata from the provider-metadata SSOT (`resolveModelWindow`
     line 117, `deriveHint` line 68); `set` writes the **same** `StickyModelStore`
     the loop reads; a per-mode **sync shadow** (line 115) makes an in-surface set
     visible to a sync `current()`.

5. **REPL ctx assembly** — `src/apps/cli/repl/slash-surface.ts`
   - `ReplSlashCtx` (line 55, `Partial<{…}>`) + `BuildReplSlashCtxArgs` (line 158)
     carry the per-slot wires; `buildReplSlashCtx` (line 405) builds them, each
     **presence-gated** (`… !== undefined ? { slot } : {}`) so an absent upstream
     port omits the slot (default-OFF byte-identical).
   - `projectSlashCtx` (line 526) is the **SSOT projector**: `{ ...projectLegacySlots, ...projectAdr0291Slots }`.
   - **Note (verified):** `model` is **NOT** in `projectLegacySlots` / `projectAdr0291Slots`.
     `/model`'s slot is layered **only in surface-compose** (step 6) because the
     model adapter is built from session-setup state, not from `BuildReplSlashCtxArgs`.
     `/plugins` follows the **same surface-compose-layered** route (the
     `plugin-session` handle likewise comes from `runtimeContext`, not the
     pre-built `ReplSlashCtx` args).

6. **Composition root** — `src/apps/cli/repl/surface-compose.ts`
   - `buildModelAdapterWire(args)` (line 203): `stickyStore === undefined ? {} : { modelAdapter: buildModelAdapter({…}) }` — the **default-OFF gate** (absent store ⇒ no adapter).
   - `buildSurfaceDispatch(args)` (line 526) takes `modelAdapter?` (line 572) and
     layers it onto the dispatch ctx: `...(args.modelAdapter !== undefined ? { model: args.modelAdapter } : {})` (line 601), **on top of** `projectReplSlashCtxToContract` (line 590, which delegates to `projectSlashCtx`, line 518).
   - Call site (line 1144): `buildSurfaceDispatch({ …, ...buildModelAdapterWire({ stickyStore: setup.runtimeContext.stickyModelStore(), bootModel, planMode, candidateIds }) })` (lines 1178-1183).

7. **Registration** — `src/apps/cli/slash/registry-surface.ts`
   - Import the opaque cmd: `import { modelCmd } from "./model-cmd"` (line 55).
   - `buildSurfaceSlashCommands(...)` (line 829) lists `modelCmd` (line 882) in the
     surface array; `SURFACE_SLASH_COMMANDS` (line 897) is the exported layer.
   - `slash-commands.ts` concatenates `[...SURFACE_SLASH_COMMANDS, ...SESSION_SLASH_COMMANDS, ...APP_SLASH_COMMANDS]` → `BUILTINS` (header lines 18-20).

8. **Slice-fence** — `biome.json:1750`
   - Override `includes:["**/src/apps/cli/slash/registry-surface.ts"]`,
     `noRestrictedImports` bans `@/agent`, `@/host`, `@/llm`, `@/runner`
     (AST-enforced, **type-import-aware**). So `registry-surface.ts` may bring in
     `modelCmd` as an opaque `SlashCommand`, but may **not** itself import
     `@/agent`. The `*-cmd.ts` module is the escape hatch (it isn't covered by this
     override, so it may import `@/agent` for types). **`/plugins` must obey the
     identical fence.**

### Reference data shapes (verified)

- **Discovery-side manifest** — `src/agent/plugin-discovery/types.ts:86` `PluginManifest`:
  `{ readonly id; readonly name; readonly description?; readonly capabilities: readonly PluginCapability[]; readonly mcpServers?; readonly skills? }`.
  This is the **list-row source** (`id` + `description` + `capabilities`).
- **`PluginRegistryPort`** — same file, line 115: `{ lookup(id): PluginManifest|null; list(): readonly PluginManifest[] }` (NO-THROW). This is the *stateless* discovery registry (00-index.md:30).
- **Capabilities enum** — `src/skill/plugin-manifest.ts:30` `["Interactive","Read","Write"]`.
- **`runtimeContext` seam** — `surface-compose.ts` already reads session-owned
  stores off it (`stickyModelStore()` line 1082, `toolProfileState()` line 1064,
  `identityModeState()` line 1067, `focusChain()` line 1073). **Ticket 03 must add a
  `runtimeContext.pluginSession()` accessor** returning the enable-state handle;
  ticket 06 consumes it exactly like `stickyModelStore()`.

---

## Design

Three NEW files (mirroring `model-picker.ts` + `model-cmd.ts` + `model-adapter.ts`)
plus four EXTEND edits (the slot, the surface-compose wire, the registration, and
— for tab-complete/list — the adapter). All gated by **presence** of the
`plugins` ctx slot, which is present **iff** ticket 03 built a `plugin-session`
handle (gate `QUANTA_PLUGIN_MODE` on AND `<cwd>/.quanta/plugins` non-empty).

### File 1 (NEW) — `src/apps/cli/slash/plugin-picker.ts` (pure core)

Type-only imports (leaf discipline, mirror `model-picker.ts` lines 26-27). Uses
a **local structural row type** so the picker never imports `@/agent` values:

```ts
/** Structural row the picker renders from — projected by the adapter from the
 *  discovery-side PluginManifest. A test can hand-build it. */
export interface PluginLineMeta {
  readonly id: string                              // required
  readonly shortDescription?: string | undefined   // manifest.interface.shortDescription OR manifest.description
  readonly capabilities?: readonly string[] | undefined  // ["Interactive","Read","Write"] subset
}

/** Render ONE row for the no-arg listing. Mirrors formatModelLine EXACTLY:
 *  `*`/` ` enabled-marker column · id.padEnd(N) · only-present segments joined
 *  by ` · ` · `\n`-terminated. Degrade: absent field ⇒ omitted (no placeholder). */
export const formatPluginLine = (meta: PluginLineMeta, enabled: boolean): string

/** Resolve a requested id against the discovered set. Precedence exact →
 *  case-insensitive (returns the CANDIDATE's spelling) → throw UnknownPluginError.
 *  Input .trim()ed. Pure. (mirror pickModel lines 108-116) */
export const pickPlugin = (requested: string, ids: readonly string[]): string

export class UnknownPluginError extends Error {  // mirror UnknownModelError line 87
  readonly requested: string
  readonly known: readonly string[]
}
```

`formatPluginLine` rule of thumb (mirrors `formatModelLine` lines 72-81):
`segments=[]`; push `shortDescription.trim()` if present; push
`caps: ${capabilities.join("/")}` if non-empty; `tail = segments.length ? "  " + segments.join(" · ") : ""`;
`return ` ${enabled?"*":" "} ${id.padEnd(N)}${tail}\n``.

### File 2 (NEW) — `src/apps/cli/slash/plugins-cmd.ts` (command module — the fence escape)

Mirrors `model-cmd.ts`. Header note: *lives in its own `*-cmd.ts` so its
`plugin-picker` import is allowed under the ADR-0306 fence — the registry brings
it in as an opaque `SlashCommand`.* Imports the pure picker + `SlashContext` type.

```ts
type PluginsWire = NonNullable<SlashContext["plugins"]>

const pluginsCmd: SlashCommand = {
  name: "/plugins",
  describe: "List / enable / disable / inspect discovered plugins",
  category: "config",
  async run(args, ctx) {
    if (ctx.plugins === undefined) {            // default-OFF degrade (mirror model-cmd line 87)
      ctx.out("/plugins: not wired in this surface\n")
      return 0
    }
    const p = ctx.plugins
    if (args.length === 0) { renderList(p, ctx.out); return 0 }      // no-arg ⇒ list
    const sub = (args[0] as string).toLowerCase()
    if (sub === "enable"  && args.length === 2) return doEnable(p, args[1], ctx)
    if (sub === "disable" && args.length === 2) return doDisable(p, args[1], ctx)
    if (sub === "status"  && args.length === 2) return doStatus(p, args[1], ctx)
    ctx.err("/plugins: usage = /plugins [enable|disable|status] <id>\n")
    return 1
  },
  complete: (args, partial, ctx) => { … },      // tab-complete (below)
}
export { pluginsCmd }
```

Sub-command bodies (each resolves the id via `pickPlugin`, catching
`UnknownPluginError` → `ctx.err(...)` + `return 1`, mirroring `resolveChosen`
lines 46-62):

- **`renderList(p, out)`** (mirror `renderList` lines 35-42):
  `out("🔌 plugins:\n")`; if `p.list().length === 0` ⇒ `out("/plugins: none discovered\n")`;
  else for each `meta` of `p.list()` ⇒ `out(formatPluginLine(meta, p.isEnabled(meta.id)))`;
  trailing `out("use: /plugins enable|disable|status <id>\n")`.
- **`doEnable(p, raw, ctx)`**: resolve id → `p.enable(id)` (typed outcome: `"ok"`
  | `{kind:"unknown",known}` | `{kind:"error",message}`, mirror `ModelSetOutcome`
  lines 44-47) → `ctx.out("/plugins: enabled <id>\n")` / `ctx.err(...)`+1.
- **`doDisable(p, raw, ctx)`**: symmetric → `p.disable(id)` → `"/plugins: disabled <id>\n"`.
- **`doStatus(p, raw, ctx)`**: resolve id → `out(formatPluginLine(meta, p.isEnabled(id)))`
  + `out("/plugins: <id> is " + (p.isEnabled(id) ? "enabled" : "disabled") + "\n")`.

**Tab-complete** (mirror `model-cmd.ts:117-124`):
```ts
complete: (args, partial, ctx) => {
  if (ctx.plugins === undefined) return []
  const seed = partial.toLowerCase()
  // arg 0 = subverb; arg 1 = plugin id. args EXCLUDES the partial token.
  if (args.length === 0)                       // completing the subverb
    return ["enable","disable","status"].filter(v => v.startsWith(seed)).map(v => ({ value:v, kind:"argument" as const }))
  if (args.length === 1)                        // completing the id
    return ctx.plugins.list().map(m => m.id).filter(id => id.toLowerCase().startsWith(seed)).map(id => ({ value:id, kind:"argument" as const }))
  return []
}
```
(NOTE — matching the `/model` finding: REPL slash-ARGUMENT completion is *not yet
consumed* by the line reader for ANY command; only NAME completion is live. The
`.complete` hook is exercised by a direct-call unit test, same as `/model`’s.
That latent gap is orthogonal to this ticket — see model-cmd-e2e.hellgate.test.ts
lines 274-287.)

### File 3 (NEW) — `src/apps/cli/repl/ctx-adapters/plugins-adapter.ts`

Mirrors `model-adapter.ts`. Adapter over the ticket-03 `plugin-session` handle.
It **may** import `@/agent` for the session-handle type (it is in the
`repl/ctx-adapters/` dir, NOT covered by the registry-surface fence — same as
`model-adapter.ts` which imports `@/agent/sticky-model`).

```ts
export interface PluginsAdapter {
  readonly list: () => readonly PluginLineMeta[]       // discovery list, projected
  readonly isEnabled: (id: string) => boolean          // from the session enable-state
  readonly enable: (id: string) => PluginSetOutcome    // mutate the session handle
  readonly disable: (id: string) => PluginSetOutcome
}
export type PluginSetOutcome =
  | "ok"
  | { readonly kind: "unknown"; readonly known: readonly string[] }
  | { readonly kind: "error"; readonly message: string }

/** Build over the ticket-03 plugin-session handle + the discovery registry. */
export const buildPluginsAdapter = (args: {
  readonly registry: PluginRegistryPort      // @/agent/plugin-discovery — list()/lookup()
  readonly session: PluginSessionHandle       // @/agent/plugin-session (ticket 03): enable/disable/isEnabled/enabledIds
}): PluginsAdapter
```

- `list()` projects each `registry.list()` `PluginManifest` → `PluginLineMeta`
  (`id`, `shortDescription = manifest.interface?.shortDescription ?? manifest.description`,
  `capabilities = manifest.capabilities`). Synchronous — `PluginRegistryPort.list()`
  is sync (types.ts:117), so **no async/sync-shadow gymnastics** are needed
  (simpler than `model-adapter`, which fought the async sticky store).
- `isEnabled(id)` reads the session handle directly (the enable-state is in-memory
  per ticket 03 — sync).
- `enable`/`disable`: validate `id` against `registry.list()` ids (unknown ⇒
  `{kind:"unknown",known}`); else mutate `session` and return `"ok"` (or
  `{kind:"error"}` if the handle reports a failure, e.g. lifecycle spawn error).

### EXTEND 1 — `src/apps/cli/slash-contract.ts` (the slot)

Add, mirroring the `model` slot (lines 136-151), an inline structural type (no
import of the CLI-internal adapter):

```ts
/** jun-8 ticket 06 — `/plugins` surface wire. `list()` = discovered plugins each
 *  with render metadata (id + shortDescription + capabilities); `isEnabled(id)`
 *  reads the session enable-state (ticket 03); `enable/disable(id)` mutate it.
 *  Absent ⇒ `/plugins` prints "not wired in this surface" (byte-identical). */
readonly plugins?:
  | {
      readonly list: () => readonly import("./slash/plugin-picker").PluginLineMeta[]
      readonly isEnabled: (id: string) => boolean
      readonly enable: (id: string) =>
        | "ok" | { readonly kind: "unknown"; readonly known: readonly string[] }
        | { readonly kind: "error"; readonly message: string }
      readonly disable: (id: string) =>
        | "ok" | { readonly kind: "unknown"; readonly known: readonly string[] }
        | { readonly kind: "error"; readonly message: string }
    }
  | undefined
```

### EXTEND 2 — `src/apps/cli/repl/surface-compose.ts` (build + layer the slot)

Mirror `buildModelAdapterWire` (line 203) + the dispatch layering (lines 572, 601, 1178).

1. New `buildPluginsAdapterWire(args)` next to `buildModelAdapterWire`:
   ```ts
   export const buildPluginsAdapterWire = (args: {
     readonly session: PluginSessionHandle | undefined   // setup.runtimeContext.pluginSession()
     readonly registry: PluginRegistryPort | undefined   // discovered registry (ticket 03 also exposes)
   }): { plugins?: SlashContext["plugins"] } => {
     if (args.session === undefined || args.registry === undefined) return {}   // default-OFF gate
     return { plugins: buildPluginsAdapter({ session: args.session, registry: args.registry }) }
   }
   ```
2. `buildSurfaceDispatch` arg type (line 526): add `readonly plugins?: SlashContext["plugins"]` (mirror line 572).
3. In the dispatch ctx assembly (after line 601): `...(args.plugins !== undefined ? { plugins: args.plugins } : {})`.
4. Call site (line 1144 block): `...buildPluginsAdapterWire({ session: setup.runtimeContext.pluginSession(), registry: setup.runtimeContext.pluginRegistry() })`.
   (Ticket 03 supplies `runtimeContext.pluginSession()` + the discovery registry accessor.)

### EXTEND 3 — `src/apps/cli/slash/registry-surface.ts` (registration)

- Add `import { pluginsCmd } from "./plugins-cmd"` next to `import { modelCmd } from "./model-cmd"` (line 55). **Opaque `SlashCommand` only — fence-safe.**
- Add `pluginsCmd` to the `buildSurfaceSlashCommands(...)` array (line 831), adjacent to `modelCmd` (line 882) — e.g. right after `stickyModelCmd` / `modelCmd` in the config cluster.

### EXTEND 4 — (no projection edit needed)

`/plugins`, like `/model`, is **surface-compose-layered** (EXTEND 2), NOT projected
through `projectSlashCtx`. So `slash-surface.ts`’s `projectLegacySlots` /
`projectAdr0291Slots` need **no** change — the slot rides on top of the projector
in `buildSurfaceDispatch` exactly as `model` does (line 601). *(If a future surface
wants `/plugins` via `buildReplSlashCtx` directly, add it there then — see Multi-surface.)*

### Multi-surface note (follow-up, not this ticket)

The slot+adapter pattern is **surface-flexible** (00-index surface-model): the
`SlashContext.plugins` slot is a pure structural contract. An IDE/web surface
(quanta is multi-surface: CLI / Web-Tauri / embedded browser) can wire the **same**
`plugins` slot from its own composition root — build a `PluginsAdapter` over its
`plugin-session` handle and layer it onto its dispatch ctx. **Follow-up (feature:
IDE `/plugins` panel · why: parity of plugin observability across surfaces · ROI:
the contract is already defined here, so the IDE wiring is ~1 adapter + 1 layer,
no new types).** Tracked as a ticket-07 / IDE-surface follow-up; out of scope here.

---

## Files

| Action | Path | What |
|---|---|---|
| **NEW** | `src/apps/cli/slash/plugin-picker.ts` | pure `formatPluginLine` / `pickPlugin` / `UnknownPluginError` + `PluginLineMeta` (mirror model-picker) |
| **NEW** | `src/apps/cli/slash/plugins-cmd.ts` | `pluginsCmd` (no-arg list / enable / disable / status / tab-complete / not-wired degrade) (mirror model-cmd) |
| **NEW** | `src/apps/cli/repl/ctx-adapters/plugins-adapter.ts` | `buildPluginsAdapter` over the ticket-03 session handle + discovery registry (mirror model-adapter) |
| **EXTEND** | `src/apps/cli/slash-contract.ts` | add `plugins?` slot (mirror `model` slot, lines 136-151) |
| **EXTEND** | `src/apps/cli/repl/surface-compose.ts` | `buildPluginsAdapterWire` + `buildSurfaceDispatch` arg/layer + call-site (mirror `buildModelAdapterWire` line 203 / 572 / 601 / 1178) |
| **EXTEND** | `src/apps/cli/slash/registry-surface.ts` | `import { pluginsCmd }` + register in `buildSurfaceSlashCommands` (mirror `modelCmd` line 55 / 882) |

NEW path coverage: `src/apps/cli/**` is already in the app entrypoint tree; no
`tsconfig.base` `paths` entry is needed (these are *not* `@/`-aliased slices).

---

## TDD — red-first hellgate

Test file: `src/apps/cli/__tests__/plugins-cmd-e2e.hellgate.test.ts`, structured
like `model-cmd-e2e.hellgate.test.ts` (a `buildHarness` that injects a fake
`ctx.plugins` slot + records `enable/disable` calls; a direct-invocation suite +
a `runSlashCommand`-driven e2e suite + a drift-guard suite). Plus pure-fn tests in
`plugin-picker.hellgate.test.ts`.

Each case **red before the file exists**, green after:

1. **no-arg list w/ enabled-marker** — seed 3 plugins, 1 enabled. `runSlashCommand("/plugins")`
   ⇒ exit 0; stdout contains all 3 ids + each shortDescription + capabilities; the
   enabled one’s row `.trimStart().startsWith("*")` and is the **only** `*` row
   (`split("\n").filter(startsWith("*")).length === 1`); trailing `use:` hint present.
   (mirror model-cmd test lines 190-207.)
2. **enable mutates session** — `runSlashCommand("/plugins enable foo")` ⇒ exit 0,
   `enableCalls === ["foo"]`, stdout `"enabled foo"`, and a **subsequent** `list()`
   shows `foo`’s row marked `*`.
3. **disable mutates session** — symmetric; `disableCalls === ["foo"]`, row loses `*`.
4. **status** — `runSlashCommand("/plugins status foo")` ⇒ prints the row + `"is enabled"`/`"is disabled"`, exit 0.
5. **invalid id error** — `runSlashCommand("/plugins enable nope")` ⇒ exit 1, stderr
   `"unknown plugin 'nope'"` + known list, `enableCalls === []` (no mutation).
6. **case-insensitive id** — `runSlashCommand("/plugins enable FOO")` ⇒ resolves to
   canonical `foo` (mirror model-cmd line 233-238).
7. **bad usage** — `runSlashCommand("/plugins frobnicate x")` ⇒ exit 1, stderr usage line.
8. **not-wired degrade** — harness with `withPlugins:false` ⇒ `runSlashCommand("/plugins")`
   ⇒ stdout `"/plugins: not wired in this surface"`, exit 0, **stderr empty** (mirror model-cmd lines 258-264). Also `/plugins enable x` with absent slot ⇒ not-wired + exit 0 (never throws).
9. **tab-complete** — direct call: `pluginsCmd.complete?.([], "en", ctx)` ⇒ `["enable"]`;
   `pluginsCmd.complete?.(["enable"], "f", ctx)` ⇒ `["foo"]`; absent slot ⇒ `[]`. Plus
   NAME completion: `slashCompleter("/plug")[0]` contains `"/plugins"` (post-registration, mirror model-cmd line 284-287).
10. **slash drift-guard (registered-once-in-SURFACE)** — mirror model-cmd lines 290-307:
    - `BUILTINS.map(c=>c.name).filter(n=>n==="/plugins").length === 1`;
    - `SURFACE_SLASH_COMMANDS.some(c=>c.name==="/plugins") === true`;
    - the cmd carries `describe` (string) + `run` (fn) + `complete` (fn).
11. **🔴 red-on-injection (the invariant)** — `runSlashCommand("/plugins disable X")`
    then `runSlashCommand("/plugins")` **MUST** show `X` **disabled** (no `*` on its
    row) AND `X`’s row MUST still be listed. A regression that drops the
    disable-write, or that re-marks `X` from the stateless discovery registry instead
    of the session enable-state, turns this **red**. (This is the surface analogue of
    the gap #3 "mention-only, no enabled-state" failure — the surface must read the
    *session* truth, not discovery.)

Pure-fn suite (`plugin-picker.hellgate.test.ts`):
- `formatPluginLine` — present-field row vs metadata-absent row (bare id, no `·`); enabled ⇒ leading `*`.
- `pickPlugin` — exact / case-insensitive (returns candidate spelling) / `UnknownPluginError` with `requested`+`known`.

---

## Slice-fence

- **`registry-surface.ts` MUST NOT import `@/agent`** (biome.json:1750 override,
  AST-enforced, type-import-aware — bans `@/agent`, `@/host`, `@/llm`, `@/runner`).
  The escape, identical to `model-cmd`: `pluginsCmd` lives in its **own
  `plugins-cmd.ts` module** (not covered by the override), and `registry-surface.ts`
  imports it as an **opaque `SlashCommand`**. `plugins-cmd.ts` itself imports only
  `./plugin-picker` (pure) + the `SlashContext` type — **no `@/agent` value import**
  (the discovery/session types reach it through the structural ctx slot only). The
  `@/agent` touch is confined to `plugins-adapter.ts` (in `repl/ctx-adapters/`, NOT
  fenced) and `surface-compose.ts` (the composition root, NOT fenced).
- **`plugin-picker.ts` is a leaf** — type-only imports, no I/O (mirror model-picker).
- Drift-guard test #10 keeps `/plugins` registered **exactly once** and **in the
  SURFACE layer** — a future hand that re-registers it in session/app turns the
  guard red.

---

## Risks

1. **Ticket-03 handle shape drift.** This ticket assumes ticket 03’s
   `plugin-session` handle exposes sync `isEnabled(id)` / `enable(id)` /
   `disable(id)` / enumerable enabled ids, and that `runtimeContext` gains
   `pluginSession()` + a discovery-registry accessor — mirroring how
   `runtimeContext.stickyModelStore()` (surface-compose line 1082) /
   `toolProfileState()` (line 1064) are exposed today. **Mitigation:** the adapter
   (`plugins-adapter.ts`) is the single coupling point; if ticket 03’s handle is
   async, the adapter absorbs it behind a sync facade (the discovery `list()` is
   already sync; only enable-state would need a shadow, simpler than `/model`’s).
   Confirm the handle contract against ticket 03 at impl time.
2. **`shortDescription` source ambiguity.** The discovery-side `PluginManifest`
   (types.ts:86) carries `description?`, while the skill-side zod
   `PluginInterfaceSchema` (plugin-manifest.ts:76) carries `interface.shortDescription`.
   The adapter resolves `shortDescription = manifest.interface?.shortDescription ?? manifest.description`
   so it works whichever the discovery registry surfaces — and `formatPluginLine`
   degrades to a bare id if neither is present.
3. **enable/disable is session-scoped, not persisted.** Per ticket 03 the
   enable-state is in-memory for the session (00-index.md:55). `/plugins enable`
   does NOT write to disk — consistent with the model (00-index.md:21: plugins are
   not direct tools, enable = activate for the session). Document in the cmd help
   so users don’t expect cross-session persistence (orthogonal follow-up if durable
   enable is wanted).
4. **Capabilities are advertise-only.** Per 00-index.md:22 + gap #5, manifest
   capabilities are *advertised*, not enforced here. `/plugins` renders them as
   information; enforcement is ticket 05. Risk = a user reads "Write" and assumes a
   grant. Mitigation: render is purely descriptive; the permission rail (ticket 05)
   remains the admissibility authority — note this in the status output wording if
   space allows.
5. **default-OFF byte-identity.** With the gate off OR `<cwd>/.quanta/plugins`
   empty, ticket 03 builds no `plugin-session` ⇒ `runtimeContext.pluginSession()`
   returns `undefined` ⇒ `buildPluginsAdapterWire` returns `{}` ⇒ slot omitted ⇒
   `/plugins` prints "not wired" + exit 0. **But** the `/plugins` command is in the
   registry **unconditionally** (like `/model`/`/sticky-model`), so `BUILTINS`
   gains one entry even default-OFF. That is the intended parity (the *command*
   always exists; the *capability* is gated by the slot). Ticket 07’s default-OFF
   e2e must assert the registry-membership delta is acceptable (the command is
   inert without the slot) — matching how `/model` already ships.

---

## Deps

- **Upstream — ticket 03 (`plugin-session/`)** — provides the enable-state handle
  + lifecycle, and (this ticket requires) a `runtimeContext.pluginSession()`
  accessor + discovery-registry accessor on the CLI runtime context. **Blocking:**
  `plugins-adapter.ts` + the surface-compose wire cannot be built without it. (wave-B
  in 00-index sequencing — after wave-A ticket 03 is green.)
- **Downstream — ticket 07 (gate + comp-root + e2e)** — owns `QUANTA_PLUGIN_MODE`
  and the default-OFF byte-identity e2e that exercises this surface end-to-end
  (slot present when gate on + plugins discovered; "not wired" otherwise). Ticket 06
  delivers the surface; ticket 07 proves the gate seam.
- **Reuse (no new code):** `@/agent/plugin-discovery` `PluginRegistryPort` +
  `PluginManifest` (types.ts:86/115); `@/skill/plugin-manifest` `Capability` enum
  (line 30). Surface-pattern reuse: `model-picker.ts` / `model-cmd.ts` /
  `model-adapter.ts` (verbatim structural mirror) + the `model` ctx slot / dispatch
  layering (slash-contract.ts:136, surface-compose.ts:203/572/601/1178).
