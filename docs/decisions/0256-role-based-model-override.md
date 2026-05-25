# ADR-0256: Role-based model override — `{role → modelId}` resolver (Roo orchestrator absorption)

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0212 (sticky model-per-mode), ADR-0247 (agent nickname pool +
  role enum), `src/llm/role-model-override/` (this slice)

## Context

Roo Code's `orchestrator` exposes a per-role model selector — `plan-writer`
uses a deep-reasoning model (o1, claude-opus), the actual `executor` uses
a fast minimal-diff model (claude-haiku, gpt-5-mini), `reviewer` and
`explorer` likewise. Different sub-tasks within a single turn benefit from
different models. The user picks once per role; subsequent dispatches of
the same role re-use that pick.

ADR-0212 already gives us mode-sticky model resolution (mode → modelId,
persisted to `~/.quanta/sticky-model.json`). That axis is the user's
**workflow phase** (plan / audit / review). ADR-0256 adds an orthogonal
axis — the **dispatched role** within whichever phase is active.

Without this slice an orchestrator that wants "spawn an explorer at gpt-5,
spawn an executor at claude-haiku-3.5" has to special-case at every spawn
site. The resolver centralizes the lookup so the spawn site only knows
"give me the model for role X".

## Decision

Introduce `src/llm/role-model-override/` with four files:

```
src/llm/role-model-override/
  types.ts             — Role union + ModelId alias + OverrideError
  port.ts              — RoleModelResolver interface (closed port)
  default-resolver.ts  — defaultRoleModelResolver (Map-backed + fallback)
  index.ts             — slice barrel
```

The role enum (closed union — adding a new role is a compile-failure
forcing function so every host updates its switch):

```ts
type Role = "plan-writer" | "executor" | "reviewer" | "explorer" | "default"
```

The resolver port:

```ts
interface RoleModelResolver {
  resolve(role: Role, defaultModel: ModelId): ModelId
  setOverride(role: Role, modelId: ModelId): SetOverrideResult
  clearOverride(role: Role): void
  listOverrides(): Readonly<Record<string, ModelId>>
}

type SetOverrideResult = { ok: true } | { ok: false; error: OverrideError }
```

Precedence (highest first):
1. ADR-0212 sticky model — if the caller has ALREADY resolved a sticky
   modelId, that wins (sticky is composed OUTSIDE this resolver and
   passed as `defaultModel`).
2. Role override — what was last set via `setOverride(role, …)`.
3. `defaultModel` argument — caller-supplied fallback.

`defaultModel` is REQUIRED. The resolver NEVER returns `undefined` —
unknown roles silently fall through to the default (no throw). The only
error path is `setOverride` with an empty modelId, which surfaces
`OverrideError` via the typed `SetOverrideResult` — symmetric with the
ADR-0212 `StickyModelSetResult` shape.

## Composition with ADR-0212 (sticky model)

Sticky-model and role-override are independent axes:

```ts
// Composition root (CLI / daemon / IPC):
const stickyModelId = await stickyResolver.resolve({ mode, globalDefault })
const effectiveModelId = roleResolver.resolve(role, stickyModelId)
//                       ^^^^^^^^^^^^^^^^^^^^^ sticky wins when no role override
//                                             role override wins otherwise
```

HELL-RM-14 locks this — sticky-model passed as `defaultModel` is
preserved when no role override is set; role override beats sticky when
both are set (sub-task autonomy > workflow phase).

## Consequences

- **Default-OFF**: hosts that do not construct a `RoleModelResolver` keep
  their current single-axis (sticky or global default) resolution
  byte-identical. Wire is a single line at the composition root.
- **Closed port**: `RoleModelResolver` is a structural interface — tests
  inject hand-rolled resolvers. The default Map-backed impl is the only
  shipped surface.
- **Pure (sync)**: unlike `StickyModelStore`, role overrides are
  in-memory only (per-process). Persistence is a separate concern — if
  a future ADR wants fs-backed role overrides, it extends this slice
  with an `fsBackedRoleModelStore` that satisfies the same port.
- **No-throw**: `resolve` and `clearOverride` never throw; `setOverride`
  surfaces empty-modelId rejection via `SetOverrideResult`.
- **Frozen list**: `listOverrides()` returns `Object.freeze`'d snapshot
  — callers cannot mutate the internal Map by reference.

## Negative invariants (locked by hellgate `role-model-override-hellgate.test.ts`)

- HELL-RM-05: empty modelId on `setOverride` → typed error, NOT silent
  accept (would poison subsequent resolves with `""`).
- HELL-RM-06: unknown role on `resolve` → fall through to default, NOT
  throw (callers must be safe to pass any string at the type-erased
  boundary, e.g. JSON-RPC).
- HELL-RM-08: default-OFF — without `roleResolver`, the byte-identical
  current behavior is preserved (the resolver is opt-in).
- HELL-RM-10: `listOverrides()` returned object is frozen.
- HELL-RM-12: `resolve` is pure (no side effects, no Date.now, no IO).
- HELL-RM-14: ADR-0212 sticky composition — sticky modelId passed as
  `defaultModel` is preserved when no role override exists.
- HELL-RM-15: `clearOverride(role)` removes the entry so subsequent
  `resolve` falls through to default.
