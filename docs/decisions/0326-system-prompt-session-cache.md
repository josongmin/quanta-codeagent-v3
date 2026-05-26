# ADR-0326 — System prompt session-level cache

Status: Accepted
Date: 2026-05-27

## Context

Codex enforces the "static system prompt is read once per session" invariant
**in code**. Every sampling request inside a turn calls

```rust
// codex-rs/core/src/turn.rs:923
let base_instructions = sess.get_base_instructions().await
```

but `get_base_instructions()` reads a value populated ONCE at session start
(`codex-rs/core/src/session.rs` ~555, when the session configuration is
materialised) and never re-derived. Every call after the first is a cache
hit; the assembly function is never re-run inside a turn.

Quanta absorbs the same invariant via PASSIVE audit (ADR-0322) — the
`buildSystemPrompt` sources (`INTRO_LINES`, persona, identity slot,
prompt-pack body) are compile-time string arrays with no clock, no random,
no per-turn input — so the cached prefix is byte-stable BY CONSTRUCTION.
However:

1. Every iteration of the turn loop still re-runs the full assembly:
   `src/agent/loop.ts:816` (proactive summarizer) and
   `src/agent/loop.ts:966` (per-turn context build) both flow through
   `buildTurnContext`, which calls `buildSystemPrompt()` unconditionally
   at `src/agent/prompt.ts:398`:

   ```ts
   const basePrompt = input.system ?? buildSystemPrompt()
   ```

   The work is cheap (a few string concats), but it is not zero, and the
   absence of a cache MAKES it possible for a future regression to fold
   per-turn data into the static path without anyone noticing — exactly
   the failure mode ADR-0322 worried about.

2. `buildSystemPrompt` is a SYNCHRONOUS arrow returning `string`
   (`src/agent/prompt.ts:40-70`): no `await`, no IO, no promise shape.
   That fixes the port surface: a sync `getOrBuild(key, factory: () =>
   string): CachedPrompt`. An async `buildSystemPrompt` would warrant a
   separate port (the wire-up surface differs).

This ADR provides the missing CODE-LEVEL enforcement primitive — a
closed port + default in-memory adapter + opt-in strict drift detector —
without touching any production wiring. The follow-up ADR will wire it
into `buildTurnContext`.

## Decision

