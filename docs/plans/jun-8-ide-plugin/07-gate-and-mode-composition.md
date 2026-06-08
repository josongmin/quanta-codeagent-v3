# Ticket 07 — `QUANTA_PLUGIN_MODE` gate + comp-root mode composition + default-OFF e2e

**Plan:** jun-8 Plugin (host) mode — see [`00-index.md`](./00-index.md) for the model + discipline.
**Gap (00-index):** #4 (표면/knob 0 — `/plugins`·`QUANTA_PLUGIN` grep=0) **and** #6 (partial-flavor: `autoWirePluginActivation` is already CALLED at `agent-config-assembler.ts:797` but with `skillRegistry` + session-state deliberately omitted, so it is a no-skill, no-enable-state stub).
**Kind:** knob + comp-root integration. **Deps:** 02, 03, 04, 05, 06 (this is wave-C, the keystone — it consumes every other ticket's seam). **Discipline:** default-OFF byte-identical; TDD red-first with red-on-injection; slice-fence; ≥3R adversarial audit before any claim-100.

This is the **integration ticket**. It owns NO new mechanism — it owns the **wiring decision**: a single knob, one comp-root mint, the assembly order over tickets 01–06, the lifecycle teardown, and the headline deliverable — the **default-OFF byte-identity matrix** proving every seam is untouched when the gate is off.

---

## Gap

Six tickets (01–06) build the plugin-host mechanism, but each lands its slice **default-OFF and unwired at the surface**:

- 01 adds a `plugin` skill source to `skill/registry.ts` (`defaultSkillSources`), but nothing turns it on.
- 02 EXTENDS `autoWirePluginActivation` (exported at `plugin-activation-handler/auto-wire.ts:121`, already `(cfg, deps: AutoWireDeps = {})`) to accept an injected `skillRegistry` + a session — but the assembler still calls the zero-arg form (`agent-config-assembler.ts:797` `autoWirePluginActivation(cfg)`), and `auto-wire.ts:145` today omits `skillRegistry` ("intentionally omitted — see module docstring §Defaults"), so plugin skills never surface.
- 03 mints a `plugin-session/` (enable-state + `PluginMcpRegistry` lifetime) — but it is `NOT YET CREATED` and nobody constructs it.
- 04 builds a `plugin-routing/` preference block the prompt can consume — but the prompt only renders it if a session is threaded.
- 05 builds a `plugin-capability-policy.ts` dispatch gate — but dispatch only consults it if the policy is threaded.
- 06 builds a `/plugins` surface (list/enable/disable/status) — but the slash command + its ctx slot are gated and unbuilt.

**No `QUANTA_PLUGIN_MODE` knob exists** (verified: `grep -rn "QUANTA_PLUGIN_MODE" src` = 0; the only `QUANTA_PLUGIN*`-adjacent inventory entry is unrelated). **No comp-root mints any of the above.** So even with 01–06 merged, plugin-host mode is dead code. Ticket 07 introduces the gate, mints the session at the composition root, threads it through the EXISTING overlay→AgentConfig lift mechanism, and proves the default-OFF byte-identity end-to-end.

---

## Current (file:line — the three patterns this ticket reuses verbatim)

### 1. The knob convention (a comp-root gate, NOT a typed `runtime-config` field)

The closest precedent is **`QUANTA_WORKTREE_TOOL`** (ticket-11), which is the SAME shape this ticket needs: a boolean gate, read at the comp-root via `gateOn`, that mints a session slot — NOT a value consumed via `runtimeConfig().field`.

- It is read **directly** by `gateOn`, not in `runtime-config.ts`. The mint helper lives in a library slice so it is unit-testable without crossing the `@/apps/cli` fence:
  - `src/agent/worktree-slot.ts:52` — `mintActiveWorktreeSlot(envSource, bootCwd)`:
    ```ts
    gateOn(envSource, "QUANTA_WORKTREE_TOOL")
      ? createWorktreeSlot({ repoRoot: bootCwd, sessionCwd: bootCwd })
      : undefined
    ```
    (imports `gateOn` from `@/shared`, `worktree-slot.ts:20`).
- Because it is a `gateOn` comp-root read (not a `runtimeConfig()` field), it is **NOT** in `runtime-config.ts` / `runtime-config-knobs.ts`. It IS registered in the daemon/host inventory:
  - `src/config/knob-inventory.ts:78-85` — `{ envKey: "QUANTA_WORKTREE_TOOL", kind: "bool", default: false, group: "host-gate", home: "runtime-config", describe: "Agent worktree tools …", readSite: "agent/worktree-slot.ts" }`.

**Decision (mirror exactly):** `QUANTA_PLUGIN_MODE` is a `gateOn` comp-root gate. It is registered in `knob-inventory.ts` (group `host-gate`, home `runtime-config`, `readSite: "agent/plugin-session/mint.ts"` — ticket 03's mint site). It is **NOT** a `runtime-config.ts` field and **NOT** a `runtime-config-knobs.ts` entry — those are for values consumed via `runtimeConfig().field`, which this is not. (The prompt's §10 line "신규 knob → `runtime-config-knobs.ts` declare + `runtime-config.ts` 필드+read" is the convention for *typed value* knobs; `QUANTA_WORKTREE_TOOL` establishes the comp-root-gate carve-out, and this knob follows that precedent. See **Risk R5** for why we do NOT also add a `runtime-config` field.)

### 2. The comp-root mint + overlay + thread pattern (ticket 11 + 14 precedent)

`src/apps/cli/repl/runtime-context-compose.ts` is the CLI composition root. Two prior tickets minted session slots here; 07 adds a third, identically shaped:

- **Mint** (`runtime-context-compose.ts:273`):
  ```ts
  const activeWorktreeSlot = mintActiveWorktreeSlot(args.envSource ?? process.env, boot.cwd)
  ```
  (`boot.cwd` is the SESSION-RESOLVED jailed cwd — NOT raw `process.cwd()`; comment at `:268-272`.)
- **Overlay** (`runtime-context-compose.ts:158-161`): the slot is spread onto the overlay ONLY when defined —
  ```ts
  ...(activeWorktreeSlot !== undefined ? { activeWorktreeSlot } : {}),
  ```
- **Thread into bootstrap args** (`runtime-context-compose.ts:288`): same conditional-spread into `buildBootstrapContextArgs`.
- The `buildBootstrapContextArgs` field doc at `:105-110` documents the "mint at comp-root behind gate / absent ⇒ slot omitted ⇒ byte-identical" contract.

There is a parallel async load+gate already here for `namedAgentResolver` (`:265-267`) — `loadNamedAgents(boot.cwd).catch(() => undefined)`, then `size > 0 ? … : undefined`. **The plugin-session mint MUST be async + non-empty-guarded the same way** (it discovers `<cwd>/.quanta/plugins`).

### 3. The overlay→AgentConfig lift (context-binding)

`src/host/runtime/internal/context-binding.ts`:

- The overlay type `RuntimeBootstrapOverlay` declares each optional slot — worktree at `:230-237`, named-agent at `:222-229`, networkProxy at `:217-221`.
- The lift uses `whenDefined(key, value)` (def at `:258`) which spreads `{}` when undefined:
  - `:495` `...whenDefined("networkProxy", args.overlay?.networkProxy)`
  - `:498` `...whenDefined("namedAgentResolver", args.overlay?.namedAgentResolver)`
  - `:502` `...whenDefined("activeWorktreeSlot", args.overlay?.activeWorktreeSlot)`

**Decision:** add a `pluginSession` slot to `RuntimeBootstrapOverlay` and one `whenDefined("pluginSession", …)` lift line, adjacent to `:502`.

### 4. The assembler seam already half-wired (gap #6)

`src/host/runtime/agent-config-assembler.ts:797`:
```ts
autoWirePluginActivation(cfg)
```
docstring `:789-796`. Today this builds its OWN registries internally with `skillRegistry` omitted (`auto-wire.ts`: `createInMemoryPluginRegistry(manifests)` + `createInMemoryPluginMcpRegistry()` + `createIsolatedMcpLauncherPort()`, then `createPluginActivationHandler({ … // skillRegistry intentionally omitted })`). Caller-override-precedence: `if (cfg.activatePlugins !== undefined) return` (`auto-wire.ts`). The `AgentConfig.activatePlugins` field is declared at `types.ts:2204-2207`, and its doc (`:2191-2203`) ALREADY states the lifetime contract: *"the composition root retains the `PluginMcpRegistry` lifetime and calls `shutdownAll()` on session end."*

**Decision:** ticket 02 EXTENDS `autoWirePluginActivation` to take an OPTIONAL injected `{ session }` (carrying the pre-built `skillRegistry` + `pluginRegistry` + `mcpRegistry` from the comp-root). When 07 threads a session onto `AgentConfig.pluginSession`, the assembler passes it through. Absent session ⇒ `auto-wire` is byte-identical to today's no-skill stub (which itself is byte-identical-to-legacy when `.quanta/plugins` is empty). **Key invariant: 07 changes WHO builds the registries (comp-root, with full deps) — it does not change the assembler's short-circuit shape.**

### 5. The lifecycle hook (ticket 03 contract, already documented)

`src/agent/plugin-mcp-launcher/index.ts:12` — *"On session shutdown: `await registry.shutdownAll()`"*; the registry exposes `shutdownAll(): Promise<void>` (`plugin-mcp-launcher/types.ts:86`). 07 owns calling it on session end.

### 6. The knob ratchet

`tests/unit/knob-registry-completeness-ratchet-hellgate.test.ts` (`ORPHAN_CEILING = 0`, `:182`). A new `gateOn(env, "QUANTA_PLUGIN_MODE")` read in `src/` is an orphan UNLESS declared in a registry file (`isDeclarationFile`, `:56-64`: `runtime-config.ts` / `runner/knobs/` / `apps/cli/cli-knobs.ts` / `config/knob-inventory.ts` / `runtime-config-knobs.ts`). Registering it in `knob-inventory.ts` keeps the ceiling at 0.

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
    describe: "Plugin-host mode — enable discovered <cwd>/.quanta/plugins bundles (skills + MCP + routing). Needs a non-empty plugins dir (ticket 07).",
    readSite: "agent/plugin-session/mint.ts",
  },
  ```
- **NOT added** to `runtime-config.ts` / `runtime-config-knobs.ts` (it is a comp-root gate, not a `runtimeConfig()` value — see Risk R5).

### B. The comp-root mint (the mode composition)

A new library helper, `src/agent/plugin-session/mint.ts` (ticket 03 owns the `PluginSession` type + `mintPluginSession`; 07 owns CALLING it at the comp-root). Signature mirrors `mintActiveWorktreeSlot`, but async (it touches disk) and returns the assembled session:

```ts
// ticket 03 defines; ticket 07 wires.
export const mintPluginSession = async (args: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string                 // boot.cwd — session-resolved jail root
  readonly skillRegistry: SkillRegistry // ticket 01/02 — the session's skill registry
  readonly fs?: FilesystemPort
}): Promise<PluginSession | undefined>
```

**Mint predicate (the TWO-condition gate, per 00-index discipline line 7):**

```
gateOn(env, "QUANTA_PLUGIN_MODE")  AND  discoverPlugins(<cwd>/.quanta/plugins).length > 0
  ⇒ build PluginSession
