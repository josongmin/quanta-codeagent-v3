# ADR-0348 — Disk-persistent session-resource registry (jsonl adapter)

## Status
Accepted. New sibling adapter inside the ADR-0345 slice + tests landed. Composition-root adoption deferred (explicit opt-in by default; in-memory adapter remains the production path).

## Context

ADR-0345 introduced `SessionResourceRegistry` — a process-local in-memory map of `sessionId → { TypedHistoryEventStore, SystemPromptCachePort }`. The closed-port contract is excellent for same-process re-assemble, but it has three structural gaps:

1. **Process crash ⇒ total state loss.** Typed history events + system-prompt cache entries vanish when the process exits, even for sessions the user might reasonably expect to resume (long-running tasks, scheduled agents, surfaces that hand off to a daemon).
2. **Multi-process sharing impossible.** The web-daemon (ADR-0315) and the CLI process can be alive concurrently for the same sessionId; today they each mint their own containers and silently diverge.
3. **Bench fixture reuse impossible.** A bench replay (`apps/bench/eval/driver.ts`) that wants to seed prior typed-events into a registry has no on-disk format to write/read.

Codex addresses the analogous problem with `logs_2.sqlite` — a sliding-window sqlite store with `PRAGMA wal_checkpoint(PASSIVE)` retention (memory `codex-logs-retention-pattern`: ~10 days / ~14 GB cap, accumulated `estimated_bytes` sliding window). That demonstrates the persistence layer is a real win, but the slice does NOT need sqlite to ship — quanta already has a working jsonl-recorder pattern (`src/stream/adapters/jsonl-recorder.ts`) + a write-file-atomic helper (`src/lsp/adapters/file-write-atomic.ts`).

## Decision

Ship `src/agent/session-resource-registry/disk-adapter/` — a sibling slice that layers a JSONL-backed persistence adapter ON TOP of the existing in-memory adapter. The public surface adds one factory + a sweep helper + the persisted-snapshot types.

### Public surface (added to the slice barrel)

```ts
// src/agent/session-resource-registry/index.ts
export { createDiskSessionResourceRegistry } from "./disk-adapter/disk-store"
export { sweepDiskRegistry }                    from "./disk-adapter/gc"
export type {
  DiskRegistryConfig,
  PersistedSessionResources,
  PersistedCacheEntry,
  CacheLine,
  EventLine,
} from "./disk-adapter/types"
// + serializer helpers (pure functions; useful for bench fixtures + tests)
```

### Config

```ts
interface DiskRegistryConfig {
  readonly storageDir: string                    // required — root of per-session dirs
  readonly ttlMs?: number                        // default 14 days  (DEFAULT_TTL_MS)
  readonly maxSessionBytes?: number              // default 50 MB    (DEFAULT_MAX_SESSION_BYTES)
  readonly now?: () => number                    // clock seam       (default Date.now)
}
```

### File layout

```
<storageDir>/
  <sanitized-sessionId>/
    events.jsonl        # one TypedHistoryEvent per line (ADR-0320 closed union, 8 variants)
    prompt-cache.jsonl  # one CacheLine per line (key/text/contentHash/builtAt)
    meta.json           # { sessionId, lastTouched } — single-object snapshot
```

`<sanitized-sessionId>` runs the raw id through `[A-Za-z0-9_-]` allowlist, replacing everything else with `_` (path-traversal guard).

### `getOrCreate(sessionId)` algorithm

1. Fire-and-forget `sweepDiskRegistry(cfg)` — idempotent + at-most-once-in-flight.
2. In-memory hit ⇒ touch `lastTouched`, write `meta.json` atomically, return the cached reference.
3. In-memory miss ⇒ mint a fresh `{store, cache}` pair wrapped with disk-mirror proxies, install into the in-memory map, return immediately. A background microtask reads `events.jsonl` + `prompt-cache.jsonl` and replays the contents into the SAME inner containers, so any reference handed to a caller stays valid + observes the replay as events stream in.

The synchronous return is non-negotiable: `SessionResourceRegistry.getOrCreate` is sync by contract (ADR-0345 port).

### Atomic write strategy

Two write patterns:

- **`events.jsonl` / `prompt-cache.jsonl`** — append-only via `node:fs.appendFile`. POSIX `O_APPEND` guarantees atomicity for single `write()` calls under `PIPE_BUF` (4096 bytes on Linux; our lines are typically well under). Multi-line truncation goes through a temp+rename atomic rewrite.
- **`meta.json`** — temp+rename (write `meta.json.tmp-<8-hex>`, then `fs.rename`). Mirrors `src/lsp/adapters/file-write-atomic.ts`. The slice does NOT depend on the `write-file-atomic` npm package: that lib is in the worktree as an ambient `.d.ts` declaration only and is NOT in `package.json` dependencies, so we use pure `node:fs/promises` to stay install-free.

### TTL + size-cap justification

