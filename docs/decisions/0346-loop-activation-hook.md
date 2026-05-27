# ADR-0346 — Loop hook for plugin activation trigger

## Status
Accepted. Slice landed (`src/agent/loop-activation-hook.ts` +
2 helper imports + 1 invocation site in `src/agent/loop.ts`
`prepareTurnContext`). Closes the dangling invocation seam from ADR-0340
and the dangling `.mcp.json` launch-on-mention trigger from ADR-0338
follow-up #3.

## Context

ADR-0340 introduced the `AgentConfig.activatePlugins?` closure that wires
together:

- ADR-0336 `PluginRegistryPort.lookup` (id → manifest)
- ADR-0338 `launchPluginMcpServers` (manifest → MCP handles)
- ADR-0339 `resolvePluginSkillsForActivation` + `unionActiveSkills`
  (skills[] → ActiveSkillDescriptor[])

ADR-0340 deliberately stopped one step short: it set up the slot on
`AgentConfig` but left **invocation per turn** to the caller. The
ADR-0340 status section explicitly notes the loop-side hook was deferred
because `loop.ts` was user-in-flight at the time and the composition
root was the safer surface.

As a result, even a session that wires `cfg.activatePlugins` to a fully
configured handler **does not actually activate any plugin on mention**.
The closure is reachable, but nothing calls it. The same dangling state
applies to ADR-0338 follow-up #3: the MCP-server launcher is exercised
by the activation handler, so until something calls the activation
handler per turn, the launcher never fires either.

## Decision

Add a single-purpose helper module — `src/agent/loop-activation-hook.ts`
— that the agent loop's `prepareTurnContext` calls once per attempt,
BEFORE `buildTurnContext`. The helper:

