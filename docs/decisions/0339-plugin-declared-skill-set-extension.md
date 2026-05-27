# ADR-0339 — Plugin-declared skill set extension

Status: accepted
Date: 2026-05-27

## Context

ADR-0336 introduced a closed `PluginManifest` shape with an optional
`skills?: readonly string[]` field — the names of skills a plugin
declares as "should be active when the plugin is active". The field was
defined and parsed, but **not consumed anywhere**: plugin activation
never propagated the list onto the active-skills channel.

The active-skills channel is owned by:

- ADR-0321 typed event `skill_activation { skillId, trigger, at, turnId? }`
  for observability (`@/memory/typed-event` `SkillActivationEvent`).
- ADR-0327 wire seam — `TurnContextInput.activeSkills?: { name; description }[]`
  consumed by `buildTurnContext` and projected onto the
  active-skills block of the system prompt.

We need a primitive that, given a plugin manifest's `skills[]` and a
registry, produces the descriptors to union onto whatever
`activeSkills` the caller already has, AND optionally fires the
ADR-0321 `skill_activation` event per resolved name (trigger source
defaults to `"auto"` — the plugin activation IS the trigger).

## Decision

Two pure primitives in a new leaf slice `src/agent/plugin-skill-extension/`:

```ts
function resolvePluginSkillsForActivation(
  skillNames: readonly string[],
  cfg: PluginSkillExtensionConfig,
  opts?: {
    readonly at?: number
    readonly turnId?: string
    readonly trigger?: "user" | "auto" | "system"
  },
): readonly { name: string; description: string }[]

function unionActiveSkills(
  existing: readonly { name: string; description: string }[] | undefined,
  pluginResolved: readonly { name: string; description: string }[],
): readonly { name: string; description: string }[]
```

`PluginSkillExtensionConfig`:

- `registry: SkillRegistryReadOnly` — ADR-0330 read-only port (NO-THROW
  contract, returns `null` on miss).
- `emit?: (event: SkillActivationEventLike) => void` — optional. Fires
  once per RESOLVED (registry-hit) skill. Missing skills do NOT emit.
  Emit is NEVER awaited; any throw is swallowed.

`SkillActivationEventLike` mirrors `@/memory/typed-event`
`SkillActivationEvent` field-for-field so a composition root can pass
`store.append` directly as the `emit` hook without an adapter — slice
fence: we do not import `@/memory/typed-event`.

### Caller-override precedence

`unionActiveSkills` dedupes by `name`; **caller (existing) entries win
on collision**. Rationale:

- The caller's slice (host config / user-pinned skill / mention-resolver
  injection) is closer to user intent than a plugin's declared list.
- A plugin offering a "preferred" description for a name the caller
  already has must accept the caller's description.
- This is symmetric with ADR-0332's install helper: "a
  caller-pre-populated slot is NEVER overwritten." Plugin extension is
  a **supplement**, not an override.

### Drop-on-miss

Skills in `manifest.skills` that the registry does not know are
silently dropped. A plugin may declare forward-compat skills (the
registry is a session snapshot — ADR-0134), or a typo may slip through
plugin validation. Crashing on first miss would brick the plugin; a
noisy log is the composition root's call, not this primitive's.

### NO-THROW

Both primitives are NO-THROW end-to-end:

- `registry.lookup` throws → entry dropped.
- `emit(event)` throws → swallowed; descriptor still flows through.
- non-array / undefined / malformed input → handled defensively, never
  panics.

A composition-root failure cannot break the agent loop.

### Emit hook integration

Composition-root pattern (illustrative — actual wiring is ADR-0338 +
composition root):

```ts
const pluginResolved = resolvePluginSkillsForActivation(
  manifest.skills ?? [],
  { registry: skillRegistry, emit: store.append },
  { trigger: "auto", at: Date.now(), turnId },
)
const merged = unionActiveSkills(cfg.activeSkills, pluginResolved)
// pass `merged` as TurnContextInput.activeSkills
```

The emit hook receives one `SkillActivationEventLike` per resolved
skill (no event for misses). The local shape is structurally identical
to `SkillActivationEvent`, so `store.append` from the typed-history
store satisfies the signature without adapter.

## Non-goals

- **No composition-root wire.** This ADR ships PRIMITIVES only. The
  activation handler that calls them lives in ADR-0338 (plugin launcher)
  + a composition-root follow-up.
- **No registry mutation.** `SkillRegistryReadOnly` is read-only by
  contract (ADR-0330). The plugin's declared skill names must already
  exist in the registry from the normal discovery path (`@/skill`).
- **No prompt-shape change.** The active-skills block in
  `buildTurnContext` (ADR-0327) is byte-identical; only the
  `activeSkills` ARRAY content changes via the union primitive.
- **No `@/skill` mutation.** The slice depends on
  `@/skill/registry-readonly` (already main) and otherwise has zero
  cross-slice imports.

## Wiring

DEFERRED to the activation handler that lands with ADR-0338's plugin
launcher and the composition-root follow-up. Composition roots that do
not import this barrel get byte-identical legacy behaviour — no plugin
skill is auto-added to `activeSkills`. Default-OFF.

## Slice fence

- Owns: `src/agent/plugin-skill-extension/{types.ts, extender.ts, index.ts}`
  + `__tests__/`.
- Imports from: `@/skill/registry-readonly` (ADR-0330) only.
- Does NOT touch: `src/skill/*`, `src/agent/prompt.ts`,
  `src/agent/types.ts` (AgentConfig), `src/agent/plugin-discovery/*`
  (ADR-0336), `src/memory/typed-event/*`.

## Tests

- `__tests__/extender.hellgate.test.ts` — 14 cases (empty / hit / miss /
  mixed / multi-hit / emit-present / emit-absent / emit-throws /
  registry-throws / trigger / at / turnId / empty+emit / order).
- `__tests__/union.hellgate.test.ts` — 8 cases (both-empty /
  existing-empty / plugin-empty / collision-caller-wins /
  multi-collision-multi-new / description-collision /
  ordering-invariant / undefined-existing).

Total: 22 hellgate cases.