- **TTL 14 days** — long enough that a weekend + a long task chain still resumes; short enough that abandoned sessions don't accumulate indefinitely. Codex's `logs_2.sqlite` runs ~10 days; 14 days is 1.4× that, conservative-but-not-stingy.
- **Per-session cap 50 MB** — Codex's aggregate cap is ~14 GB across thousands of sessions ≈ tens of MB per session. 50 MB allows for a long task chain with many context updates + cached prompts without ever truncating in normal use. Truncation drops the OLDEST lines first (jsonl byte walk from the back, line-aware so no half-JSON survives).
- **Both knobs are optional** — callers may opt-out (Number.POSITIVE_INFINITY ttl effectively keeps forever; large `maxSessionBytes` disables truncation in practice). The `now` seam allows deterministic tests.

### Default-OFF

`createDiskSessionResourceRegistry` is an explicit opt-in factory. The default `createInMemorySessionResourceRegistry` (ADR-0345) remains the production composition-root choice. A future ADR will wire the disk factory into a specific composition root (web-daemon → cross-process restart, scheduled-agent → durable replay) — that's not in scope here.

## Non-goals

- **sqlite backend** — punted to a separate ADR if/when bench workload demands it. The jsonl format trades query speed for zero deps + human-readability.
- **Multi-process file locking** — single-writer assumption. Two processes pointed at the same `storageDir` for the SAME `sessionId` WILL race on `events.jsonl` appends. A future ADR introduces `flock` if multi-writer becomes a real workload.
- **Cross-machine replication** — out of scope (object storage / network mounts can host `storageDir` but the slice does not orchestrate replication).
- **Schema migration across persistence format versions** — the file format is internal. Readers tolerate unknown lines (NO-THROW deserialize). When a format change ships, a new directory layout (`v2/`) is created adjacent; the slice never rewrites existing files.

## Tradeoffs

- **Approximate cache rehydration** — replaying a `PersistedCacheEntry` through the in-memory cache's `getOrBuild` recomputes `contentHash` + `builtAt` because the port has no "install verbatim" hook. The `text` field is byte-identical (the contract that matters); the hash + timestamp drift is intentional + documented.
- **Late-replay window** — a caller that reads `store.snapshot()` between the synchronous `getOrCreate` return and the background disk-replay microtask sees an empty snapshot. Acceptable because (a) the loop's first action is to append, not to snapshot, and (b) composition roots that need strict load-on-call semantics can call `getOrCreate` once at session start.
- **Deleted cache entries linger on disk until truncation** — `cache.invalidate(key)` clears the in-memory entry but the on-disk append-only file still has the prior line. The deserialize-side "last entry per key" semantics in `parseCacheBody` mean a stale entry IS visible until a fresh write overrides it. Trade-off: avoiding a rewrite-on-invalidate keeps the hot path append-only.

## Wiring (deferred)

A follow-up ADR will pick the specific composition root(s) to swap `createInMemorySessionResourceRegistry()` ⇒ `createDiskSessionResourceRegistry({storageDir: "~/.quanta/sessions"})`. Candidates:

1. **web-daemon** (ADR-0315) — most valuable: the daemon outlives any single browser session, so on-disk events survive surface reconnects.
2. **scheduled-agent** (ADR-0161) — second most valuable: scheduled runs are by definition cross-process restartable.
3. **CLI** — least valuable as default; CLI sessions are usually short-lived. Optional opt-in via `QUANTA_PERSIST_SESSIONS=1`.

## Tests

- **`__tests__/serializer.hellgate.test.ts`** — 17 cases / 33 expects covering 5 variant round-trips + cache-line round-trip + malformed JSON / empty line / unknown kind / circular payload (NO-THROW) + parseEventsBody / parseCacheBody (dup-key collapse) + buildPersistedSnapshot.
- **`__tests__/disk-store.hellgate.test.ts`** — 14 cases / 44 expects covering empty-dir mint, disk-replay restore, same-id reference equality, distinct-id separation, evict + clear cleanup, peek read-only contract, cross-process resurrection, filesystem write failure graceful degrade, path-traversal sanitization, concurrent same-id, corrupt jsonl partial recovery, cache text byte-identical replay, size() consistency.
- **`__tests__/gc.hellgate.test.ts`** — 8 cases / 21 expects covering TTL eviction, non-expired preservation, oversize truncation, missing storageDir no-op, malformed meta skip, mixed-state single-pass correctness, default constants pin, non-directory entry skip.

Total: **39 cases / 98 expects**. Combined with the existing ADR-0345 in-memory hellgate (14 / 47), the slice now has **53 cases / 145 expects**, all green.

## Constants pinned

- `DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000` (14 days)
- `DEFAULT_MAX_SESSION_BYTES = 50_000_000` (50 MB)

## References

- ADR-0345 — Session-keyed resource registry (in-memory base layer)
- ADR-0320 — Typed history event store (the variant union we serialize)
- ADR-0326 — System prompt cache (the cache we mirror to disk)
- `src/lsp/adapters/file-write-atomic.ts` — temp+rename atomic strategy pattern
- `src/stream/adapters/jsonl-recorder.ts` — jsonl append + degrade-line discipline reference
- `memory/codex-logs-retention-pattern` — Codex `logs_2.sqlite` sliding-window pattern (inspiration)