1. Add a new slice `src/llm/system-prompt-cache/` containing:

   - `types.ts` — `SystemPromptCacheKey` (branded string),
     `CachedPrompt`, `InvalidationReason` (closed 3-variant union),
     `CacheStats`, `DriftDetectedError`.
   - `port.ts` — the closed `SystemPromptCachePort` interface (5
     methods: `getOrBuild`, `peek`, `invalidate`, `clearAll`, `stats`).
   - `hash.ts` — `sha256Hex(content)` via `node:crypto` (same shape as
     ADR-0322's hash helper, so cross-checks are cheap).
   - `in-memory-cache.ts` — `createInMemorySystemPromptCache(opts?)` —
     default adapter, `Map`-backed, single-threaded, no LRU. Clock seam
     via `opts.now`.
   - `drift-detector.ts` — `makeStrictDriftCache(inner)` — wrapping
     adapter that re-runs the factory on every HIT and asserts the
     freshly-built text's hash matches the cached `contentHash`. Throws
     `DriftDetectedError` on mismatch. Default-OFF in production.
   - `index.ts` — barrel re-export.

2. The port contract is closed:

   - **`getOrBuild`** — hit ⇒ return cached, factory NOT called,
     `hits++`. Miss ⇒ call factory, store, return, `misses++`. Factory
     throw ⇒ state unchanged, throw propagates.
   - **`peek`** — read-only; hit ⇒ cached; miss ⇒ `null`. NEVER calls
     factory, NEVER bumps counters.
   - **`invalidate`** — drop one entry. Idempotent. `invalidations`
     bumps once per non-no-op call. `reason` is observability-only.
   - **`clearAll`** — drop every entry. `invalidations` += dropped
     count. No-op on empty cache.
   - **`stats`** — returns a counter snapshot at the moment of call.

3. The strict drift detector turns ADR-0322's PASSIVE audit into an
   ACTIVE invariant for callers who opt in. It pays the cost of
   re-running the factory on every hit in exchange for fail-fast
   detection of "a future regression folded per-turn data into the
   cached prompt". It is NOT wired into production today.

## Non-goals

- **Production wire-up is NOT in this ADR.** A follow-up ADR will
  inject the cache port into `buildTurnContext` so the static-prompt
  assembly only runs once per session. This ADR ships the port + adapter
  only; existing callers and their byte-stable cached prefixes are
  untouched.
- **Persistence is NOT in scope.** The cache is process-local. A
  cross-process / disk-backed cache would be a different adapter behind
  the same port (or a new port if the surface needs widening).
- **Cross-session sharing is NOT in scope.** Each `SystemPromptCacheKey`
  identifies ONE session; the cache cannot merge entries across keys.
- **Async `buildSystemPrompt` is NOT in scope.** The current function is
  sync (`src/agent/prompt.ts:40-70`). If it ever becomes async, a
  separate ADR will define an async-shaped port — wrapping the sync
  port in a promise here would hide the change.
- **Concurrency primitives are NOT in scope.** The single-threaded Node
  event loop suffices. Worker-thread / multi-process scenarios would
  use a different adapter.

## Implementation

New files under `src/llm/system-prompt-cache/`:

- `types.ts` — 5 type exports + 1 error class + 1 brand minter
  (`asCacheKey`).
- `port.ts` — 1 interface, sole export.
- `hash.ts` — `sha256Hex` via `node:crypto`.
- `in-memory-cache.ts` — `createInMemorySystemPromptCache(opts?)` +
  `InMemorySystemPromptCacheOptions` (`now` + `onInvalidate` hook).
- `drift-detector.ts` — `makeStrictDriftCache(inner)`.
- `index.ts` — barrel.

Hellgate at `src/llm/system-prompt-cache/__tests__/`:

- `in-memory-cache.hellgate.test.ts` — 14 cases covering empty miss,
  hit-no-factory, multi-key independence, factory-throw atomicity,
  invalidate, no-op invalidate, clearAll counter, precise stat
  bookkeeping, peek-hit/no-counter-change, peek-miss-null, hash
  determinism, 50 KB hash stability, clock-seam, onInvalidate hook.
- `drift-detector.hellgate.test.ts` — 6 cases covering hit+stable,
  hit+drift-throws, miss-no-double-build, non-strict baseline, error
  message shape, invalidate/clearAll/stats passthrough.
- `port-contract.test.ts` — compile-time port shape pin
  (5-method surface, 3-variant `InvalidationReason`, `CachedPrompt` /
  `CacheStats` shapes, factory return types, brand contract).

Slice fence: the module imports ONLY `node:crypto` (in `hash.ts`). No
imports from `@/agent/prompt`, `@/llm/cache-control-audit`, or any
other slice — those are FUTURE callers, never collaborators. The biome
slice-isolation rules at `biome.json` lines 56-78 forbid `@/agent` /
`@/tool` / `@/memory` / `@/storage` / `@/stream` / `@/permission` /
`@/runtime` / `@/lsp` / `@/observability` imports from inside `src/llm`
— this slice complies trivially (zero cross-slice imports).

## Follow-up

- **Wire-up ADR**: inject a `SystemPromptCachePort` instance into
  `buildTurnContext` (`src/agent/prompt.ts:397`) so the
  `input.system ?? buildSystemPrompt()` line becomes
  `input.system ?? cache.getOrBuild(input.sessionKey, buildSystemPrompt).text`.
  This requires threading a session key through `TurnContextInput` —
  the input type already carries enough session-static fields that
  adding one more is mechanical.
- **Strict mode under bench replay**: the replay harness can install
  `makeStrictDriftCache(...)` instead of the bare adapter, turning
  every replay run into an active drift assertion. Cheap (replay is
  already deterministic) and catches regressions ADR-0322's passive
  audit cannot.
- **Counter surfacing**: a `cache.stats()` reading per turn can ride
  into `src/observability` once the wire-up lands, so dashboards can
  graph hit-rate. Out of scope for this slice.

## References

- Codex: `codex-rs/core/src/turn.rs:923` (cache-hit call site),
  `codex-rs/core/src/session.rs` ~555 (cache-population call site).
- Quanta: `src/agent/prompt.ts:40-70` (synchronous `buildSystemPrompt`
  signature), `src/agent/prompt.ts:398` (the call to be wrapped),
  `src/agent/loop.ts:816` + `src/agent/loop.ts:966` (the two
  `buildTurnContext` call sites that re-run the assembly per turn).
- ADR-0322 — Cache-control thread-stability audit (passive sibling).
- ADR-0319 — Typed history event store (closed-port pattern reference).
