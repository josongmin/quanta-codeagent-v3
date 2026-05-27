# ADR-0345 — Session-keyed resource registry (in-memory store/cache reuse)

## Status
Accepted. Registry slice + tests landed. Composition-root adoption (a 1-line swap at `apps/agent/assemble.ts:167` and sibling assembly points) intentionally deferred to a follow-up so the user's in-flight surface work is not invaded.

## Context

`assembleAgentConfig` (and every other composition root that calls `installCodexR2Wires`) currently allocates fresh in-memory containers on every call:

```ts
installCodexR2Wires(cfg, {
  sessionId,
  systemPromptCache: createInMemorySystemPromptCache(),  // ← fresh
  store: createInMemoryTypedHistoryEventStore(),         // ← fresh
  …
})
```

Same-`sessionId` revisits (session restart, control-op resume, repeated assembly under one process) therefore observe:

- **Zero prior typed-history events** — every `context_update / mode_change / repo_rules_change / skill_activation / reasoning_echo / compaction_event` accumulated by the prior assemble call is unreachable.
- **Zero system-prompt cache hits** — the new `SystemPromptCachePort` starts empty even though the same `sessionId` was just warm.

Both regressions are silent — the loop runs, the model gets a system prompt, the observability surface just shows misses where there should be hits.

## Decision

Ship `src/agent/session-resource-registry/` — a leaf slice exposing one factory:

```ts
createInMemorySessionResourceRegistry(cfg?: RegistryConfig): SessionResourceRegistry
```

The port:

```ts
interface SessionResourceRegistry {
  getOrCreate(sessionId: string): SessionResources   // idempotent (same id ⇒ same ref)
  peek(sessionId: string): SessionResources | null   // read-only
  evict(sessionId: string): void                     // idempotent
  size(): number
  clear(): void
}

interface SessionResources {
  readonly store: TypedHistoryEventStore
  readonly cache: SystemPromptCachePort
}
```

Composition roots that adopt the registry replace the fresh-each-call factory with one cached lookup:

```ts
const resources = registry.getOrCreate(sessionId)
installCodexR2Wires(cfg, {
  sessionId,
  store: resources.store,
  systemPromptCache: resources.cache,
  /* other deps unchanged */
})
```

### Scope (in-memory only)

Process-local. NOT covered by this ADR:

- Cross-process / cross-host sharing (Redis-class — separate ADR).
- Disk persistence (sqlite / jsonl — separate ADR; see Codex `logs_2.sqlite` retention pattern memory `codex-logs-retention-pattern`).
- Distributed locks / concurrent writers.

Single-process / single-user fits the current quanta deployment model (CLI + tauri + headless web daemon are each one OS process).

### LRU policy

When `maxEntries` is set, every `getOrCreate` runs:

1. TTL sweep (see below).
2. Lookup → hit ⇒ bump `lastTouched` to `now()` and return existing ref.
3. Miss ⇒ mint fresh `{ store, cache }`, insert with `lastTouched = now()`.
4. LRU sweep: while `size > maxEntries`, drop the entry with the OLDEST `lastTouched`.

`lastTouched` advances on `getOrCreate` ONLY — `peek` is deliberately read-only so that observability surfaces ("is this id warm?") cannot influence the LRU order. The existing `SystemPromptCachePort.peek` (`src/llm/system-prompt-cache/port.ts:62-63`) takes the same stance; we follow.

Absent `maxEntries` ⇒ unbounded growth. Caller responsibility.

### TTL policy

When `idleTtlMs` is set, every `getOrCreate` AND `peek` first runs a sweep:

- For each entry, if `now() - entry.lastTouched >= idleTtlMs`, evict.

TTL pruning runs BEFORE the LRU sweep in `getOrCreate`, so expired entries are dropped before the working-set cap kicks in. The boundary is `>=` (inclusive) — at exactly `lastTouched + idleTtlMs`, the entry is considered expired and removed.

Absent `idleTtlMs` ⇒ no TTL. Combining both knobs caps both age and working-set size.