1. No-ops if `cfg.activatePlugins` is absent.
2. Reads the last user-role text from working memory (mirroring the
   ADR-0327 mention-injection path's gating).
3. Parses mentions via `@/agent/mention-injection.parseMentions`.
4. Calls `cfg.activatePlugins(mentions, { turnId })` if any mention
   parses, swallowing thrown errors (NO-THROW invariant).
5. Returns `{ resolvedSkills }` — handles stay owned by the
   composition root's `PluginMcpRegistry` (ADR-0338 lifetime contract).

A second exported helper, `augmentActiveSkillsWithPlugin`, unions those
plugin skills with the caller's `activeSkills` via `unionActiveSkills`
(ADR-0339, caller-wins on name collision) and projects the result back
into the mutable `{ name; description }[]` shape that
`TurnContextInput.activeSkills` expects. On the empty path (no plugin
resolved) the helper returns the caller's `activeSkills` reference
**verbatim** — same identity, no allocation — so the byte-identical
legacy invariant holds for skill-less sessions.

`prepareTurnContext` gains exactly two new lines:

```ts
const pluginActivation = await resolvePluginActivationForTurn(
  config,
  latestUserTextFromWm(wm),
  `t${turn}`,
)
const augmentedSkills = augmentActiveSkillsWithPlugin(activeSkills, pluginActivation)
```

…plus a one-symbol swap (`activeSkills` → `augmentedSkills`) inside the
existing optional-spread that feeds `buildTurnContext`. The rest of the
function body is unchanged.

### Why option B (separate module)?

Two reasons:

1. **Slice fence.** The new logic depends on
   `@/agent/mention-injection`, `@/agent/plugin-activation-handler`, and
   `@/agent/plugin-skill-extension`. Inlining all of that in `loop.ts`
   broadens the latter's import surface further; an isolated module is
   the SOLID-clean placement.
2. **User in-flight `loop.ts`.** The user is independently modifying
   `loop.ts` + `prompt.ts` this sprint. Restricting the loop-side
   change to two imports + 4 lines inside `prepareTurnContext` keeps
   merge conflict risk minimal. The actual logic lives in the new
   module, where there is no in-flight contention.

## Consequences

### Positive

- Composition roots that opt in by setting `cfg.activatePlugins` now
  get per-turn activation **for free** — no extra surface code, no
  per-surface wiring loop.
- ADR-0340's "dangling" invocation seam closes.
- ADR-0338 follow-up #3 (`.mcp.json` launch on mention) closes
  transitively — the activation handler the composition root supplies
  already invokes the launcher, so once this hook fires the launch
  happens.
- Default-OFF guarantee preserved at three layers:
  (a) absent `cfg.activatePlugins` ⇒ helper short-circuits with frozen
  empty sentinel,
  (b) empty / non-user-tail working memory ⇒ activator NOT called,
  (c) zero mentions parsed ⇒ activator NOT called.
- A misconfigured activator (throws, returns malformed shape) cannot
  break the turn — NO-THROW + defensive narrowing.

### Negative

- One extra `await` per turn even on the default-OFF path. The
  short-circuit is the very first check in the helper (a single
  property read), so the overhead is essentially a microtask hop. We
  judge this acceptable; the alternative — a sync entry that switches
  to async only on the active path — would require fragmenting the
  helper's signature for negligible gain.
- The helper allocates a single fresh array on the active path because
  `unionActiveSkills` returns `readonly` but `TurnContextInput.activeSkills`
  is mutable (pre-readonly legacy shape). One allocation per turn per
  plugin-mention is well within budget.

## Non-goals

- **No `prompt.ts` mutation.** `buildTurnContext` already accepts
  `activeSkills` as an optional input. We swap the value we pass in;
  the renderer is unchanged.
- **No `AgentConfig` mutation.** No new slot. ADR-0340's
  `activatePlugins?` is the single switch.
- **No MCP-handle lifetime ownership.** The activation handler the
  composition root supplies retains handles in the
  `PluginMcpRegistry` (ADR-0338). The hook reads `resolvedSkills` and
  intentionally discards `handles`.
- **No per-turn deduplication beyond what `unionActiveSkills`
  provides.** If the same mention re-appears in user text on a later
  turn, the activation closure is responsible for idempotency. ADR-0340
  composite activation already handles this (launcher is idempotent
  per `(pluginId, serverName)`, skill resolver dedupes by name).

## Wiring

A composition root that has already set up an `ActivationHandler` per
ADR-0340 needs **no additional code** beyond setting the
`cfg.activatePlugins` slot — the loop hook is automatic:

```ts
const handler = createPluginActivationHandler({ pluginRegistry, ... })
cfg.activatePlugins = (mentions, opts) =>
  activatePluginsFromMentions(mentions, handler, opts)
// The loop now calls this once per turn after parseMentions.
```

Composition roots that do NOT set the slot remain byte-identical to
pre-0346 behavior.

## Tests

Hellgate: `tests/unit/loop-adr-0346-activation-hook-hellgate.test.ts`
(10 cases / 20 expects):

1. Absent `activatePlugins` ⇒ canonical-empty (legacy passthrough).
2a. Undefined user text ⇒ activator NOT called.
2b. Empty user text ⇒ activator NOT called.
3. Zero mentions parsed ⇒ activator NOT called.
4. Plugin mention parsed ⇒ activator called with `{ mentions, opts.turnId }`,
   resolvedSkills propagate.
5. Activator throws ⇒ swallowed, empty result (NO-THROW).
6. Activator returns malformed shape ⇒ defensive empty.
7. Union semantics — caller-wins on collision, plugin appends fresh
   (asserts the contract the loop depends on).
8. `turnId === undefined` ⇒ `opts` argument is `undefined` (no stray
   `{ turnId: undefined }`).
9. Empty sentinel is the SAME frozen array across calls — defence
   against allocation churn on the default-OFF path.

Regression: `prompt-adr-0327-wire-hellgate.test.ts` +
`working-loop.test.ts` + the plugin-activation / plugin-skill-extension
/ mention-injection slice tests all stay green.

## Slice fence

- New module: `src/agent/loop-activation-hook.ts` (leaf — no
  `loop`/`prompt`/`dispatch` imports).
- `src/agent/loop.ts` deltas: 4 lines added (2 imports, 1 await + 1
  augment call inside `prepareTurnContext`) + a 1-symbol swap of the
  value passed as `activeSkills` to `buildTurnContext`.
- New test: `tests/unit/loop-adr-0346-activation-hook-hellgate.test.ts`.
- No mutation of `@/agent/prompt`, `@/agent/types`,
  `@/agent/plugin-activation-handler`, `@/agent/plugin-skill-extension`,
  `@/agent/mention-injection`.
