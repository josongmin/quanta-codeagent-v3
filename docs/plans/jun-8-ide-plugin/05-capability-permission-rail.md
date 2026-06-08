# Ticket 05 — capability→permission rail (`plugin-capability-policy.ts`)

**Date:** 2026-06-08 · **Gap:** #5 (00-index.md:46) · **Kind:** NEW pure slice + dispatch gate
**Deps:** ticket 03 (`plugin-session/` enable-state — supplies the plugin→capabilities lookup) · **Feeds:** ticket 07 (gate `QUANTA_PLUGIN_MODE` + comp-root assembly + default-OFF e2e)
**Wave:** A core is pure (parallel with 01/03); the dispatch WIRE lands behind ticket-03's session lookup, so the live consult is a wave-B finish.

Read first: `00-index.md` (model + discipline) · `docs/reviews-codex-agent/plugin-audit.md` §R2.1 ("No `permissions` field in the manifest — permission gating is OS-level, not declarative"). The pattern source is **ticket-12** `src/agent/ownership-policy.ts` + its dispatch gate.

---

## 1. Gap

A plugin manifest declares `interface.capabilities: ("Interactive"|"Read"|"Write")[]` — an *advertised* trust surface (which classes of effect the plugin claims it performs). quanta **never enforces it**. A plugin's contributed MCP tool runs through `dispatchTool` with the **conservative MCP default** (`isReadOnly:()=>false`, full permission path) but with **zero capability-derived admissibility**: a plugin that declared only `["Read"]` can contribute an MCP server whose tool writes files or shells out, and dispatch admits it exactly as if it had declared `["Write"]`. The declared capability set is decorative.

This is the **2nd-layer advisory** half of the defense. Per §R2.1 and `00-index.md:22`, capabilities are *advertise-only metadata*; the **primary** boundary is the isolation sandbox (`src/plugin-isolation/plugin-host.ts` — process isolation, JSON-RPC, lifecycle). This ticket adds a declarative cross-check **on top of** that sandbox: a plugin tool whose effect class exceeds the plugin's own declared capability set is a manifest-vs-behavior contradiction and is denied. It is NOT a sandbox replacement (see §5, §8).

---

## 2. Current (file:line — all verified)

**Declared only, never consumed:**
- `src/skill/plugin-manifest.ts:30` — `CapabilitySchema = z.enum(["Interactive","Read","Write"])`.
- `src/skill/plugin-manifest.ts:80` — `PluginInterfaceSchema.capabilities: z.array(CapabilitySchema)` (strict-validated, security-load-bearing per the docstring at `:129`).
- `src/agent/plugin-discovery/types.ts:49` — the parallel flat `PluginCapability = "Interactive"|"Read"|"Write"` (frozen enum); `:97` `PluginManifest.capabilities: readonly PluginCapability[]`; `:42-47` docstring states verbatim *"runtime enforcement is the host's job, not this slice's"* — i.e. the enforcement seam is explicitly delegated and currently **absent**.
- Reader grep: the only hits for `capabilities` in the plugin path are the two **schema declarations** (`plugin-manifest.ts:80`, `plugin-discovery/types.ts:97`) and docstrings (`plugin-manifest.ts:129`, `manifest-compat.ts:29`). **No `dispatch.ts` / `src/permission/` consumer.** Confirmed gap #5 (00-index.md:46).

**Isolation boundary has NO declarative entitlements (confirms §R2.1):**
- `src/plugin-isolation/plugin-host.ts:99-335` — `PluginHost` is a *protocol-agnostic* JSON-RPC 2.0 wrapper over `IsolatedProcess`. Its docstring (`:5-7`) says "any plugin can speak any method names". There is **no permission/entitlement/capability field** anywhere on `PluginHost`, `PluginHostOpts` (`:90-92`), or `CallOpts` (`:94-97`). The sandbox is process-level, exactly as §R2.1 asserts.