### NO-THROW

`getOrCreate / peek / evict / size / clear` each wrap in try/catch and degrade to a sensible no-op on failure. The internal factories (`createInMemoryTypedHistoryEventStore`, `createInMemorySystemPromptCache`) should never throw; defense-in-depth covers hostile mocks. A construction-time failure in the factories does not corrupt the registry — the caller receives a one-shot pair that the registry simply didn't persist.

## Composition-root usage (illustrative — NOT applied in this ADR)

`src/apps/agent/assemble.ts` (line 167-ish today):

```ts
// Before
installCodexR2Wires(cfg, {
  sessionId,
  systemPromptCache: createInMemorySystemPromptCache(),
  store: createInMemoryTypedHistoryEventStore(),
  /* … */
})

// After (callable from any composition root that owns the registry instance)
const resources = registry.getOrCreate(sessionId)
installCodexR2Wires(cfg, {
  sessionId,
  systemPromptCache: resources.cache,
  store: resources.store,
  /* … */
})
```

The registry is a singleton-per-process (or per host), constructed once at composition-root startup with the desired `maxEntries` / `idleTtlMs`. The default-OFF posture is preserved: composition roots that do not import the registry are byte-identical to today.

## Limitations

- The registry is single-process — restarting the process loses all state. Disk persistence is a separate ADR (cf. Codex `~/.codex/logs_2.sqlite` rolling window + `PASSIVE wal_checkpoint`).
- A `sessionId` that re-uses an evicted id silently mints a fresh pair (no "evicted" signal surfaced). Observability would need a separate hook (out of scope).
- The registry does NOT enforce schema compatibility between the cached `store` and the caller's expected event shape — adding a new event variant requires evicting or migrating cached entries (no-op for an in-memory-only registry).

## Tests

`src/agent/session-resource-registry/__tests__/registry.hellgate.test.ts` — 14 cases:

| Section | Case |
| --- | --- |
| §A | empty registry peek/size |
| §B | getOrCreate first-call mint |
| §C | same id ⇒ SAME ref (core invariant) + shared state |
| §D | distinct ids ⇒ distinct refs |
| §E | peek hit ⇒ same ref, size unchanged |
| §F | peek miss ⇒ null |
| §G | evict + idempotent on unknown id |
| §H | clear drops every entry |
| §I | LRU maxEntries=2 + 3rd id evicts oldest |
| §J | LRU touch refresh: getOrCreate bumps existing id past axe |
| §K | TTL idleTtlMs sweep on next access |
| §L | TTL + LRU together: TTL runs first |
| §M | clock seam: now() mock controls eviction timing (boundary inclusive) |
| §N | peek does NOT bump lastTouched (read-only contract pin) |

14 pass / 0 fail / 47 expects locally. `bun test src/agent/session-resource-registry/__tests__/`.

## Non-goals

- Composition-root call-site changes (deferred — user in-flight).
- Disk persistence (separate ADR).
- Cross-process / distributed sharing (separate ADR).
- Default-ON posture (the wire stays opt-in per composition root).
- Schema migration / cache-versioning (out of scope for in-memory only).

## References

- `src/agent/session-resource-registry/` slice — types + in-memory adapter + barrel + tests.
- `src/agent/codex-r2-wire-install/install.ts` — current install helper that the registry feeds.
- `src/apps/agent/assemble.ts:167` — site that today mints fresh `{ store, cache }` per call.
- `src/memory/typed-event/` — `TypedHistoryEventStore` + `createInMemoryTypedHistoryEventStore`.
- `src/llm/system-prompt-cache/` — `SystemPromptCachePort` + `createInMemorySystemPromptCache`.
- Memory `codex-logs-retention-pattern` — disk-backed sibling pattern (sliding-window sqlite) for the eventual disk-persistence ADR.
- ADR-0326 — system-prompt cache port (peek read-only contract reference).
- ADR-0332 — composition-wire install helper (consumer of the registered resources).
