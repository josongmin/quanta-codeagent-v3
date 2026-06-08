# Ticket 07 — `QUANTA_PLUGIN_MODE` gate + **shared-assembler** mode composition (all surfaces) + default-OFF e2e

**Plan:** jun-8 Plugin (host) mode — see [`00-index.md`](./00-index.md) for the model + discipline.
**Gap (00-index):** #4 (표면/knob 0 — `/plugins`·`QUANTA_PLUGIN` grep=0) **and** #6 (partial-flavor: `autoWirePluginActivation` is already CALLED at `agent-config-assembler.ts:799` but with `skillRegistry` + session-state deliberately omitted, so it is a no-skill, no-enable-state stub).
**Kind:** knob + **shared-assembler** integration. **Deps:** 02, 03, 04, 05 (this is wave-C, the keystone — it consumes every wave-A/B core seam). **Feeds:** 08 (web/IDE `/plugins` UX rides the core this ticket lights up). **Discipline:** default-OFF byte-identical; TDD red-first with red-on-injection; slice-fence; ≥3R adversarial audit before any claim-100.

This is the **integration ticket**. It owns NO new mechanism — it owns the **wiring decision**: a single knob, **one mint at the SHARED config chokepoint** (`agent-config-assembler.ts`, where every surface — CLI, web-daemon, IDE, and every other mode preset — passes through), the assembly order over tickets 01–05, the lifecycle teardown, and the headline deliverable — the **default-OFF byte-identity matrix** proving every seam is untouched, on EVERY surface, when the gate is off.

> **⚠️ Mint-location correction (vs. an earlier draft of this ticket).** An earlier draft minted `plugin-session` at the **CLI comp-root** (`src/apps/cli/repl/runtime-context-compose.ts`) and threaded it through the `RuntimeBootstrapOverlay → AgentConfig` lift (`context-binding.ts`). That is **WRONG for a cross-surface feature**: the CLI comp-root is reached ONLY by the CLI surface, so web-daemon + IDE + all other mode presets would get plugin mode **dark** (no skills, no MCP, no routing, no capability rail). The correct site is the **shared assembler** `assembleAgentConfig` — the single chokepoint ALL surfaces traverse (00-index §표면 토폴로지, lines 60-66). The mint is now in this assembler, exactly where `autoWirePluginActivation(cfg)` already runs (`agent-config-assembler.ts:799`) — which already lives there *precisely because* it must cover all surfaces. This draft is corrected throughout.

---

## Gap

Five core tickets (01–05) build the plugin-host mechanism, but each lands its slice **default-OFF and unwired at the surface**:

- 01 adds a `plugin` skill source to `skill/registry.ts` (`defaultSkillSources`), but nothing turns it on.
- 02 EXTENDS `autoWirePluginActivation` (exported at `plugin-activation-handler/auto-wire.ts:121`, already `(cfg, deps: AutoWireDeps = {})`) to accept an injected `skillRegistry` + a session — but the assembler still calls the zero-arg form (`agent-config-assembler.ts:799` `autoWirePluginActivation(cfg)`), and `auto-wire.ts:145` today omits `skillRegistry` ("intentionally omitted — see module docstring §Defaults"), so plugin skills never surface.
- 03 mints a `plugin-session/` (enable-state + `PluginMcpRegistry` lifetime) — but it is `NOT YET CREATED` and nobody constructs it.
- 04 builds a `plugin-routing/` preference block the prompt can consume — but the prompt only renders it if a session is threaded.
- 05 builds a `plugin-capability-policy.ts` dispatch gate — but dispatch only consults it if the policy is threaded.

(06 builds the **CLI** `/plugins` slash surface — a parallel wave-B item, NOT a dep of 07: it surfaces enable/disable UX over the SAME core this ticket mints, but the core lights up on all surfaces here regardless of whether 06 has landed. 08 is the web/IDE counterpart UX, and it depends on 07.)

**No `QUANTA_PLUGIN_MODE` knob exists** (verified: `grep -rn "QUANTA_PLUGIN_MODE" src` = 0; the only `QUANTA_PLUGIN*`-adjacent inventory entry is unrelated). **No surface mints a `plugin-session`.** So even with 01–05 merged, plugin-host mode is dead code on every surface. Ticket 07 introduces the gate, mints the session **at the shared assembler so all surfaces inherit it in ONE place**, threads it onto `AgentConfig.pluginSession`, and proves the default-OFF byte-identity end-to-end on every surface.

---

## Why the shared assembler, not the CLI comp-root

This is the load-bearing topology fact for this ticket (verified file:line).

**The single shared config chokepoint is `assembleAgentConfig`** (`src/host/runtime/agent-config-assembler.ts:654` — *"Single source of truth for 'config for this mode' assembly"*). `src/apps/agent/assemble.ts:39` is a thin `assembleAgentConfigWithEnv` wrapper (binds `process.env`; *"The actual `ModePolicy → AgentConfig` wiring now lives BELOW `src/apps/**`"* — `assemble.ts:4-8`). **ALL surfaces pass through `assembleAgentConfig`:**