**How a plugin-origin MCP tool reaches dispatch (the identification chain — traced end-to-end):**
1. `src/agent/plugin-mcp-launcher/launcher.ts:50-51` — `composeServerId(pluginId, serverName) = `${pluginId}::${serverName}``. The `::` separator is "unambiguous because plugin names follow `^[a-z0-9][a-z0-9._-]*$` (no colons)" (`:46-49`).
2. `src/agent/plugin-mcp-launcher/isolated-launcher-port.ts:51` — `toMcpConfig` sets the spawned client's `McpServerConfig.name = composeServerId(pluginId, serverName)` = `${pluginId}::${serverName}`. **The plugin id is baked into the MCP server config name.**
3. `src/agent/mcp-bridge.ts:792` (single-client) / `:737` (supervised) — `loadMcpTools` bridges each tool via `mcpToolToTool(client, def, config.name, …)`, passing `config.name` (= the composed serverId) as `serverName`.
4. `src/agent/mcp-bridge.ts:347` / `:429` → `:59-61` — `mcpToolName(server, tool) = `mcp__${clean(server)}__${clean(tool)}`` where `clean = s.replace(/[^A-Za-z0-9_]+/g, "_")`. So a plugin-origin tool's dispatched `call.name` is:

   `mcp__<clean(`${pluginId}::${serverName}`)>__<clean(toolName)>`

   ⚠️ **The `::` is SANITIZED to `_`** (it is non-alphanumeric). So `acme::main` → `acme_main`. The composed-id boundary is **lossy** in the final tool name — see §6 (the policy must NOT re-parse the sanitized name; it must carry the un-sanitized serverId forward).
5. `src/agent/dispatch.ts:896` — dispatch sees only `call.name` (a plain string). It does **not** know the call came from a plugin's MCP server. There is no plugin-origin flag on `ToolUseBlock`.

**The pattern to mirror (ticket-12):**
- `src/agent/ownership-policy.ts:41-90` — pure verdict (`isPathAllowed`, `consultOwnershipPolicy`, `checkWriteEffects`) + `buildOwnershipPolicy` (`:95-111`). Default-OFF via `enforced !== true` ⇒ `{allowed:true}` (`:45,:66,:85`).
- `src/agent/dispatch.ts:1002-1015` — the gate: `if (config.ownershipPolicy?.enforced === true) { … checkWriteEffects(…); if (!own.allowed) return deny(…, "ownership-policy-denied", denyReason({layer:"stack", …})) }`. Runs **after** the admissibility gate, **before** execute.
- `src/agent/types.ts:515` — `ownershipPolicy?: …OwnershipPolicy` threaded onto `AgentConfig`.
- Knob: `src/shared/runtime-config-knobs.ts:707-713` declares `QUANTA_FS_OWNERSHIP_ENFORCE` (kind `bool`, default `false`, group `permission`); `src/shared/runtime-config.ts:1221` field `fsOwnershipEnforce`; `:1716` read via **`gateOnStrict`** (security gate — exact `=== "1"`).

---

## 3. Design

### 3.1 Capability → admissibility map

A plugin's declared capability *set* is the **upper bound** on the effect classes its contributed tools may perform. A contributed MCP tool is classified into one effect class; the call is admitted iff that class is covered by the plugin's declared set.

| Tool effect class | Admitted iff the plugin declared… | Rationale |
|---|---|---|
| **read-only** (no FS write, no shell, no mutation) | `Read` **or** `Write` (Write subsumes Read) | A reading tool is the floor; a Write plugin can also read. |
| **write / exec** (FS write, shell, state mutation) | `Write` | Mutation requires the explicit `Write` advertisement. |
| **interactive** (prompts the user / opens a dialog — HITL) | `Interactive` (admitted, but **routed to the approval gate**, not auto-allowed) | `Interactive` is an *approval-required* verdict, not a pass: the plugin claims it may prompt, so the host's HITL path must run. |

