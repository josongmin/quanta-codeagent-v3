# ADR-0361 — SQLite backend for `SessionResourceRegistry` (Codex `logs_2.sqlite` parity)

**Status:** Accepted (2026-05-27)
**Supersedes:** ADR-0357 (aborted; see §Context — R10 retry note)
**Sibling to:** ADR-0345 (in-memory registry), ADR-0348 (per-session JSONL adapter), ADR-0351 (env-var swap)
**Slice:** `agent`
**Default-OFF:** YES — process-level singleton (`global.ts`) does NOT auto-mount this backend.

## Context

ADR-0345 introduced `SessionResourceRegistry`: a closed port that maps
`sessionId → { TypedHistoryEventStore, SystemPromptCachePort }` so that
re-assembling an `AgentConfig` for the SAME `sessionId` REUSES the same
`store` + `cache` references instead of allocating fresh ones. The
default in-memory adapter (ADR-0345) and the per-session JSONL adapter
(ADR-0348) cover the process-local + crash-recovery cases.

The remaining gap is a **performance + retention** profile for large /
long-running sessions:

- JSONL scan to rehydrate one session is O(file size); a 50 MB
  per-session cap (ADR-0348 `DEFAULT_MAX_SESSION_BYTES`) is hit on
  multi-day sessions with heavy plugin/skill activation.
- Cross-session GC is a directory walk with per-session stat; thousands
  of sessions amortise to seconds per sweep.
- Codex ships an in-tree solution: `~/.codex/logs_2.sqlite`. The
  retention algorithm (memory `codex-logs-retention-pattern`) caps the
  on-disk database via a cumulative-bytes sliding window + TTL fallback
  + `PRAGMA wal_checkpoint(PASSIVE)`. Steady-state is ~10 days / ~14 GB
  for a heavy user — empirically calibrated.

### R10 retry note (ADR-0357 abort)

The previous worktree (commit `034b7f43`, ADR-0357) introduced a SQLite
backend behind a **self-shaped port** (`recordEvent` / `recordCache` /
`loadEvents` / `loadCache` / `evictSession` / `listSessions`). That port
shape did NOT match main's ADR-0345 `SessionResourceRegistry`
(`getOrCreate` / `peek` / `evict` / `size` / `clear`) — cherry-pick
aborted. This ADR (0361) is the retry: SQLite backend behind the SAME
closed port the in-memory + JSONL siblings already satisfy.

## Decision

Introduce `createSqliteSessionResourceRegistry(cfg)` as a sibling
adapter to the in-memory + JSONL adapters. The adapter implements the
unchanged `SessionResourceRegistry` port (ADR-0345 verbatim):

```typescript
interface SessionResourceRegistry {
  getOrCreate(sessionId: string): SessionResources  // idempotent: same id ⇒ same ref
  peek(sessionId: string): SessionResources | null  // read-only
  evict(sessionId: string): void                    // idempotent
  size(): number
  clear(): void
}
```

The adapter is layered:

1. **In-process `Map<sessionId, Entry>`** owns the live
   `SessionResources` references (preserves the same-id same-ref
   invariant byte-identically with the in-memory sibling).
2. **`bun:sqlite` WAL database** owns the durable mirror. Every
   `store.append()` writes one `events` row; every cache `getOrBuild()`
   MISS writes one `cache_entries` row.
3. **Rehydrate-on-mint** — first `getOrCreate(sessionId)` for an id
   with prior rows replays them into the freshly-minted in-memory inner
   containers synchronously (bun:sqlite read API IS sync). No microtask
   race window — the caller sees prior events on the very first
   `store.snapshot()` call.

### Schema (v1)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  last_touched INTEGER NOT NULL,
  total_estimated_bytes INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  estimated_bytes INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS events_at ON events(session_id, at);

