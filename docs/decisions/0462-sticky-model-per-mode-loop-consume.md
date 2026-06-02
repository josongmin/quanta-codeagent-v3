# ADR-0462 — sticky-model-per-mode: loop consume site (dead-seam → live)

**Status:** Accepted (2026-06-03)
**Type:** Structural wiring slice (activates an existing dead seam).
**Scope:** `src/agent/loop.ts` (one helper `readStickyModelForMode`, one new
parameter on `resolveSkillTurnOverride`, one import of `resolveAgentMode`) +
the hellgate `tests/integration/loop-sticky-model.test.ts`. No other files
touched.
**Default-OFF:** a config with NO `stickyModelStore` produces a byte-identical
turn — the helper returns `undefined` and `resolveSkillTurnOverride` runs its
pre-ADR skill-only path unchanged.

ADR-number note: 0459 and 0460 were the highest existing decisions; this slice
took the next clearly-free number, 0461.

## Context

`AgentConfig.stickyModelStore` (ADR-0212 store + ADR-0236 composition-root
publish) was a **dead seam**. A prior dead-seam audit confirmed:

- **Publish site LIVE** — `src/apps/agent/index.ts` (`resolveStickyModelStore`)
  constructs an fs- or in-memory-backed `StickyModelStore` and publishes it on
  `AgentConfig.stickyModelStore` when configured.
- **Consume site NONE** — no loop code ever called `store.get(...)`, so a sticky
  per-mode model selection (`"use gpt-5 for plan mode"`) never actually swapped
  the LLM. The store could be written (e.g. by a future `/sticky-model` slash)
  but the loop ignored it.

The store port (`src/agent/sticky-model/port.ts`) is keyed by `AgentMode`:
`get({ mode }) → Promise<string | undefined>`. `get` is **no-throw by contract**
(IO / corruption errors resolve `undefined` rather than reject; they surface via
`load()` for observers). The id-returned is a model id — NOT a port — so the
loop must resolve id → port the same way the skill override already does.

The loop ALREADY has an id → port swap: `resolveSkillTurnOverride`
(`src/agent/loop.ts`) swaps `config.llm` for `config.modelCandidates.find(c =>
c.id === override.model).port` when the active skill declares `model:`. This is
the SAME mechanism a sticky swap needs — there must be exactly one id → port
resolver and one candidate registry.

## Decision

Wire the sticky model into the **existing** per-turn LLM-resolution point,
reusing the **existing** id → port resolver. No new LLM factory.

1. **Read** — at the top of `streamConsume` (the per-turn LLM-resolution point,
   `src/agent/loop.ts`, immediately before `resolveSkillTurnOverride` is called)
   read the sticky model for the active mode via a tiny helper:

   ```ts
   const readStickyModelForMode = async (config) =>
     config.stickyModelStore === undefined
       ? undefined
       : config.stickyModelStore.store.get({
           mode: resolveAgentMode(config.mode, config.planMode),
         })
   ```

   - Keyed by `resolveAgentMode(config.mode, config.planMode)` — the SAME mode
     precedence the prompt + dispatch seam use, so the prompt posture, the
     dispatch posture, and the sticky lookup never disagree on "the active mode".
   - Re-read **every turn** against the CURRENT mode, so a mid-session mode
     change (plan → default) picks up the new mode's sticky on its next turn.
   - `await`ed in the already-`async` `streamConsume`; no new globals, no clock.

2. **Resolve with explicit precedence** — `resolveSkillTurnOverride` gains an
   optional `stickyModelId?: string` parameter and folds it into the swap:

   ```ts
   const swapped =
     override?.model !== undefined
       ? resolvePort(override.model)   // skill DEMAND wins outright
       : resolvePort(stickyModelId)    // sticky DEFAULT only when no skill demand
   const llm = swapped ?? config.llm   // unresolvable id ⇒ default
   ```

   where `resolvePort(id) = config.modelCandidates?.find(c => c.id === id)?.port`
   — the EXACT resolver the skill override already used (extracted to a local so
   both call it; one registry, no duplicate factory).

### Precedence: `skill override > sticky > default` (and why)

- **Skill override is a per-skill DEMAND**: a skill author declared "I need this
  specific model to do my job." It must win.
- **Sticky is a session-level DEFAULT**: the user said "prefer this model for
  this mode." It must never silently override a skill that explicitly asked for
  a different model.
- A skill that declares an **unknown** model degrades to `config.llm` (the global
  default), **NOT** to the sticky — the skill expressed intent for a *specific*
  model, so the documented degrade is "default," not "whatever the session
  prefers." Concretely: if `override?.model !== undefined`, sticky is **never**
  consulted, even when the skill id is unresolvable.

Effort precedence is untouched (skill > session > default).

## Default-OFF / byte-identical proof

- No `stickyModelStore` ⇒ `readStickyModelForMode` returns `undefined` ⇒
  `resolveSkillTurnOverride(config, override, undefined)` takes the
  `override?.model !== undefined ? resolvePort(override.model) : resolvePort(undefined)`
  branch; `resolvePort(undefined)` is `undefined`, so `swapped` and the final
  `llm` are byte-identical to the pre-ADR skill-only expression.
- Hellgate case (5) is the regression anchor: store absent ⇒ every turn streams
  from the base port, sticky candidate never runs.

## Consequences

- A wired `stickyModelStore` now actually swaps the LLM per mode — the seam is
  live.
- One extra `await store.get()` per turn when a store IS wired. The in-memory
  store is a Map read; the fs-backed store reads a small cached JSON. No-throw,
  so a disk error degrades to the default silently (and is observable via
  `load()`).
- `streamConsume` cognitive complexity unchanged (the read is a helper call), so
  no new biome warning.

## Honest deferred

- **No `/sticky-model` slash** to SET a sticky from the CLI — out of scope
  (`src/apps/cli/*` and `src/permission/*` are not this slice's files). The
  store can already be seeded at the composition root; a slash to mutate it
  per-session is a follow-up.
- **Sticky model id is not surfaced in `/status`** — the type doc anticipates
  it; wiring the surface is a separate slice.
- **No effort sticky** — only the MODEL is sticky-per-mode here; a sticky effort
  tier per mode is a possible sibling but not requested.

## Test

`tests/integration/loop-sticky-model.test.ts` — 6 cases, deterministic scripted
LLM doubles + in-memory store, no network:

1. sticky for active mode → loop streams from the sticky candidate port;
2. no sticky for active mode → default base port (no swap);
3. unresolvable sticky id → default base port, no crash (advisory degrade);
4. skill override + sticky BOTH set → skill wins (precedence proven);
5. store ABSENT → byte-identical regression anchor (base port only);
6. mode change (plan) → reads the sticky for the NEW active mode (keyed read).