Verdict union (three outcomes, mirroring ownership-policy's `{allowed}` shape extended with an `approval` arm):

```
{ kind: "allow" }
{ kind: "approval"; capability: "Interactive" }            // requires HITL
{ kind: "deny"; reason: "capability_exceeded"; needed: Capability; declared: readonly Capability[] }
```

- **Empty declared set** ⇒ a plugin that advertised *no* capability may contribute only read-only tools? No — an empty set advertises *nothing*, so any effect is unbacked ⇒ **fail-closed deny** (see §3.4). (Distinguish from "policy disarmed": disarmed is `enforced:false` ⇒ allow; armed-with-empty-declaration is a real deny.)
- **Effect classification** is the same conservative signal dispatch already owns: a tool is read-only iff `registry.isReadOnly(name) === true` (the runtime SSOT used at `dispatch.ts:920,977`). For an MCP tool that signal is `false` unless the server is host-trusted AND `QUANTA_MCP_TOOL_ANNOTATIONS` honored its `readOnlyHint` (`mcp-bridge.ts:123-128`). So by default **every plugin MCP tool classifies as write/exec** ⇒ needs `Write`. This is deliberately conservative (a `Read`-declared plugin's un-annotated tool is denied unless the plugin re-declares `Write` or the server is trusted+annotated read-only). The "interactive" class is detected NOT from the tool body but from the plugin's *own* declared set: if a tool is non-read-only AND the plugin declared `Interactive` but **not** `Write`, the most-permissive backing is `Interactive` ⇒ approval (rather than an outright deny). See §3.2 resolution order.

### 3.2 Pure policy — `consultCapabilityPolicy`

```ts
// src/agent/plugin-capability-policy.ts  (pure — no fs, no clock, no registry)

import type { Capability } from "@/skill/plugin-manifest"  // the closed enum (SSOT)

export interface CapabilityPolicy {
  /** The plugin's declared capability set (the upper bound). */
  readonly declared: readonly Capability[]
  /** Hard gate. false/absent ⇒ advisory-only legacy (allow everything). */
  readonly enforced?: boolean
}

/** The effect class dispatch can derive for THIS call without running it. */
export interface ToolEffect {
  /** registry.isReadOnly(call.name) — the runtime SSOT. */
  readonly isReadOnly: boolean
}

export type CapabilityVerdict =
  | { allowed: true; approval?: false }
  | { allowed: true; approval: true; capability: "Interactive" }
  | { allowed: false; reason: "capability_exceeded"; needed: Capability; declared: readonly Capability[] }

export const consultCapabilityPolicy = (
  effect: ToolEffect,
  policy: CapabilityPolicy | undefined,
): CapabilityVerdict => {
  if (policy?.enforced !== true) return { allowed: true }          // default-OFF / disarmed
  const has = (c: Capability): boolean => policy.declared.includes(c)
  if (effect.isReadOnly) {
    // read floor: Read OR Write backs it; Interactive alone does NOT (a plugin
    // that ONLY prompts has not claimed it reads).
    return has("Read") || has("Write")
      ? { allowed: true }
      : { allowed: false, reason: "capability_exceeded", needed: "Read", declared: policy.declared }
  }
  // non-read-only ⇒ write/exec class.
  if (has("Write")) return { allowed: true }
  // not Write, but the plugin claimed it may interact ⇒ route to HITL approval
  // (a mutating-but-interactive plugin is admissible UNDER approval, never auto).
  if (has("Interactive")) return { allowed: true, approval: true, capability: "Interactive" }
  return { allowed: false, reason: "capability_exceeded", needed: "Write", declared: policy.declared }
}
```

Purity = fully hellgate-testable (no I/O), exactly like `ownership-policy.ts:41-72`. `Capability` is imported from `@/skill/plugin-manifest` (the strict closed enum SSOT at `:30-31`) — do NOT re-declare it.

### 3.3 Policy builder

```ts
export const buildCapabilityPolicy = (args: {
  readonly declared: readonly Capability[]
  readonly enforced: boolean
}): CapabilityPolicy | undefined =>
  args.enforced ? { declared: args.declared, enforced: true } : undefined
```

Returns `undefined` when not enforced ⇒ the dispatch gate is never armed (mirrors `buildOwnershipPolicy` returning `undefined` to leave the gate cold, `ownership-policy.ts:103`).

### 3.4 Fail-closed semantics (ticket-12 parity)

- `enforced !== true` ⇒ `{allowed:true}` (disarmed = byte-identical legacy).
- enforced **and** the plugin lookup yields **no manifest** for the call's plugin id (unknown plugin, registry miss, malformed manifest) ⇒ **deny** (do NOT fall through to allow). This is the security inversion: an armed rail treats "I can't find the declaration" as "not declared" ⇒ deny. Distinct verdict `reason: "unknown_plugin"` so the deny message is honest.
- enforced and declared set is **empty** ⇒ any effect deny (`capability_exceeded`, `needed` = the effect's class). Empty advertisement backs nothing.
- A throw anywhere in the lookup ⇒ caught at the gate, **deny** (no-throw contract: the dispatch outer catch at `dispatch.ts:569-594` would otherwise normalize a throw to a generic dispatch-error deny — we deny *explicitly with a capability reason* before that).

### 3.5 Dispatch gate (mirror `dispatch.ts:1002-1015`)

Placement: **after** `runAdmissibilityGate` and the ownership-policy block (`dispatch.ts:996-1015`), **before** `execute`. Insert a sibling block:

```ts
// gap #5 (jun-8 plugin) — plugin capability rail. 2nd-layer advisory check:
// a plugin-origin MCP tool whose effect class exceeds the plugin's DECLARED
// capability set is denied. Default-OFF: no plugin origin / gate off ⇒ skipped.
if (config.pluginCapabilityEnforce) {
  const origin = identifyPluginOrigin(call.name, config.pluginServerIndex)
  if (origin !== null) {
    const policy = buildCapabilityPolicy({
      declared: origin.declared,         // from the plugin session lookup (ticket 03)
      enforced: true,
    })
    const v = consultCapabilityPolicy({ isReadOnly: action.isReadOnly }, policy)
    if (!v.allowed) {
      return deny(
        call.id,
        `plugin capability boundary: ${origin.pluginId} declared [${origin.declared.join(", ")}] ` +
          `but this tool requires ${v.reason === "capability_exceeded" ? v.needed : "a known declaration"}`,
        "plugin-capability-denied",
        denyReason({ layer: "stack", safeReason: "plugin capability boundary violated" }),
      )
    }
    if (v.allowed && v.approval === true) {
      // route to the SAME HITL approval surface the admissibility gate already
      // owns (collapse-to-deny in v1 if no approval port wired, mirroring the
      // dispatch-guard `ask` arm at dispatch.ts:191-215 / 228-238). v2: re-enter
      // the HITL queue with a capability-tagged reason.
      return deny(
        call.id,
        `plugin capability "${origin.pluginId}" requires interactive approval for this tool`,
        "plugin-capability-approval",
        denyReason({ layer: "mode", pillar: "approval", safeReason: "plugin interactive capability requires approval" }),
      )
    }
  }
}
```

- `action.isReadOnly` is the already-computed `registry.isReadOnly(call.name)` (`dispatch.ts:977`) — no recompute.
- `denyReason` reuses the dispatch-local structured-deny helper (`dispatch.ts:67-72`), so the deny carries no tool input (no-leak, same as ownership at `:1012`).
- `"plugin-capability-denied"` / `"plugin-capability-approval"` are NEW preview tags (no collision with the existing vocabulary — mirrors how ticket-12 added `"ownership-policy-denied"`).

### 3.6 Plugin-origin identification — `identifyPluginOrigin` (the load-bearing seam)

This is the fragile part (§6). The gate must answer: *did `call.name` originate from plugin P's MCP server, and what is P's declared capability set?* Because the `::` is **sanitized away** in `mcpToolName` (§2 step 4), the tool name alone cannot be reliably re-parsed back to `(pluginId, serverName)`. Two design options — **prefer (A)**:

**(A) Forward-index (chosen).** Ticket 03's `plugin-session` already owns, per enabled plugin, the set of spawned MCP server handles (each handle carries `serverId = ${pluginId}::${serverName}`, `plugin-mcp-launcher/types.ts:38`). At session-build time the comp-root constructs an **index** keyed by the **exact tool name** quanta itself minted — by replaying `mcpToolName(serverId, def.name)` for every bridged tool — to `{ pluginId, declared }`. This is exact (no re-parse, no `::`-ambiguity) because we key on the SAME string `mcpToolName` produced. Shape:

```ts
export interface PluginServerIndex {
  /** Exact-match lookup: returns the owning plugin's origin for a tool name
   *  that quanta minted for a plugin MCP server, or null otherwise. */
  lookup(toolName: string): { pluginId: string; declared: readonly Capability[] } | null
}
```

Threaded onto `AgentConfig` as `pluginServerIndex?: PluginServerIndex` (mirrors `ownershipPolicy?` at `types.ts:515`). The boolean `pluginCapabilityEnforce` is the gate's arm signal (mirrors `ownershipPolicy?.enforced`). `identifyPluginOrigin(name, index)` = `index?.lookup(name) ?? null`.

**(B) Re-parse (rejected).** Strip the `mcp__` prefix and split on `__`, then try to reconstruct the pluginId. **Rejected**: the `::`→`_` sanitization is lossy and the toolname's own `__`/`_` chars collide. A pluginId `a_b` and serverName `c` is indistinguishable from pluginId `a` serverName `b_c` after `clean`. Re-parse would mis-attribute capabilities across plugins — a security defect. The forward-index avoids parsing entirely.

The index is built by the **comp-root** (ticket 07), not inside `@/agent` — keeping `plugin-capability-policy.ts` pure (it consumes the index via the `AgentConfig` field). The index population reuses the bridge's exact `mcpToolName` so there is ONE name-composition SSOT.

---

## 4. Files

| File | Change | Notes |
|---|---|---|
| `src/agent/plugin-capability-policy.ts` | **NEW** | Pure: `CapabilityPolicy`, `ToolEffect`, `CapabilityVerdict`, `consultCapabilityPolicy`, `buildCapabilityPolicy`. Plus the `PluginServerIndex` interface (port only — no impl). Imports `Capability` from `@/skill/plugin-manifest`. Single-file, ownership-policy.ts shape. Covered by `@/agent/*` tsconfig wildcard (no new path needed — 00-index.md:9). |
| `src/agent/dispatch.ts` | **EXTEND** | Add the gate block (§3.5) after the ownership block (`:1015`), before `effectiveCall` (`:1020`). Import `consultCapabilityPolicy`, `buildCapabilityPolicy` from `./plugin-capability-policy`. |
| `src/agent/types.ts` | **EXTEND** | Add `pluginCapabilityEnforce?: boolean` + `pluginServerIndex?: import("./plugin-capability-policy").PluginServerIndex` to `AgentConfig` (sibling to `ownershipPolicy?` at `:515`). |
| `src/shared/runtime-config-knobs.ts` | **EXTEND** | Declare `QUANTA_PLUGIN_CAPABILITY_ENFORCE` (kind `bool`, default `false`, group `permission`) — mirrors `:707-713`. (Orphan-ratchet requires the declare.) |
| `src/shared/runtime-config.ts` | **EXTEND** | Field `pluginCapabilityEnforce: boolean` (near `fsOwnershipEnforce` at `:1221`) + read `gateOnStrict(env, "QUANTA_PLUGIN_CAPABILITY_ENFORCE")` (near `:1716`). **Strict** opt-in (security gate). |

**Gate vocabulary decision:** the rail is its own **sub-knob** `QUANTA_PLUGIN_CAPABILITY_ENFORCE` (strict `gateOnStrict`), NOT folded into `QUANTA_PLUGIN_MODE`. Rationale: `QUANTA_PLUGIN_MODE` (ticket 07, `gateOn`) is the loose "plugins are surfaced at all" master; the capability rail is a *security* enforcement that must be a deliberate, unambiguous `=1` (same class as `QUANTA_FS_OWNERSHIP_ENFORCE`). The comp-root (ticket 07) only builds the `pluginServerIndex` when `QUANTA_PLUGIN_MODE` is on, so the effective enable is `QUANTA_PLUGIN_MODE && QUANTA_PLUGIN_CAPABILITY_ENFORCE` (mode off ⇒ no index ⇒ `identifyPluginOrigin` returns null ⇒ no consult, regardless of the sub-knob). Both off ⇒ byte-identical.

The composition wiring (comp-root assembles `pluginServerIndex` from ticket-03's session + sets `pluginCapabilityEnforce` from the knob) lands in **ticket 07**, not here. This ticket ships the pure policy + the dispatch gate + the `AgentConfig`/knob seams.

---

## 5. Honest scope (state explicitly in the code docstring)

Per §R2.1 and 00-index.md:22, **capabilities are advisory metadata; the isolation boundary (`src/plugin-isolation/plugin-host.ts`) is the primary defense.** This rail is a **2nd-layer advisory cross-check**: it denies a plugin tool whose *observed effect class* contradicts the plugin's *own declared* capability set — a self-consistency / least-privilege check, NOT a sandbox. It does **not**:
- inspect what the tool actually does at the syscall level (the sandbox does that);
- prevent a `Write`-declared plugin from doing anything a write tool can do (that's the sandbox + the normal permission stack);
- replace `runAdmissibilityGate` / HARD_DENY / the permission stack (it runs *in addition to* them, after them).

A plugin can always under-claim and still be sandboxed; the rail's value is catching the **advertise-Read-but-behave-Write** contradiction cheaply and declaratively, surfacing an honest deny reason. The docstring MUST say this so a future reader does not mistake it for the security boundary.

---

## 6. Risks

| Risk | Detail | Mitigation |
|---|---|---|
| **Plugin-origin identification fragility** | `mcpToolName` sanitizes `::`→`_` (`mcp-bridge.ts:60`), so the tool name is a lossy projection of `(pluginId, serverName)`. Re-parsing it back is ambiguous (a pluginId with `_` collides with a serverName boundary). | **Forward-index keyed on the exact minted tool name** (§3.6 A) — no re-parse. The index is built by replaying the SAME `mcpToolName` the bridge used, so the key is byte-identical. Hellgate: an `a_b::c` vs `a::b_c` pair must resolve to the correct distinct plugins. |
| **Over-block (false deny)** | Default MCP effect class is write/exec (annotations off ⇒ `isReadOnly:false`, `mcp-bridge.ts:127`). A genuinely read-only plugin tool that declared only `Read` would be denied because dispatch can't *see* it's read-only. | (a) Document that a plugin shipping read-only MCP tools should either declare `Write` or run a host-trusted server with `QUANTA_MCP_TOOL_ANNOTATIONS` so `readOnlyHint` lifts `isReadOnly`. (b) The rail is **opt-in** (`QUANTA_PLUGIN_CAPABILITY_ENFORCE` strict, default-OFF) — operators arm it knowingly. (c) `Interactive`-declared mutating tools get the softer **approval** arm, not a hard deny. |
| **Isolation-vs-policy boundary confusion** | A reader could treat this as the security boundary and weaken the sandbox. | §5 honest-scope docstring + the audit note in 00-index.md:22 / §R2.1. The deny message says "capability boundary" (advisory), not "blocked by sandbox". |
| **Two manifest shapes** | `@/skill/plugin-manifest`'s `interface.capabilities` (nested) vs `@/agent/plugin-discovery`'s flat `capabilities` (`types.ts:97`). Ticket 03's session must surface ONE. | The policy consumes a flat `readonly Capability[]` (the lookup's responsibility to flatten). The `Capability` *type* is the `@/skill/plugin-manifest` SSOT enum; `@/agent/plugin-discovery`'s `PluginCapability` is the structurally-identical frozen mirror — assert assignability at the index-build site (ticket 07), not here. |
| **Approval arm without a wired HITL port** | v1 collapses the `approval` verdict to a deny (mirrors dispatch-guard `ask`→deny at `dispatch.ts:191`). | Acceptable for v1; the `"plugin-capability-approval"` preview tag is the re-router seam a v2 keys on (same pattern as `"guard-ask"`). |

---

## 7. TDD — red-first hellgate

Pure-policy tests (no I/O) + gate integration tests (real `dispatchTool` seam). Every assertion red-first.

**Pure `consultCapabilityPolicy`:**
1. **Read plugin: write tool denied** — `declared:["Read"], enforced:true`, `effect:{isReadOnly:false}` ⇒ `{allowed:false, reason:"capability_exceeded", needed:"Write"}`.
2. **Write plugin: write tool admitted** — `declared:["Write"]`, `effect:{isReadOnly:false}` ⇒ `{allowed:true}`.
3. **Read plugin: read tool admitted** — `declared:["Read"]`, `effect:{isReadOnly:true}` ⇒ `{allowed:true}`.
4. **Write subsumes Read** — `declared:["Write"]`, `effect:{isReadOnly:true}` ⇒ `{allowed:true}`.
5. **Interactive arm** — `declared:["Interactive"]`, `effect:{isReadOnly:false}` ⇒ `{allowed:true, approval:true, capability:"Interactive"}` (approval, NOT auto-allow, NOT deny).
6. **Interactive-only does NOT back a read** — `declared:["Interactive"]`, `effect:{isReadOnly:true}` ⇒ deny `needed:"Read"` (claiming you prompt ≠ claiming you read).
7. **Capability-exceeding ⇒ typed deny** — `declared:["Read"], effect:{isReadOnly:false}` ⇒ deny with the typed `reason`/`needed`/`declared` fields populated (not a bare boolean).
8. **Empty declared set + enforced ⇒ deny any** — `declared:[], enforced:true`, both read and write effects ⇒ deny (empty advertisement backs nothing).
9. **Gate-off ⇒ allow** — `enforced:false` (or `policy:undefined`) ⇒ `{allowed:true}` for every effect (the disarmed legacy).

**Dispatch gate integration (real `dispatchTool`):**
10. **gate-off ⇒ no consult, byte-identical** — `config.pluginCapabilityEnforce` absent/false ⇒ a plugin-origin write tool dispatches exactly as today (assert the call reaches `execute`; assert NO `plugin-capability-*` preview tag; ideally a spy proving `consultCapabilityPolicy` is never invoked, or assert identical `DispatchResult` to the pre-gate baseline).
11. **fail-closed on unknown plugin** — enforced, but `pluginServerIndex.lookup` returns `null` for a `mcp__…` tool whose origin can't be resolved while the rail is armed AND the tool name pattern looks plugin-origin → in the *strict* interpretation the index miss means "not a tracked plugin tool" ⇒ **no consult** (a non-plugin MCP tool must not be blocked). Separately assert: when the index DOES resolve a plugin but its `declared` is unresolved/empty ⇒ deny (§3.4). (Two distinct tests — "not a plugin tool, pass-through" vs "is a plugin tool with no backing, deny".)
12. **red-on-injection (the load-bearing invariant)** — a `Read`-only plugin's contributed MCP tool that performs a write effect (`isReadOnly:false`) **MUST be denied** when armed. Wire a fake plugin-origin tool into the registry + an index entry `declared:["Read"]`, arm the knob, dispatch it, assert `ok:false` + preview tag `plugin-capability-denied` + the deny reason names `Write`. **This test must turn RED if the gate is removed/bypassed** (the invariant the whole ticket exists for).
13. **identification non-ambiguity** — index built for two plugins `a_b` (serverName `c`) and `a` (serverName `b_c`) whose minted tool names could collide under naive re-parse; assert each tool resolves to its OWN plugin's `declared` set (proves the forward-index, not a re-parse). A `Read`-only `a_b` write tool denies while a `Write` `a` tool admits — even though their raw `mcp__a_b_c__…`-ish names look alike.
14. **non-plugin MCP tool untouched** — a plain (non-plugin) MCP tool `mcp__github__foo` with the rail armed but no index entry ⇒ pass-through (no capability deny). Guards against the rail over-reaching to all MCP tools.

---

## 8. Slice-fence

- `plugin-capability-policy.ts` lives in `@/agent`; it may import `@/skill/plugin-manifest` (for the `Capability` enum) — allowed (agent is the assembler, `mcp-bridge.ts` docstring `:45-48`). It MUST NOT import `@/mcp`, `@/plugin-isolation`, or `@/agent/loop`/`dispatch` (pure leaf — same discipline as `ownership-policy.ts`, which imports only `@/storage` + `is-path-inside`).
- The `PluginServerIndex` is a **port** (interface) here; its concrete impl is built at the comp-root (ticket 07), keeping the policy file pure + plane-clean (mirrors `plugin-mcp-launcher/types.ts:53` `McpLauncherPort` being a port with the impl in `isolated-launcher-port.ts`).
- No new tsconfig path (the `@/agent/*` wildcard already covers it, 00-index.md:9). Biome `noRestrictedImports` slice-fence respected.

---

## 9. Deps & sequencing

- **Needs ticket 03** (`plugin-session/`): the per-plugin enabled-state + spawned-server tracking that supplies the `{ pluginId, serverName→serverId, declared capabilities }` data the comp-root folds into `PluginServerIndex`. Without 03 there is no live capabilities lookup — so the **pure policy** here is wave-A (independent, parallel with 01/03) but the **live dispatch consult** is dark until 03 + the 07 comp-root wire exist.
- **Feeds ticket 07**: 07 builds the `PluginServerIndex` (replaying `mcpToolName` over each enabled plugin's bridged tools), threads it + `pluginCapabilityEnforce` onto `AgentConfig`, and owns the default-OFF byte-identity e2e (`QUANTA_PLUGIN_MODE` off OR `.quanta/plugins` empty ⇒ no index ⇒ no consult).
- Independent of 02/04/06 (no shared EXTEND file beyond `dispatch.ts`/`types.ts`/`runtime-config*`; watch the 00-index.md:71 in-flight-tree caution on `runtime-config*.ts` + `types.ts` shared edits).

---

## 10. claim-100 discipline

Per memory hard-rule: any "100% complete" claim ⇒ ≥3 adversarial audits. The **synthesis** (capability→admissibility *interpretation*) is the most suspect surface — e.g. is `Interactive`→approval the right call vs deny? is "Write subsumes Read" the intended lattice? is the empty-set-deny over-strict? — audit those interpretive choices adversarially before claiming closure, not just the mechanical wiring.
