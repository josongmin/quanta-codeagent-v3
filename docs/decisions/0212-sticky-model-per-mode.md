# ADR-0212: Sticky model-per-mode — fs-backed `{mode → modelId}` store + resolver

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0211 (mode-variant), ADR-0061 (model-swap retry),
  ADR-0185 (file-write-atomic lib-swap), `src/agent/prompt.ts:88`
  (AgentMode SSOT), `src/agent/sticky-model/` (this slice)

## Context

Cline and Roo Code both ship "sticky model per mode": once the user
picks a strong reasoning model for Plan mode and a fast model for Act,
the choice is remembered and re-applied on the next mode switch. v3
today resolves the model from a global default + CLI override; mode
membership is invisible to the resolver, so users re-pick the same
model on every mode switch.

The user's actual pattern (observed across 6,386 Codex sessions —
[codex-session-corpus-calibration]): different modes correlate with
different models. Plan/Review/Audit benefit from deep-reasoning models
(gpt-5-thinking, claude-opus); Editor benefits from fast minimal-diff
models (claude-haiku, gpt-5-mini). Sticky-per-mode preserves that
without re-prompting.

## Decision

Introduce a new slice `src/agent/sticky-model/` with three components:

```
src/agent/sticky-model/
  port.ts             — StickyModelStore + StickyModelResolver (typed Result shapes)
  default-store.ts    — inMemoryStickyModelStore (pure, no IO)
  fs-backed-store.ts  — fsBackedStickyModelStore (~/.quanta/sticky-model.json)
  resolver.ts         — stickyModelResolver (precedence enforcer)
  write-file-atomic.d.ts — local ambient declaration
  index.ts            — slice barrel
```

The store port — TYPED `Result` shapes, no-throw public surface:

```ts
interface StickyModelStore {
  get(input: { mode: AgentMode }): Promise<string | undefined>
  set(input: { mode: AgentMode; modelId: string }): Promise<StickyModelSetResult>
  load(): Promise<StickyModelLoadResult>
}

type StickyModelSetResult = { ok: true } | { ok: false; error: QuantaError }
type StickyModelLoadResult =
  | { ok: true; snapshot: Readonly<Record<string, string>> }
  | { ok: false; snapshot: Readonly<Record<string, string>>; error: QuantaError }
```

The resolver — ONE composition point for precedence:

```ts
const r = stickyModelResolver(store)
const modelId = await r.resolve({
  mode: "plan",
  globalDefault: "gpt-5",
  explicitOverride: cliFlag,  // optional
})
```

Precedence (highest first):
1. `explicitOverride` — caller-supplied (CLI `--model`, slash arg)
2. sticky store entry — what the user picked last time for this mode
3. `globalDefault`     — env / project default

`globalDefault` is REQUIRED; the resolver never returns `undefined`.

## Persistence

`fsBackedStickyModelStore` writes to a single JSON file at
`~/.quanta/sticky-model.json` (configurable via opts). Writes go through
`write-file-atomic` (the same lib ADR-0185 swapped into LSP) so a
crashed mid-write cannot corrupt the file — the lib writes to a sibling
`.tmp.<rand>` and `rename(2)`-promotes (atomic on the same filesystem).

Read-modify-write semantics on `set()`: load current snapshot, splice
the new entry, atomically replace. Concurrent `set()`s to different keys
are last-write-wins on the rename — by-design, the store's contract is
"best effort persistence" and the resolver falls back to the global
default on any read failure.

## Corruption posture

A load that yields invalid JSON or a non-object top-level value resolves
to `ok:false` with `StickyModelLoadCorruptionError`. The store does NOT
auto-truncate — a subsequent `set()` will overwrite the corrupt file
atomically, but until then the corrupt bytes stay on disk for forensic
inspection. Matches the Codex `logs_2.sqlite` retention discipline:
never silently destroy user data.

## Consequences

- **Default-OFF**: no caller is required to migrate. Hosts that do not
  wire a `StickyModelStore` keep their current global-default behavior
  unchanged. Wire is a single line at the composition root.
- **Closed port**: `StickyModelStore` is a structural interface; tests
  inject hand-rolled stores. The in-memory + fs-backed defaults cover
  the common cases without exposing the IO layer to higher slices.
- **No-throw**: every public method either returns a value or a typed
  `Result`. The resolver path NEVER throws — callers can safely fold it
  into prompt-build / CLI parsing.
- **Cache miss on mode switch**: changing the active model invalidates
  the per-provider prefix cache (different model = different cache).
  That is the user's choice — they explicitly opt into different models
  per mode.
- **Negative invariants** (locked by hellgate):
  - HELL-SM-04/05: corrupt file does NOT throw, surfaces typed error,
    `get()` returns `undefined`.
  - HELL-SM-06: concurrent set's do NOT produce a torn file.
  - HELL-SM-07: missing parent dir is created on set.
  - HELL-SM-10..13: resolver precedence is fully tested.
  - HELL-SM-14: ENOENT on first read is treated as empty (NOT corruption).