otherwise ⇒ undefined
```

i.e. **gate off OR no plugins ⇒ `undefined` ⇒ everything short-circuits ⇒ byte-identical.** This is exactly the `namedAgentResolver` shape at `runtime-context-compose.ts:265-267` (load, then `size > 0 ? … : undefined`), composed with the worktree gate at `:273`.

When BOTH hold, `mintPluginSession` assembles (consuming the wave-A/B seams):

| Step | Seam consumed | What is built |
|---|---|---|
| 1 | **03** | `pluginRegistry = createInMemoryPluginRegistry(manifests)` (discovery, `plugin-discovery/in-memory-registry.ts:23`) — the enable-state store wraps this with `enable`/`disable`/`isEnabled` (ticket 03's delta over the stateless `lookup`/`list`). |
| 2 | **03** | `mcpRegistry = createInMemoryPluginMcpRegistry()` + `mcpLauncherPort = createIsolatedMcpLauncherPort()` (`plugin-mcp-launcher`) — the registry whose lifetime the comp-root retains (step 7's `shutdownAll`). |
| 3 | **01 + 02** | the `skillRegistry` passed in — which (01) now includes the `plugin` source in `defaultSkillSources` and (02) is the SAME registry the full-deps activation handler binds, so `<plugin>:<skill>` resolves. |
| 4 | **02** | the full-deps activation handler: `createPluginActivationHandler({ pluginRegistry, mcpLauncherPort, mcpRegistry, skillRegistry })` — **with `skillRegistry` injected** (the delta vs. today's omit at `auto-wire.ts`). |
| 5 | **04** | `routingBlock = buildPluginRoutingBlock(pluginRegistry-enabled-view)` — the routing-preference block the prompt renders ("관련 plugin 있으면 우선"). |
| 6 | **05** | `capabilityPolicy = buildPluginCapabilityPolicy(manifests)` — the capability→permission gate dispatch consults. |
| 7 | **06** | the `/plugins` ctx slot — the enable-state store + status view the slash surface lists over. |

`PluginSession` is the bundle of {enabled-state store, activation handler, routing block, capability policy, mcpRegistry (for teardown), `/plugins` view}.

### C. The full assembly order (who builds what, in sequence)

```
comp-root (runtime-context-compose.ts, composeCliRuntimeContext)
  1. boot.cwd resolved (existing)                         ── session jail root
  2. skillRegistry built (existing host path)             ── 01 adds plugin source
  3. pluginSession = await mintPluginSession({            ── 07 NEW
        env, cwd: boot.cwd, skillRegistry })              ── 03 mints, 02/04/05/06 assemble
       └ gate off OR no plugins ⇒ undefined
  4. overlay spread: ...(pluginSession ? { pluginSession } : {})   ── 07 (mirror :158-161)
  5. context-binding lift: whenDefined("pluginSession", …)         ── 07 (mirror :502)
  6. assembler: AgentConfig.pluginSession present ⇒                ── 02 EXTEND
        autoWirePluginActivation(cfg, { session })  passes injected deps
        (absent ⇒ today's zero-arg stub path, unchanged)
  7. per-turn:
       - loop-activation-hook calls cfg.activatePlugins(mentions)  ── existing (02 deps richer)
       - prompt renders pluginSession.routingBlock                 ── 04
       - dispatch consults pluginSession.capabilityPolicy          ── 05
       - /plugins lists pluginSession view                         ── 06
  8. session end: await pluginSession.mcpRegistry.shutdownAll()    ── 07 lifecycle (03 contract)
```

**Load-bearing ordering constraints:**
- skillRegistry (step 2) MUST exist before `mintPluginSession` (step 3) — the session binds it, and the activation handler's skill-step returns `[]` when `skillRegistry === undefined` (`handler.ts:191` `if (registry === undefined) return []`). A session built without it would silently surface no skills (partial-wire — see Risk R1).
- The overlay spread (step 4) and lift (step 5) MUST both be conditional on `!== undefined`, or an `undefined` session leaks a defined-but-empty slot and breaks byte-identity (Risk R2).

### D. Lifecycle (teardown)

The comp-root retains the `PluginMcpRegistry` (per `types.ts:2199` contract). On session end (the same teardown path that disposes other session resources — the bootstrap's dispose/abort sink), 07 adds:

```ts
if (pluginSession !== undefined) await pluginSession.mcpRegistry.shutdownAll()
```

- NO-THROW: wrap so a launcher fault on teardown cannot crash session exit (mirror the comp-root's existing `.catch(() => undefined)` posture at `:265`).
- Absent session ⇒ no registry ⇒ nothing to shut down (no-op). **`shutdownAll()` MUST be called exactly once per minted session** — double-call after a clean shutdown is a no-op by registry contract (`plugin-mcp-launcher/registry.ts:14` "both reset by shutdownAll()"), but the test matrix asserts the single-call path on the normal teardown.

### E. The DEFAULT-OFF byte-identity matrix (the headline deliverable)

The e2e hellgate. For EACH seam below, with `QUANTA_PLUGIN_MODE` unset/off (the no-plugins case is a separate row in §TDD), assert the seam is **byte-identical** to a baseline captured with the plugin tickets reverted-in-spirit (i.e. the slot absent). The assertion is *structural equality of the produced artifact*, not a smoke check.

| # | Seam | Artifact asserted byte-identical when gate OFF | Why it holds (the short-circuit) |
|---|---|---|---|
| M1 | **skill registry** | the resolved skill list / sources from `defaultSkillSources` | 01's plugin source is GATED on the session; no session ⇒ source not added ⇒ same 6 sources (admin/repo/team/user/personal/system) |
| M2 | **activation handler** | `AgentConfig.activatePlugins` is the SAME value (today's auto-wire stub OR `undefined`) | no `pluginSession` ⇒ assembler calls today's `autoWirePluginActivation(cfg)` form; with empty `.quanta/plugins` that already leaves `activatePlugins` per the empty-discovery short-circuit (`auto-wire.ts` `if (manifests.length === 0) return`) |
| M3 | **system prompt** | the assembled system-prompt string (`buildTurnContext` output) | 04's routing block is rendered iff `pluginSession?.routingBlock` is present; absent ⇒ no splice ⇒ byte-identical prompt (loop-activation-hook non-goal already: "does NOT touch `@/agent/prompt`") |
| M4 | **dispatch admissibility** | the dispatch decision for a given `(tool, args)` | 05's capability policy is consulted iff threaded; absent ⇒ dispatch gate path unchanged (no extra precheck) |
| M5 | **/plugins slot** | the slash-command registry (`registry-surface.ts`) command set | 06's `/plugins` is registered iff gated on; gate off ⇒ command absent ⇒ same command set |
| M6 | **MCP launches** | zero plugin MCP servers spawned; no `shutdownAll` scheduled | no session ⇒ no `mcpRegistry` minted ⇒ no spawn, no teardown hook |
| M7 | **AgentConfig surface** | `assembleAgentConfig(req, env)` output with `pluginSession` absent === legacy | the overlay/lift conditional-spread injects NO key when undefined; `whenDefined` spreads `{}` (`context-binding.ts:258`) |

M1–M7 together ARE the proof that 01–06 are inert when the gate is off. The e2e hellgate runs the REAL comp-root twice (gate off vs. a baseline env) and diffs each artifact.

---

## Files

All EXTENDs (no new prod file owned by 07 except the e2e test — ticket 03 owns `plugin-session/`):

| File | Change |
|---|---|
| `src/config/knob-inventory.ts` | **EXTEND** — append `QUANTA_PLUGIN_MODE` to the `HOST` array (shape in §A). Keeps the orphan ratchet at 0. |
| `src/apps/cli/repl/runtime-context-compose.ts` | **EXTEND** — (a) `await mintPluginSession({ env, cwd: boot.cwd, skillRegistry })` near the `mintActiveWorktreeSlot` call (`:273`); (b) conditional overlay spread (mirror `:158-161`); (c) conditional thread into `buildBootstrapContextArgs` (mirror `:288`); (d) the teardown `shutdownAll()` on the dispose path; (e) a `buildBootstrapContextArgs` field doc for `pluginSession` (mirror `:105-110`). |
| `src/host/runtime/internal/context-binding.ts` | **EXTEND** — add `pluginSession?` to `RuntimeBootstrapOverlay` (adjacent to `:237`) + one `whenDefined("pluginSession", args.overlay?.pluginSession)` lift line (adjacent to `:502`). |
| `src/host/runtime/agent-config-assembler.ts` | **EXTEND** — at `:797`, pass the threaded session: `autoWirePluginActivation(cfg, cfg.pluginSession ? { session: cfg.pluginSession } : {})`. (Ticket 02 owns the `AutoWireDeps.session` param + the `skillRegistry` injection; 07 owns the call-site thread. Absent session ⇒ today's zero-arg behavior, unchanged.) |
| `src/agent/types.ts` | **EXTEND** — add `pluginSession?: PluginSession` to `AgentConfig` (the lift target), adjacent to `activatePlugins` at `:2204`. (Type owned by ticket 03; 07 adds the AgentConfig slot.) |

**NOT touched:** `runtime-config.ts`, `runtime-config-knobs.ts` (Risk R5 — comp-root gate, not a typed value).

---

## TDD — red-first hellgate

Write the tests RED first; each must FAIL before the wiring lands, and the byte-identity rows must go RED on injection (a deliberately-broken short-circuit must turn the test red, else the ceiling is vacuous).

1. **gate-on mints session + wires all seams** (`mint-plugin-session.hellgate.test.ts`): with `QUANTA_PLUGIN_MODE=1` and a fixture `.quanta/plugins` (one plugin: a skill + an `.mcp.json` + `plugin.json`), `mintPluginSession` returns a defined `PluginSession` whose: enabled-state store lists the plugin; activation handler resolves `<plugin>:<skill>` (skillRegistry injected — assert NON-empty, the inverse of `handler.ts:191`); routing block is non-empty; capability policy is present; `/plugins` view lists it. RED first (helper/threading absent).

2. **gate-off ⇒ every seam byte-identical — THE MATRIX** (`plugin-mode-byte-identity.hellgate.test.ts`): the M1–M7 table. For each row, capture the artifact with the gate off and assert structural equality to the legacy baseline. Includes the **red-on-injection** guard: a test that deliberately makes the overlay spread unconditional (slot always defined) MUST turn M7 red — proving the matrix is not vacuous.

3. **no-plugins ⇒ byte-identical** (same file): `QUANTA_PLUGIN_MODE=1` but `.quanta/plugins` empty/absent ⇒ `mintPluginSession` returns `undefined` ⇒ all M1–M7 hold. Proves the TWO-condition gate (00-index line 7: "게이트 off **또는** plugins 비면 동일").

4. **shutdownAll on teardown** (`plugin-session-lifecycle.hellgate.test.ts`): with a minted session (spy `mcpRegistry`), the comp-root dispose path calls `shutdownAll()` exactly once; a launcher that throws on shutdown does NOT crash teardown (NO-THROW). Gate off ⇒ no session ⇒ `shutdownAll` never referenced.

5. **knob inventory ratchet green**: `bun test tests/unit/knob-registry-completeness-ratchet-hellgate.test.ts` — the new `gateOn(env, "QUANTA_PLUGIN_MODE")` read in `plugin-session/mint.ts` is declared (orphan count stays at `ORPHAN_CEILING = 0`). RED first: the read added WITHOUT the inventory entry must trip the ceiling (proves the registration is load-bearing).

6. **e2e: real comp-root, both polarities** (`plugin-mode-e2e.hellgate.test.ts`): drive the REAL `composeCliRuntimeContext` over a fixture workspace.
   - **gate-on** (`QUANTA_PLUGIN_MODE=1`, fixture plugin present): the plugin's skill surfaces in the assembled skill set; the routing block is present in the assembled system prompt; `/plugins` lists the plugin; the plugin's MCP server is launched (registry non-empty) and `shutdownAll` is scheduled on teardown.
   - **gate-off** (same workspace, gate unset): NONE of the above — skill absent, no routing block, no `/plugins`, zero MCP launches. This is the e2e arm of the M-matrix (relations through the real surface, not unit fakes).

---

## Slice-fence

- The mint helper lives in `@/agent` (`plugin-session/mint.ts`), NOT `@/apps/cli`, so it stays importable by the unit hellgates without crossing the CLI fence — same reason `mintActiveWorktreeSlot` lives in `@/agent/worktree-slot.ts` (`worktree-slot.ts:48-51`).
- `knob-inventory.ts` is PURE DATA (`@/config`, no imports, no env reads — `knob-inventory.ts:16-18`); the append adds no imports.
- `runtime-context-compose.ts` already imports `@/agent` (`:1-7` — `mintActiveWorktreeSlot`); `mintPluginSession` joins that import. No new slice edge.
- The new `gateOn` read is in `@/agent` (imports `gateOn` from `@/shared`, as `worktree-slot.ts:20` does) — within the existing dependency direction.
- biome `noRestrictedImports` slice-fence: no new cross-slice edge introduced (assembler→`@/agent` and comp-root→`@/agent` both pre-exist).

---

## Risks

- **R1 — partial-wire (one seam minted, others not).** The defining failure mode of an integration ticket: e.g. the session is threaded but `skillRegistry` is NOT injected into the activation handler (today's omit at `auto-wire.ts`), so the plugin's MCP launches but its skills never surface (`handler.ts:191` returns `[]`). Or the routing block is built but the prompt does not render it. **Mitigation:** test #1 asserts ALL six seams in one minted session (skill resolves NON-empty, routing non-empty, capability present, /plugins lists, MCP launches, enabled-state lists) — a single missing wire fails it. The assembly-order table (§C) is the checklist.

- **R2 — defined-but-empty slot leaks (byte-identity break).** If the overlay spread or the lift is unconditional, an `undefined` session injects a defined-but-empty `pluginSession` key, and downstream `?.` guards may diverge (e.g. a prompt branch that checks `pluginSession !== undefined` rather than `pluginSession?.routingBlock`). **Mitigation:** conditional-spread on BOTH the overlay (`runtime-context-compose.ts`) and the lift (`whenDefined`, which spreads `{}` for undefined — `context-binding.ts:258`); the M7 red-on-injection test forces this.

- **R3 — concurrent-session shared-file overlap.** 00-index §작업트리 warns the EXTEND files (`agent-config-assembler.ts`, `runtime-config*.ts`, `registry-surface.ts`) overlap with other in-flight sessions (NEW cluster 16-25: browser/mcp-server/fleet). The assembler `:797` line and `knob-inventory.ts` HOST array are likely contention points. **Mitigation:** before landing, re-check `git status` + diff those files; the assembler change is a single-line argument extension at `:797` (low collision area); `knob-inventory.ts` is an array append (merge-trivial). Do NOT `git add -u` (MEMORY: sweep-commit hazard).

- **R4 — lifecycle double-mint / leaked registry.** If `mintPluginSession` runs and the session is later re-composed (resume / re-bootstrap) without the prior `shutdownAll`, plugin MCP servers leak. **Mitigation:** the comp-root mints ONCE per `composeCliRuntimeContext` and binds teardown to the SAME dispose path; test #4 asserts single-call. Resume paths that re-enter the comp-root get a fresh session + their own teardown (the registry is session-scoped, never shared across sessions — mirrors the worktree slot's per-session shape).

- **R5 — wrong knob home.** Adding a `runtime-config.ts` field + `runtime-config-knobs.ts` entry for a knob that is NEVER read as `runtimeConfig().field` would be dead surface AND would still leave the comp-root `gateOn` read an orphan (the ratchet keys on the READ site, not the field). `QUANTA_WORKTREE_TOOL` proves the correct home for a comp-root gate is `knob-inventory.ts` alone. **Mitigation:** register ONLY in `knob-inventory.ts`; do not touch `runtime-config*.ts`. (If a future need arises to read the flag as a typed value elsewhere, that is a separate read-routing/P4 change.)

- **R6 — vacuous byte-identity ceiling.** A matrix that always passes (because the artifacts are captured identically by construction) proves nothing. **Mitigation:** every matrix row carries a red-on-injection variant (the M7 unconditional-spread case is the canonical one); the e2e #6 gate-on arm proves the seams CAN fire, so the gate-off arm's all-absent assertion is meaningful.

---

## Deps

**Integration ticket — needs 01–06 all green first (wave-C):**
- **01** — `plugin` skill source in `defaultSkillSources` (`skill/registry.ts:61`); 07's M1 + skillRegistry injection depend on it.
- **02** — `autoWirePluginActivation` EXTENDED to accept injected `{ session }` with `skillRegistry` (`auto-wire.ts`); 07 threads the session into the `:797` call.
- **03** — `plugin-session/` slice (`PluginSession` type, `mintPluginSession`, enable-state store, `shutdownAll` lifetime); 07 calls its mint + teardown.
- **04** — `plugin-routing/` block + prompt consumption; 07's M3 + assembly step 5.
- **05** — `plugin-capability-policy.ts` dispatch gate; 07's M4 + assembly step 6.
- **06** — `/plugins` surface + ctx slot; 07's M5 + assembly step 7.

If any of 01–06 is not yet merged, 07's corresponding matrix row + assembly step is unbuildable; do NOT stub them — block on the dep (00-index sequencing: wave-C after wave-A/B green).

**Audit gate:** before any "100% / complete" claim, ≥3 adversarial audits (MEMORY hard-rule), with special suspicion on the byte-identity *synthesis* (the claim that M1–M7 collectively prove inertness) — verify each row's short-circuit is the REAL code path, not an assumed one.
