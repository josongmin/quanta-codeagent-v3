/**
 * ADR-0361 — SQLite-backed `SessionResourceRegistry` adapter.
 *
 * Sibling to:
 *   - `../in-memory-registry.ts` (ADR-0345 — process-local Map only)
 *   - `../disk-adapter/disk-store.ts` (ADR-0348 — per-session JSONL files)
 *
 * Satisfies the SAME closed `SessionResourceRegistry` port the in-memory
 * + JSONL siblings already pass (`../types.ts`): `getOrCreate`, `peek`,
 * `evict`, `size`, `clear`. The store is layered identically to
 * `disk-store.ts`:
 *
 *   1. A `Map<sessionId, Entry>` keeps live `SessionResources` refs so
 *      `getOrCreate` is O(1) on the hot path AND the same-id same-ref
 *      invariant is byte-identical to the in-memory sibling.
 *   2. On first mint, mirrored inner containers (`TypedHistoryEventStore`
 *      + `SystemPromptCachePort`) are wrapped: every `append` and
 *      cache `getOrBuild` MISS writes a corresponding SQLite row in
 *      the background.
 *   3. On `evict`, the FK cascade (`schema.ts` — `ON DELETE CASCADE`)
 *      drops the dependent events + cache_entries rows in one DELETE.
 *
 * # Why not pure-SQLite-as-source-of-truth
 *
 * The closed-port contract requires `getOrCreate(sessionId)` to be
 * SYNCHRONOUS — it returns `SessionResources` immediately. A pure
 * SQLite-as-truth design would require an async cursor + a custom
 * port shape (which R10 ADR-0357 tried and aborted on). Layering the
 * Map on top of SQLite preserves the port verbatim AND gets Codex
 * `logs_2.sqlite` parity (WAL + sliding-window + PASSIVE checkpoint)
 * for FREE — sqlite is purely the durable mirror.
 *
 * # Rehydrate on mint
 *
 * First `getOrCreate(sessionId)` for an id with prior rows in SQLite
 * REPLAYS those rows into the freshly minted in-memory inner
 * containers synchronously (the bun:sqlite read API IS sync). The
 * caller sees the prior events + cache entries immediately on the
 * very first `store.snapshot()` / `cache.peek()` call — no microtask
 * race window, unlike the JSONL sibling's `await fs.readFile` path.
 *
 * # NO-THROW invariant
 *
 * Every method NO-THROWS. A SQLite error (DB locked, disk full,
 * corrupt page) degrades to "memory-only for that session" — the
 * in-memory wrapper still works, the durable mirror just stops. The
 * constructor itself MAY throw on first-open (unreadable file, parent
 * dir missing) — that is the host bootstrap's responsibility.
 *
 * # Concurrency
 *
 * WAL allows multiple readers + one writer per process. Across
 * processes, bun:sqlite serialises writes by holding the WRITE lock.
 * The Map layer is in-process so it does NOT cross process boundaries
 * — each process owns its own Map but shares the same SQLite file.
 * The contract holds within one process (the only level the ADR-0345
 * closed-port guarantees `===` identity on).
 *
 * # Slice fence
 *
 * Imports `bun:sqlite` + sibling adapter files (`./schema`, `./serializer`,
 * `./types`) + the two cross-slice port reads (`@/memory/typed-event`,
 * `@/llm/system-prompt-cache`) — same plane as the in-memory + JSONL
 * siblings. ADR-0345 / ADR-0348 unchanged.
 */

import { Database } from "bun:sqlite"
import type { SessionResourceRegistry } from "../types"
import { applyMigrations } from "./schema"
import {
  clear,
  type Deps,
  type Entry,
  evict,
  getOrCreate,
  listSessionIds,
  peek,
  size,
} from "./sqlite-store/operations"
import { prepareStatements } from "./sqlite-store/statements"
import type { SqliteRegistryConfig } from "./types"

/**
 * Open an SQLite-backed `SessionResourceRegistry`.
 *
 * Side effects on construction:
 *   - opens / creates the DB file at `cfg.databasePath`
 *   - runs `applyMigrations` (PRAGMA + DDL)
 *   - prepares the read / write statements
 *
 * Throws (intentionally) if the DB cannot be opened — host bootstrap
 * must handle. Every subsequent method NO-THROWS.
 */
export const createSqliteSessionResourceRegistry = (
  cfg: SqliteRegistryConfig,
): SessionResourceRegistry => {
  const db = new Database(cfg.databasePath)
  applyMigrations(db)

  // Prepared statements. All writes go through these so the schema
  // is single-sourced from `schema.ts` / `serializer.ts`.
  const stmts = prepareStatements(db)

  /** Everything the registry methods close over, passed BY REFERENCE.
   *  In-process Map of live resources has the same shape + invariants
   *  as the in-memory sibling (`../in-memory-registry.ts`). */
  const deps: Deps = {
    db,
    stmts,
    now: cfg.now ?? Date.now,
    entries: new Map<string, Entry>(),
  }

  return {
    getOrCreate: (sessionId) => getOrCreate(deps, sessionId),
    peek: (sessionId) => peek(deps, sessionId),
    evict: (sessionId) => evict(deps, sessionId),
    size: () => size(deps),
    clear: () => clear(deps),
    listSessionIds: () => listSessionIds(deps),
  }
}