CREATE TABLE IF NOT EXISTS cache_entries (
  session_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  built_at INTEGER NOT NULL,
  estimated_bytes INTEGER NOT NULL,
  PRIMARY KEY (session_id, cache_key),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
```

### PRAGMAs

```sql
PRAGMA journal_mode = WAL;        -- concurrent readers + non-blocking writer
PRAGMA synchronous = NORMAL;      -- safe under WAL, faster than FULL
PRAGMA foreign_keys = ON;         -- required for ON DELETE CASCADE
```

PRAGMA order matches Codex `logs_2.sqlite`: WAL must be set before the
first write; `foreign_keys` defaults OFF in SQLite, so we engage it
explicitly during `applyMigrations` (every re-open re-engages it).

### `estimated_bytes` algorithm

Each row carries a precomputed `estimated_bytes` count used by the
sliding-window GC:

- Event rows: `Buffer.byteLength(JSON.stringify(event), "utf8")`. UTF-8
  bytes (not code-units) because SQLite TEXT is bytes and event
  payloads may contain unicode.
- Cache rows: `Buffer.byteLength(text, "utf8") + 80` envelope.

The estimator is MONOTONIC (2× payload ⇒ ~2× bytes). Codex's empirical
14 GB total cap already incorporates row-overhead, PK / index / btree
fanout, so the cap is in the right ballpark.

### Retention (`sweepSqliteRegistry`)

Verbatim Codex `logs_2.sqlite` retention SQL pattern:

```sql
-- TTL pass (first):
DELETE FROM sessions WHERE last_touched < ?

-- Sliding-window pass (second):
DELETE FROM sessions WHERE session_id IN (
  SELECT session_id FROM (
    SELECT session_id,
      SUM(total_estimated_bytes) OVER (
        ORDER BY last_touched DESC
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ) AS cum
    FROM sessions
  ) WHERE cum > <maxTotalBytes>
)

-- Drain WAL (third):
PRAGMA wal_checkpoint(PASSIVE);
```

The FK cascade drops the dependent `events` + `cache_entries` rows on
each `DELETE FROM sessions`.

Defaults:
- `ttlMs = 14 * 24 * 60 * 60 * 1000` (14 days — conservative vs Codex's
  ~10-day observed stabilisation)
- `maxTotalBytes = 14 * 1024 * 1024 * 1024` (14 GB — Codex production
  calibration)

### NO-THROW invariant

Every method on the returned `SessionResourceRegistry` NO-THROWS:

- `getOrCreate` — sqlite error degrades to a one-shot in-memory pair
  (the caller still gets a functional pair).
- `peek` — Map lookup; cannot fail on a healthy Map. Returns `null` on
  any catch.
- `evict` / `clear` — sqlite error swallowed; in-memory side already
  succeeded.
- `size` — pure Map size; NO-THROW.

The wrapped `store.append` / `cache.getOrBuild` paths also NO-THROW
their sqlite writes: in-memory side runs first, then a try/catch
mirrors to disk; failure silently degrades to memory-only for that
particular write.

The constructor itself MAY throw on first-open (unreadable file,
parent dir missing) — that is the host bootstrap's responsibility.

## Non-goals

- **Cross-machine sharing** — bun:sqlite is single-machine. ADR-0355
  records cross-machine sharing as an explicit negative invariant.
- **Schema v2+ migrations** — born at v1. A future schema change MUST
  extend the migration ladder in `schema.ts`; do NOT mutate existing
  rows in-place. See Codex `logs_2.sqlite` migration #2
  (`estimated_bytes` column add) for the pattern.
- **Pure-SQLite-as-source-of-truth** — would require an async cursor +
  a custom port shape (which R10 ADR-0357 tried and aborted on). Map
  layered on SQLite preserves the closed port verbatim.
- **Multi-process write contention** — bun:sqlite serialises writes via
  the SQLite WRITE lock. The Map layer is in-process and does NOT
  cross process boundaries — each process owns its own Map but shares
  the same SQLite file. The ADR-0345 `===` identity contract only
  applies within one process.

## Wiring

This slice is DEFAULT-OFF. The factory is exported from the parent
barrel (`src/agent/session-resource-registry/index.ts`) but
`getGlobalSessionResourceRegistry()` (ADR-0347) does NOT auto-mount
SQLite. Composition roots opt in by passing a custom registry.

Env-var swap (ADR-0351 pattern) for the SQLite backend is left for a
follow-up ADR — the JSONL adapter shipped with
`QUANTA_SESSION_REGISTRY_DISK_DIR`, and the SQLite adapter would land
with `QUANTA_SESSION_REGISTRY_SQLITE_PATH` or similar. Out of scope
here so we don't add a behavior change to production composition
roots in the same commit.

## Slice fence

- New files: `src/agent/session-resource-registry/sqlite-adapter/`
  (`types.ts`, `schema.ts`, `serializer.ts`, `gc.ts`, `sqlite-store.ts`,
  `index.ts`) + `__tests__/`.
- Parent barrel (`../index.ts`) gains a single re-export block.
- **NO** mutation of:
  - `../in-memory-registry.ts` (ADR-0345)
  - `../disk-adapter/*` (ADR-0348)
  - `../global.ts` (ADR-0347 / ADR-0351 env-var swap)
  - `../types.ts` (the closed port — verbatim from ADR-0345)
  - `src/agent/prompt.ts` / `src/agent/loop.ts` / `src/agent/assemble.ts`

Cross-slice imports (`@/memory/typed-event` + `@/llm/system-prompt-cache`)
are the same plane the in-memory + JSONL siblings already use.

## Testing

40 hellgate cases:
- `schema.hellgate.test.ts` (6): migration fresh / idempotent / 3
  PRAGMA + FK cascade
- `serializer.hellgate.test.ts` (10): 8 TypedHistoryEvent variants
  round-trip + cache row round-trip + estimator monotonicity +
  NO-THROW on corrupt / unknown-kind payloads
- `sqlite-store.hellgate.test.ts` (16): port invariants
  (same-id-same-ref CORE), empty / mint / distinct / evict-cascade /
  clear / peek-read-only / NO-THROW / 5000-event perf / WAL active /
  one-append-one-row / rehydrate / FK constraint / cross-process
  rehydrate
- `gc.hellgate.test.ts` (8): TTL evict / sliding-window evict (oldest
  first) / PASSIVE checkpoint / empty no-op / mixed TTL+size / in-use
  preserved / WAL size / clock seam determinism

All 40 must pass on a green main + the ADR-0345 + ADR-0348 hellgate
suites must remain green (sibling additivity check).

## Consequences

**Positive:**
- Long-running sessions (days × heavy plugin activity) get O(log n)
  rehydrate instead of O(file scan).
- Per-session byte cap (50 MB) is no longer a hard ceiling — total
  budget is across the whole DB (14 GB default) and the sliding window
  evicts oldest first.
- Codex `logs_2.sqlite` retention parity → empirical validation of the
  GC algorithm (memory `codex-logs-retention-pattern`).

**Negative:**
- bun:sqlite native dependency. Already used by `src/memory/consolidate/store.ts`
  + `src/memory/adapters/sqlite.ts` so no new dep cost; just another
  consumer.
- Two backends to maintain (JSONL + SQLite) until one is deprecated.
- Cross-process scenarios require the Map identity contract to be
  understood at the per-process boundary (already true for the
  in-memory + JSONL siblings).

## References

- ADR-0345 — `SessionResourceRegistry` closed port (in-memory adapter)
- ADR-0348 — Per-session JSONL adapter (sibling)
- ADR-0351 — Disk env-var swap (the pattern this slice's wiring will
  follow in a future ADR)
- ADR-0355 — Negative: cross-machine sharing
- memory `codex-logs-retention-pattern` — verbatim Codex retention SQL
  + production calibration (4.4 M rows × 3.6 KB avg)
- memory `codex-session-corpus-calibration` — empirical session size
  distribution (P50=766KB / P90=10MB / P99=52MB / max=141MB)