- **CLI** → `@/host/runtime` (`runtime-context-compose` → sdk/runtime → host/runtime) → `assembleAgentConfig`.
- **web-daemon** → `src/apps/web-daemon/runtime-factory.ts:130-131` — `buildInteractiveTurnAssembler` delegates to `buildSharedInteractiveTurnAssembler` (imported `from "@/host/runtime"`, `:27`), whose per-turn closure calls `assembleAgentConfig({ mode: "interactive", … })` (`agent-config-assembler.ts:819`).
- **IDE** — **`src/apps/agent/mode-presets/ide.ts`** is a **MODE PRESET, not a separate app**. It imports `assembleAgentConfig` from `../assemble` (`ide.ts:58-63`) and calls it in `runMode` (`ide.ts:117` `const cfg = assembleAgentConfig({ ...req, base })`).
- **headless / batch / ci-bot / daemon** presets likewise reach `assembleAgentConfig` via `../assemble`.

**This is exactly why `autoWirePluginActivation(cfg)` already lives at `agent-config-assembler.ts:799`** — it must cover all surfaces, so it sits at the one place they all traverse. Minting `plugin-session` here means plugin skills + MCP + routing + capability rail light up on **CLI, web-daemon, IDE, and every other preset in ONE edit** (00-index lines 66, 95-96). Minting at the CLI comp-root would leave every non-CLI surface dark — a cross-surface feature wired into a single-surface root is the canonical partial-wire failure (Risk R1).

**Contrast — the CLI comp-root IS the right home for CLI-ONLY slots.** `src/apps/cli/repl/runtime-context-compose.ts` mints session slots that are intentionally CLI-surface-scoped:

- **worktree** (ticket-11): `mintActiveWorktreeSlot(args.envSource ?? process.env, boot.cwd)` at `runtime-context-compose.ts:273`, gated on `QUANTA_WORKTREE_TOOL` — a CLI interactive-loop affordance.
- **model adapter** (ticket-14): a CLI-only adapter slot at the same comp-root.

Those belong at the CLI comp-root because they are reached only by — and only meaningful for — the CLI surface. The contrast is the whole point: **CLI-only ⇒ CLI comp-root; cross-surface ⇒ shared assembler.** `plugin-session` is cross-surface (the 00-index surface model gates plugin core ON for CLI+web+IDE alike), so it mints at the assembler, NOT alongside the worktree/model-adapter slots.

---

## Current (file:line — the patterns this ticket reuses verbatim)

### 1. The knob convention (a gate read at assembly, NOT a typed `runtime-config` field)

The closest precedent is **`QUANTA_WORKTREE_TOOL`** (ticket-11), which is the SAME shape this ticket needs: a boolean gate, read via `gateOn`, that mints a session slot — NOT a value consumed via `runtimeConfig().field`.

- It is read **directly** by `gateOn`, not in `runtime-config.ts`. The mint helper lives in a library slice so it is unit-testable without crossing the `@/apps/cli` fence:
  - `src/agent/worktree-slot.ts:52` — `mintActiveWorktreeSlot(envSource, bootCwd)`:
    ```ts
    gateOn(envSource, "QUANTA_WORKTREE_TOOL")
      ? createWorktreeSlot({ repoRoot: bootCwd, sessionCwd: bootCwd })
      : undefined
    ```
    (imports `gateOn` from `@/shared`, `worktree-slot.ts:20`).
- Because it is a `gateOn` read (not a `runtimeConfig()` field), it is **NOT** in `runtime-config.ts` / `runtime-config-knobs.ts`. It IS registered in the daemon/host inventory:
  - `src/config/knob-inventory.ts:78-85` — `{ envKey: "QUANTA_WORKTREE_TOOL", kind: "bool", default: false, group: "host-gate", home: "runtime-config", describe: "Agent worktree tools …", readSite: "agent/worktree-slot.ts" }`.

  Note the contrast that proves the topology point: the worktree knob's `readSite` is `agent/worktree-slot.ts`, a CLI-comp-root helper — because worktree IS CLI-only. The plugin knob's read, by contrast, lands at the **shared assembler** path (its mint helper is called from `agent-config-assembler.ts`), because plugin core is cross-surface.

**Decision (mirror the knob-home, NOT the read-location):** `QUANTA_PLUGIN_MODE` is a `gateOn` gate. It is registered in `knob-inventory.ts` (group `host-gate`, home `runtime-config`, `readSite: "agent/plugin-session/mint.ts"` — ticket 03's mint helper, which the SHARED assembler calls; see §B). It is **NOT** a `runtime-config.ts` field and **NOT** a `runtime-config-knobs.ts` entry — those are for values consumed via `runtimeConfig().field`, which this is not. (The §10 convention line "신규 knob → `runtime-config-knobs.ts` declare + `runtime-config.ts` 필드+read" is for *typed value* knobs; `QUANTA_WORKTREE_TOOL` establishes the gate carve-out, and this knob follows that precedent. See **Risk R5** for why we do NOT also add a `runtime-config` field.)

### 2. The shared-assembler mint site (the mode composition)

`src/host/runtime/agent-config-assembler.ts` — `assembleAgentConfig(req, env)` at `:654`. This is the SSOT chokepoint (see §Why the shared assembler). The assembler already owns the surface-pure `env: AssemblerEnv` view (header: *"`env` is the surface-owned env view … this module never reads the `process.env` global"*, `:651-653`) — so the gate read happens HERE, against the surface's own env, with NO comp-root overlay/lift round-trip.

The assembler already runs a workspace-anchored plugin step at the tail: `autoWirePluginActivation(cfg)` (`:799`, docstring `:791-798`). The plugin discovery it performs is **synchronous** — `discoverPlugins(root, fs)` over a **sync `FilesystemPort`** (`auto-wire.ts:53` `import { readdirSync, readFileSync } from "node:fs"`; the default port's `readDir`/`readFile` are sync, `auto-wire.ts:85-96`; the port contract is sync, `auto-wire.ts:82` *"Sync to match the `FilesystemPort` contract"*). **Confirmed: the discovery used at `:799` is sync, so the 07 mint stays sync** — `assembleAgentConfig` is a synchronous function (`:654`, returns `AgentConfig` not `Promise<AgentConfig>`), and the mint must NOT make it async. It reuses the SAME sync node-fs `FilesystemPort` the auto-wire already uses.

The mint is a non-empty-guarded gate exactly like the auto-wire's empty-discovery short-circuit (`auto-wire.ts:135` `if (manifests.length === 0) return`), composed with the `QUANTA_PLUGIN_MODE` gate.

### 3. The AgentConfig surface (where the session lands)

The mint threads `cfg.pluginSession` directly on the assembled `AgentConfig` — NO `RuntimeBootstrapOverlay` / `context-binding.ts` lift is involved (that lift is the CLI comp-root's overlay path, which this ticket no longer uses for plugin-session). The slot sits adjacent to `activatePlugins` (`types.ts:2204`), whose docstring (`:2191-2199`) ALREADY states the lifetime contract: *"the composition root retains the `PluginMcpRegistry` lifetime and calls `shutdownAll()` on session end."* For the plugin feature, the assembler IS that composition root for all surfaces.

### 4. The assembler seam already half-wired (gap #6)

`src/host/runtime/agent-config-assembler.ts:799`:
```ts
autoWirePluginActivation(cfg)
```
docstring `:791-798`. Today this builds its OWN registries internally with `skillRegistry` omitted (`auto-wire.ts:137-148`: `createInMemoryPluginRegistry(manifests)` + `createInMemoryPluginMcpRegistry()` + `createIsolatedMcpLauncherPort()`, then `createPluginActivationHandler({ … // skillRegistry intentionally omitted })`, `auto-wire.ts:145`). Caller-override-precedence: `if (cfg.activatePlugins !== undefined) return` (`auto-wire.ts:124`). The `AgentConfig.activatePlugins` field is declared at `types.ts:2204-2207`.

**Decision:** at `:799`, the assembler mints the FULL-deps session when `QUANTA_PLUGIN_MODE` is on and `.quanta/plugins` is non-empty, threading `cfg.pluginSession` + injecting the session's pre-built `skillRegistry`/`pluginRegistry`/`mcpRegistry` into the activation handler (the delta vs. today's omit). Ticket 02 EXTENDS `autoWirePluginActivation` to accept the injected `{ session }`; 07 owns the gate + mint + thread at this single call site. Absent gate / empty plugins ⇒ the auto-wire falls back to today's no-skill stub path, which is byte-identical-to-legacy (empty-discovery short-circuit). **Key invariant: 07 changes WHO builds the registries (the assembler, with full deps + skillRegistry) — it does not change the assembler's short-circuit shape, and it stays synchronous.**

### 5. The lifecycle hook (ticket 03 contract, already documented)

`src/agent/plugin-mcp-launcher/index.ts:12` — *"On session shutdown: `await registry.shutdownAll()`"*; the registry exposes `shutdownAll(): Promise<void>` (`plugin-mcp-launcher/types.ts:86`). The assembler retains the `PluginMcpRegistry` handle on the minted `cfg.pluginSession`; the session-teardown path (the same dispose/abort sink that disposes other session resources) calls `shutdownAll()` on session end. Because the session now hangs off `AgentConfig`, every surface's teardown reaches it uniformly via `cfg.pluginSession`.

### 6. The knob ratchet

`tests/unit/knob-registry-completeness-ratchet-hellgate.test.ts` (`ORPHAN_CEILING = 0`, `:182`). A new `gateOn(env, "QUANTA_PLUGIN_MODE")` read in `src/` is an orphan UNLESS declared in a registry file (`isDeclarationFile`, `:56-64`: `runtime-config.ts` / `runner/knobs/` / `apps/cli/cli-knobs.ts` / `config/knob-inventory.ts` / `runtime-config-knobs.ts`). The ratchet keys on the **read-site**, so registering `QUANTA_PLUGIN_MODE` in `knob-inventory.ts` keeps the ceiling at 0 regardless of whether the read lands in the assembler or the mint helper.

---

## Design

### A. The knob: `QUANTA_PLUGIN_MODE`

- **Vocab:** `gateOn(env, "QUANTA_PLUGIN_MODE")` — the loose truthy vocab (`1`/`true`/`on`, case-insensitive) per `@/shared` SSOT, identical to `QUANTA_WORKTREE_TOOL`. (NOT `gateOnStrict` — this is a feature gate, not a security gate. Compare: code-mode uses `gateOnStrict` because it registers a sandbox-escape tool; plugin-mode's security boundary is the per-plugin isolation + permission rail, which ticket 05's capability-policy enforces independently of this knob's vocab.)
- **Read site:** ticket 03's mint helper — `src/agent/plugin-session/mint.ts` (a library slice, mirroring `worktree-slot.ts`), so the gate is unit-testable without a CLI boot.
- **Registry:** `src/config/knob-inventory.ts`, appended to the `HOST` array:
  ```ts
  {
    envKey: "QUANTA_PLUGIN_MODE",
    kind: "bool",
    default: false,
    group: "host-gate",
    home: "runtime-config",
    describe: "Plugin-host mode — enable discovered <cwd>/.quanta/plugins bundles (skills + MCP + routing) on ALL surfaces. Minted at the shared assembler; needs a non-empty plugins dir (ticket 07).",
    readSite: "agent/plugin-session/mint.ts",
  },
  ```
  (`readSite` names the mint helper the shared `agent-config-assembler.ts` calls at `:799`; the ratchet keys on the read-site declaration, not on which surface reaches it — §Current/6.)
- **NOT added** to `runtime-config.ts` / `runtime-config-knobs.ts` (it is a `gateOn` gate read at assembly, not a `runtimeConfig()` value — see Risk R5).

### B. The shared-assembler mint (the mode composition)

A new library helper, `src/agent/plugin-session/mint.ts` (ticket 03 owns the `PluginSession` type + `mintPluginSession`; 07 owns CALLING it from the SHARED assembler). It mirrors `mintActiveWorktreeSlot` — but it stays **synchronous** (the discovery it performs is sync, see §Current/2) and returns the assembled session. It MUST NOT be async: `assembleAgentConfig` is synchronous (`agent-config-assembler.ts:654`), and making the mint async would force the whole shared assembler async, rippling into every surface's call site. The sync `FilesystemPort` (the SAME node-fs shim `auto-wire.ts:85-96` uses) makes this trivially sync.

```ts
// ticket 03 defines; ticket 07 calls from the shared assembler.
export const mintPluginSession = (args: {
  readonly env: Readonly<Record<string, string | undefined>>  // the AssemblerEnv view
  readonly cwd: string                  // cfg.cwd — the assembled session's cwd
  readonly skillRegistry: SkillRegistry // ticket 01/02 — the session's skill registry
  readonly fs?: FilesystemPort          // defaults to the sync node-fs shim
}): PluginSession | undefined
```

**Mint predicate (the TWO-condition gate, per 00-index discipline line 7):**

```
gateOn(env, "QUANTA_PLUGIN_MODE")  AND  discoverPlugins(<cwd>/.quanta/plugins).length > 0
  ⇒ build PluginSession
otherwise ⇒ undefined
```

i.e. **gate off OR no plugins ⇒ `undefined` ⇒ everything short-circuits ⇒ byte-identical.** This composes the `QUANTA_PLUGIN_MODE` gate with the auto-wire's existing empty-discovery short-circuit (`auto-wire.ts:135` `if (manifests.length === 0) return`) — both already present in the assembler's plugin step.

When BOTH hold, `mintPluginSession` assembles (consuming the wave-A/B seams):

| Step | Seam consumed | What is built |
|---|---|---|
| 1 | **03** | `pluginRegistry = createInMemoryPluginRegistry(manifests)` (discovery, `plugin-discovery/in-memory-registry.ts:23`) — the enable-state store wraps this with `enable`/`disable`/`isEnabled` (ticket 03's delta over the stateless `lookup`/`list`). |
| 2 | **03** | `mcpRegistry = createInMemoryPluginMcpRegistry()` + `mcpLauncherPort = createIsolatedMcpLauncherPort()` (`plugin-mcp-launcher`) — the registry whose lifetime the assembler retains on `cfg.pluginSession` (step 6's `shutdownAll`). |
| 3 | **01 + 02** | the `skillRegistry` passed in — which (01) now includes the `plugin` source in `defaultSkillSources` and (02) is the SAME registry the full-deps activation handler binds, so `<plugin>:<skill>` resolves. |
| 4 | **02** | the full-deps activation handler: `createPluginActivationHandler({ pluginRegistry, mcpLauncherPort, mcpRegistry, skillRegistry })` — **with `skillRegistry` injected** (the delta vs. today's omit at `auto-wire.ts:145`). |
| 5 | **04** | `routingBlock = buildPluginRoutingBlock(pluginRegistry-enabled-view)` — the routing-preference block the prompt renders ("관련 plugin 있으면 우선"). |
| 6 | **05** | `capabilityPolicy = buildPluginCapabilityPolicy(manifests)` — the capability→permission gate dispatch consults. |
| 7 | **03** | the enable-state store + status view (the `/plugins` UX — CLI ticket 06, web/IDE ticket 08 — lists over this; the store itself is core, minted here, so the UX is purely surface-rendering). |

`PluginSession` is the bundle of {enabled-state store, activation handler, routing block, capability policy, mcpRegistry (for teardown), status view}.

### C. The full assembly order (who builds what, in sequence — at the SHARED assembler)

```
assembleAgentConfig(req, env)   ── the SSOT chokepoint ALL surfaces traverse
  1. cfg assembled (existing)                              ── modePolicy, budget, …
  2. skillRegistry resolved (existing host path)           ── 01 adds plugin source
  3. at the :799 plugin step, 07 mints (replacing the bare zero-arg auto-wire):
       session = mintPluginSession({                       ── 07 NEW (sync)
         env, cwd: cfg.cwd, skillRegistry })               ── 03 mints, 02/04/05 assemble
       └ gate off OR no plugins ⇒ undefined
  4. thread + activate:
       if (session !== undefined) {
         cfg.pluginSession = session                       ── 07 (cross-surface AgentConfig slot)
         autoWirePluginActivation(cfg, { session })        ── 02 EXTEND (injects skillRegistry)
       } else {
         autoWirePluginActivation(cfg)                     ── today's stub path, UNCHANGED
       }
  5. per-turn (any surface's loop):
       - loop-activation-hook calls cfg.activatePlugins(mentions)  ── existing (02 deps richer)
       - prompt renders cfg.pluginSession?.routingBlock            ── 04
       - dispatch consults cfg.pluginSession?.capabilityPolicy     ── 05
       - /plugins (CLI 06 / web-IDE 08) lists cfg.pluginSession view
  6. session end: await cfg.pluginSession?.mcpRegistry.shutdownAll()  ── 07 lifecycle (03 contract)
```

Because steps 3-4 happen INSIDE `assembleAgentConfig`, CLI + web-daemon + IDE + every other preset get the session with NO per-surface edit — that is the whole reason the mint moved here.

**Load-bearing ordering constraints:**
- skillRegistry (step 2) MUST be available to the mint (step 3) — the session binds it, and the activation handler's skill-step returns `[]` when `skillRegistry === undefined` (`handler.ts:191` `if (registry === undefined) return []`). A session built without it would silently surface no skills (partial-wire — see Risk R1). (The assembler resolves the skill registry on the path that feeds `installCodexR2Wires` / the activation step; ticket 02 owns threading it into the mint.)
- The `cfg.pluginSession` assignment (step 4) MUST be conditional on `session !== undefined`, or an `undefined` session leaks a defined-but-`undefined` slot and risks downstream guards diverging (Risk R2). The `else` branch MUST preserve the exact zero-arg `autoWirePluginActivation(cfg)` call so the OFF path is byte-identical-to-today.

### D. Lifecycle (teardown)

The assembler retains the `PluginMcpRegistry` on `cfg.pluginSession` (per `types.ts:2199` contract — *"the composition root … calls `shutdownAll()` on session end"*; the assembler is that root for all surfaces). On session end (the same teardown path each surface uses to dispose session resources — the bootstrap/loop dispose-abort sink), the teardown calls:

```ts
if (cfg.pluginSession !== undefined) await cfg.pluginSession.mcpRegistry.shutdownAll()
```

- NO-THROW: wrap so a launcher fault on teardown cannot crash session exit (mirror the assembler's NO-THROW posture; the registry's own `shutdownAll` is also defensive).
- Absent session ⇒ no registry ⇒ nothing to shut down (no-op). **`shutdownAll()` MUST be called exactly once per minted session** — double-call after a clean shutdown is a no-op by registry contract (`plugin-mcp-launcher/registry.ts:14` "both reset by shutdownAll()"), but the test matrix asserts the single-call path on the normal teardown.
- Because the session hangs off `AgentConfig`, the teardown hook is surface-uniform: every surface that disposes `cfg` reaches `cfg.pluginSession` the same way.

### E. The DEFAULT-OFF byte-identity matrix (the headline deliverable — spans ALL surfaces)

The e2e hellgate. For EACH seam below, with `QUANTA_PLUGIN_MODE` unset/off (the no-plugins case is a separate row in §TDD), assert the seam is **byte-identical** to a baseline captured with the slot absent. The assertion is *structural equality of the produced artifact*, not a smoke check.

**Asserted AT the shared assembler, so each row holds for CLI + web-daemon + IDE uniformly.** Because the mint lives inside `assembleAgentConfig`, a single off-gate assertion on the assembler's output proves inertness for every surface at once — there is no per-surface mint to audit separately. (The earlier draft asserted at the CLI comp-root, which would have proven the OFF path only for CLI and left web/IDE unproven.)

| # | Seam | Artifact asserted byte-identical when gate OFF | Why it holds (the short-circuit) | Surface scope |
|---|---|---|---|---|
| M1 | **skill registry** | the resolved skill list / sources from `defaultSkillSources` | 01's plugin source is GATED on the session; no session ⇒ source not added ⇒ same 6 sources (admin/repo/team/user/personal/system) | all (asserted on assembler-resolved registry) |
| M2 | **activation handler** | `AgentConfig.activatePlugins` is the SAME value (today's auto-wire stub OR `undefined`) | no session ⇒ assembler takes the `else` branch = today's zero-arg `autoWirePluginActivation(cfg)`; with empty `.quanta/plugins` that already leaves `activatePlugins` per the empty-discovery short-circuit (`auto-wire.ts:135` `if (manifests.length === 0) return`) | all |
| M3 | **system prompt** | the assembled system-prompt string (`buildTurnContext` output) | 04's routing block is rendered iff `cfg.pluginSession?.routingBlock` is present; absent ⇒ no splice ⇒ byte-identical prompt (loop-activation-hook non-goal already: "does NOT touch `@/agent/prompt`") | all |
| M4 | **dispatch admissibility** | the dispatch decision for a given `(tool, args)` | 05's capability policy is consulted iff `cfg.pluginSession?.capabilityPolicy` threaded; absent ⇒ dispatch gate path unchanged (no extra precheck) | all |
| M5 | **MCP launches** | zero plugin MCP servers spawned; no `shutdownAll` scheduled | no session ⇒ no `mcpRegistry` minted ⇒ no spawn, no teardown hook | all |
| M6 | **AgentConfig surface** | `assembleAgentConfig(req, env)` output with `pluginSession` absent === legacy | the conditional assignment injects NO `pluginSession` key when the mint returns undefined; the `else` branch is the verbatim legacy call | all (the assembler IS the SSOT — this row is the keystone) |
| M7 | **/plugins UX (per-surface)** | the slash/palette command set: CLI `registry-surface.ts` (ticket 06) and web/IDE `SlashPalette.tsx` (ticket 08) | the `/plugins` UX is registered iff the surface opts in AND a session is present; gate off ⇒ no session ⇒ command/palette-entry absent on BOTH surfaces ⇒ same set | **per-surface** (CLI=06, web/IDE=08) — but it gates on the SAME `cfg.pluginSession` minted once here |

**Note on M7 (the per-surface UX seam):** the `/plugins` enable/disable UI is the ONLY plugin concern that is genuinely per-surface — CLI ships it via ticket 06, web/IDE via ticket 08 (00-index §표면 토폴로지 lines 68-74). The CORE — skill registry, activation, routing, capability rail, MCP — lights up on ALL surfaces at this single assembler mint (rows M1-M6), and the UX merely renders over the shared `cfg.pluginSession`. So even before ticket 08 lands, web/IDE get plugin skills + MCP + routing (00-index line 96); only the enable/disable toggle UI awaits 08.

M1-M7 together ARE the proof that 01-05 are inert when the gate is off, on every surface. The e2e hellgate exercises the REAL `assembleAgentConfig` twice (gate off vs. a baseline env) and diffs each artifact, plus a per-surface arm (drive at least the CLI comp-root + an `ide.runMode`-style assembly) confirming the OFF-path artifacts match across surfaces.

---

## Files

All EXTENDs (no new prod file owned by 07 except the e2e test — ticket 03 owns `plugin-session/`):

| File | Change |
|---|---|
| `src/host/runtime/agent-config-assembler.ts` | **EXTEND — the primary mint site.** At the `:799` plugin step, replace the bare `autoWirePluginActivation(cfg)` with the gated mint: `mintPluginSession({ env, cwd: cfg.cwd, skillRegistry })` (sync) → if defined, `cfg.pluginSession = session` + `autoWirePluginActivation(cfg, { session })`; else the verbatim `autoWirePluginActivation(cfg)` (byte-identical OFF path). This is THE cross-surface mint — covers CLI + web-daemon + IDE + all presets in one place. (Ticket 02 owns the `AutoWireDeps.session` param + `skillRegistry` injection; 07 owns the mint + thread at this call site.) |
| `src/config/knob-inventory.ts` | **EXTEND** — append `QUANTA_PLUGIN_MODE` to the `HOST` array (shape in §A). Keeps the orphan ratchet at 0 (read-site declaration). |
| `src/agent/types.ts` | **EXTEND** — add `pluginSession?: PluginSession` to `AgentConfig`, adjacent to `activatePlugins` at `:2204`. (Type owned by ticket 03; 07 adds the AgentConfig slot the assembler assigns + every surface's teardown reads.) |
| `src/shared/runtime-config*.ts` knob read | **N/A — NOT a typed value.** The `QUANTA_PLUGIN_MODE` read is a `gateOn(env, …)` at the mint helper (called by the assembler), NOT a `runtimeConfig().field`. The "runtime-config knob read" is therefore the `gateOn` at `agent/plugin-session/mint.ts` (the declared read-site), NOT an entry in `runtime-config.ts`/`runtime-config-knobs.ts`. |
| **REMOVED (no longer 07's mint site):** `src/apps/cli/repl/runtime-context-compose.ts` | The earlier draft made this the `plugin-session` mint (overlay spread + thread). **It is NOT the plugin-session mint anymore** — minting here would leave web/IDE dark. The CLI comp-root remains correct for CLI-ONLY slots (worktree ticket-11 `:273`, model-adapter ticket-14), but plugin-session is cross-surface and mints at the assembler. No 07 edit to this file. |
| **REMOVED (no longer in the threading path):** `src/host/runtime/internal/context-binding.ts` | The `RuntimeBootstrapOverlay → AgentConfig` lift is the CLI comp-root's overlay path. Since plugin-session no longer rides the overlay, NO `pluginSession` slot is added to `RuntimeBootstrapOverlay` and NO `whenDefined` lift line. The assembler assigns `cfg.pluginSession` directly. No 07 edit to this file. |

**NOT touched:** `runtime-config.ts`, `runtime-config-knobs.ts` (Risk R5 — `gateOn` gate, not a typed value); `runtime-context-compose.ts`, `context-binding.ts` (mint moved to the shared assembler).

---

## TDD — red-first hellgate

Write the tests RED first; each must FAIL before the wiring lands, and the byte-identity rows must go RED on injection (a deliberately-broken short-circuit must turn the test red, else the ceiling is vacuous).

1. **gate-on mints session + wires all seams** (`mint-plugin-session.hellgate.test.ts`): with `QUANTA_PLUGIN_MODE=1` and a fixture `.quanta/plugins` (one plugin: a skill + an `.mcp.json` + `plugin.json`), `mintPluginSession` returns a defined `PluginSession` whose: enabled-state store lists the plugin; activation handler resolves `<plugin>:<skill>` (skillRegistry injected — assert NON-empty, the inverse of `handler.ts:191`); routing block is non-empty; capability policy is present; status view lists it. RED first (helper/threading absent).

2. **gate-off ⇒ every seam byte-identical — THE MATRIX, at the assembler** (`plugin-mode-byte-identity.hellgate.test.ts`): the M1–M7 table, asserted on `assembleAgentConfig(req, env)` output (the SSOT). For each row, capture the artifact with the gate off and assert structural equality to the legacy baseline. Includes the **red-on-injection** guard: a test that deliberately makes the `cfg.pluginSession` assignment unconditional (slot always defined) MUST turn M6 red — proving the matrix is not vacuous.

3. **no-plugins ⇒ byte-identical** (same file): `QUANTA_PLUGIN_MODE=1` but `.quanta/plugins` empty/absent ⇒ `mintPluginSession` returns `undefined` ⇒ all M1–M7 hold. Proves the TWO-condition gate (00-index line 7: "게이트 off **또는** plugins 비면 동일").

4. **shutdownAll on teardown** (`plugin-session-lifecycle.hellgate.test.ts`): with a minted session (spy `mcpRegistry`), the session dispose path calls `cfg.pluginSession.mcpRegistry.shutdownAll()` exactly once; a launcher that throws on shutdown does NOT crash teardown (NO-THROW). Gate off ⇒ no session ⇒ `shutdownAll` never referenced.

5. **knob inventory ratchet green**: `bun test tests/unit/knob-registry-completeness-ratchet-hellgate.test.ts` — the new `gateOn(env, "QUANTA_PLUGIN_MODE")` read in `plugin-session/mint.ts` (called by the assembler) is declared (orphan count stays at `ORPHAN_CEILING = 0`). RED first: the read added WITHOUT the inventory entry must trip the ceiling (proves the registration is load-bearing).

6. **e2e: real shared assembler, both polarities, MULTI-SURFACE** (`plugin-mode-e2e.hellgate.test.ts`): exercise the REAL `assembleAgentConfig` (and at least one real surface assembly path on top of it) over a fixture workspace whose `.quanta/plugins` holds one plugin (skill + `.mcp.json` + `plugin.json`).
   - **gate-on** (`QUANTA_PLUGIN_MODE=1`, fixture plugin present): on the AGENT runtime — regardless of which surface assembled it — the plugin's skill surfaces in the assembled skill set; the routing block is present in the assembled system prompt; the plugin's MCP server is launched (registry non-empty) and `shutdownAll` is scheduled on teardown; the capability policy gates dispatch. (`/plugins` UX is per-surface: CLI 06 / web-IDE 08 — assert the CORE here, not the UX.)
   - **gate-off** (same workspace, gate unset): NONE of the above — skill absent, no routing block, zero MCP launches, no capability precheck.
   - **cross-surface arm:** assert the gate-on core fires for at least TWO assembly entry points sharing the assembler (e.g. the CLI comp-root path AND an `ide.runMode`-style `assembleAgentConfig({ mode: "ide", … })`), and the gate-off artifacts match across both — proving the mint is surface-uniform, not CLI-only. This is the regression that would have caught the earlier comp-root mistake.

---

## Slice-fence

- The mint helper lives in `@/agent` (`plugin-session/mint.ts`), NOT `@/apps/cli`, so it stays importable by the unit hellgates without crossing the CLI fence — same reason `mintActiveWorktreeSlot` lives in `@/agent/worktree-slot.ts` (`worktree-slot.ts:48-51`).
- `knob-inventory.ts` is PURE DATA (`@/config`, no imports, no env reads — `knob-inventory.ts:16-18`); the append adds no imports.
- `agent-config-assembler.ts` (`@/host/runtime`) already imports `autoWirePluginActivation` from `@/agent/plugin-activation-handler` (`agent-config-assembler.ts:55`); `mintPluginSession` from `@/agent/plugin-session` joins the existing `@/host → @/agent` dependency direction. No new slice edge.
- The new `gateOn` read is in `@/agent` (imports `gateOn` from `@/shared`, as `worktree-slot.ts:20` does) — within the existing dependency direction.
- biome `noRestrictedImports` slice-fence: no new cross-slice edge introduced (assembler→`@/agent` pre-exists at `:55`).

---

## Risks

- **R1 — partial-wire (one seam minted, others not — INCLUDING one surface dark).** The defining failure mode of an integration ticket has TWO flavors here: (a) the session is threaded but `skillRegistry` is NOT injected into the activation handler (today's omit at `auto-wire.ts:145`), so the plugin's MCP launches but its skills never surface (`handler.ts:191` returns `[]`); or the routing block is built but the prompt does not render it. (b) **The cross-surface flavor that motivated this revision:** the mint lands at a single-surface root (the CLI comp-root) so web/IDE never see it — a feature that "works" in CLI tests but is dead on every other surface. **Mitigation:** for (a), test #1 asserts ALL seams in one minted session; for (b), the mint lives at the SHARED assembler and e2e #6's cross-surface arm asserts the core fires for ≥2 assembly entry points. The assembly-order table (§C) is the checklist.

- **R2 — defined-but-`undefined` slot leaks (byte-identity break).** If the `cfg.pluginSession` assignment is unconditional, an `undefined` session injects a present-but-undefined `pluginSession` key, and downstream `?.` guards may diverge (e.g. a prompt branch that checks `cfg.pluginSession !== undefined` rather than `cfg.pluginSession?.routingBlock`). **Mitigation:** assign `cfg.pluginSession` ONLY when the mint returns a defined session (the `if` branch in §C step 4); the OFF path takes the verbatim `else` (zero-arg `autoWirePluginActivation(cfg)`). The M6 red-on-injection test (unconditional assignment) forces this.

- **R3 — concurrent-session shared-file overlap.** 00-index §작업트리 warns the EXTEND files (`agent-config-assembler.ts`, `registry-surface.ts`, etc.) overlap with other in-flight sessions (NEW cluster 16-25: browser/mcp-server/fleet). The assembler `:799` plugin step and `knob-inventory.ts` HOST array are likely contention points — and the assembler edit is now LARGER than the old single-line thread (it is a mint + branch at `:799`), so collision area is higher. **Mitigation:** before landing, re-check `git status` + diff `agent-config-assembler.ts`; keep the mint logic in the `@/agent/plugin-session/mint.ts` helper so the assembler delta is a small call + branch; `knob-inventory.ts` is an array append (merge-trivial). Do NOT `git add -u` (MEMORY: sweep-commit hazard).

- **R4 — lifecycle double-mint / leaked registry.** If the assembler mints and the config is re-assembled (resume / re-bootstrap / per-turn re-assembly) without the prior `shutdownAll`, plugin MCP servers leak. Note the assembler IS called per-turn via `buildInteractiveTurnAssembler` (`:814`), so the mint MUST be idempotent-by-discovery (same plugins ⇒ logically the same session) OR the session must be cached per `sessionId` the way `installCodexR2Wires` reuses `sessionResources` (`:745-752`). **Mitigation:** ticket 03 owns the session-scoping contract; 07 binds teardown to the session dispose path and asserts single-`shutdownAll` (test #4). Re-assembly within a session reuses (does not re-spawn) the registry; a NEW session gets a fresh one. The registry is session-scoped, never shared across sessions (mirrors the worktree slot's per-session shape). **This per-turn re-assembly concern is sharper at the assembler than it was at the once-per-boot comp-root — call it out for ticket 03's session-cache design.**

- **R5 — wrong knob home.** Adding a `runtime-config.ts` field + `runtime-config-knobs.ts` entry for a knob that is NEVER read as `runtimeConfig().field` would be dead surface AND would still leave the `gateOn` read an orphan (the ratchet keys on the READ site, not the field). `QUANTA_WORKTREE_TOOL` proves the correct home for such a gate is `knob-inventory.ts` alone. **Mitigation:** register ONLY in `knob-inventory.ts`; do not touch `runtime-config*.ts`. (If a future need arises to read the flag as a typed value elsewhere, that is a separate read-routing/P4 change.)

- **R6 — vacuous byte-identity ceiling.** A matrix that always passes (because the artifacts are captured identically by construction) proves nothing. **Mitigation:** every matrix row carries a red-on-injection variant (the M6 unconditional-assignment case is the canonical one); the e2e #6 gate-on arm proves the seams CAN fire on ≥2 surfaces, so the gate-off arm's all-absent assertion is meaningful.

---

## Deps

**Integration ticket — needs 02–05 green first (wave-C). Feeds 08.**
- **02** — `autoWirePluginActivation` EXTENDED to accept injected `{ session }` with `skillRegistry` (`auto-wire.ts`); 07 threads the session into the `:799` call. (02 also depends on 01 — the `plugin` skill source in `defaultSkillSources`, `skill/registry.ts:61` — which transitively underwrites 07's M1.)
- **03** — `plugin-session/` slice (`PluginSession` type, `mintPluginSession`, enable-state store, `shutdownAll` lifetime, session-scoping for per-turn re-assembly — R4); 07 calls its mint + teardown.
- **04** — `plugin-routing/` block + prompt consumption; 07's M3 + assembly step 5.
- **05** — `plugin-capability-policy.ts` dispatch gate; 07's M4 + assembly step 6.

**NOT a dep:** **06** (CLI `/plugins` surface) is a parallel wave-B item, NOT upstream of 07 — it renders enable/disable UX over the SAME `cfg.pluginSession` this ticket mints, but the core lights up regardless. 07 **feeds 08** (web/IDE `/plugins` UX), which depends on 07 (00-index ticket table: 08 deps = 03,07).

If any of 02–05 is not yet merged, 07's corresponding matrix row + assembly step is unbuildable; do NOT stub them — block on the dep (00-index sequencing: wave-C after wave-A/B green).

**Audit gate:** before any "100% / complete" claim, ≥3 adversarial audits (MEMORY hard-rule), with special suspicion on (a) the byte-identity *synthesis* (the claim that M1–M7 collectively prove inertness) — verify each row's short-circuit is the REAL code path, not an assumed one; and (b) the **cross-surface** claim — verify the mint at the assembler genuinely fires for a non-CLI surface (web-daemon/IDE assembly path), not just the CLI comp-root, before claiming "all surfaces."
