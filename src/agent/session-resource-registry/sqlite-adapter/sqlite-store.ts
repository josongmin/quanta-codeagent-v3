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
import {
  createInMemorySystemPromptCache,
  type SystemPromptCacheKey,
  type SystemPromptCachePort,
} from "@/llm/system-prompt-cache"
import {
  createInMemoryTypedHistoryEventStore,
  type TypedHistoryEvent,
  type TypedHistoryEventStore,
} from "@/memory/typed-event"
import type { SessionResourceRegistry, SessionResources } from "../types"
import { applyMigrations } from "./schema"
import {
  type CacheRow,
  type EventRow,
  estimateCacheBytes,
  estimateEventBytes,
  rowToCache,
  rowToEvent,
} from "./serializer"
import type { SqliteRegistryConfig } from "./types"

interface Entry {
  readonly resources: SessionResources
  lastTouched: number
}

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

  const now = cfg.now ?? Date.now

  // Prepared statements. All writes go through these so the schema
  // is single-sourced from `schema.ts` / `serializer.ts`.

  const upsertSessionStmt = db.query(`
    INSERT INTO sessions (session_id, last_touched, total_estimated_bytes)
    VALUES ($sid, $touched, $bytes)
    ON CONFLICT(session_id) DO UPDATE SET
      last_touched = $touched,
      total_estimated_bytes = sessions.total_estimated_bytes + $bytes
  `)

  const touchSessionStmt = db.query(`
    INSERT INTO sessions (session_id, last_touched, total_estimated_bytes)
    VALUES ($sid, $touched, 0)
    ON CONFLICT(session_id) DO UPDATE SET last_touched = $touched
  `)

  const nextSeqStmt = db.query(
    "SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM events WHERE session_id = ?",
  )

  const insertEventStmt = db.query(`
    INSERT INTO events (session_id, seq, kind, at, estimated_bytes, payload)
    VALUES ($sid, $seq, $kind, $at, $bytes, $payload)
  `)

  const upsertCacheStmt = db.query(`
    INSERT INTO cache_entries (
      session_id, cache_key, text, content_hash, built_at, estimated_bytes
    ) VALUES ($sid, $key, $text, $hash, $built, $bytes)
    ON CONFLICT(session_id, cache_key) DO UPDATE SET
      text = excluded.text,
      content_hash = excluded.content_hash,
      built_at = excluded.built_at,
      estimated_bytes = excluded.estimated_bytes
  `)

  const selectEventsStmt = db.query("SELECT * FROM events WHERE session_id = ? ORDER BY seq ASC")
  const selectCacheStmt = db.query(
    "SELECT * FROM cache_entries WHERE session_id = ? ORDER BY cache_key ASC",
  )
  const deleteSessionStmt = db.query("DELETE FROM sessions WHERE session_id = ?")
  const truncateSessionsStmt = db.query("DELETE FROM sessions")

  /** In-process Map of live resources. Same shape + invariants as the
   *  in-memory sibling (`../in-memory-registry.ts`). */
  const entries = new Map<string, Entry>()

  /** Write one event row. NO-THROW. */
  const writeEventRow = (sessionId: string, event: TypedHistoryEvent): void => {
    try {
      const bytes = estimateEventBytes(event)
      const seqRow = nextSeqStmt.get(sessionId) as { next_seq: number } | null
      const seq = seqRow !== null ? seqRow.next_seq : 0
      upsertSessionStmt.run({
        $sid: sessionId,
        $touched: now(),
        $bytes: bytes,
      })
      insertEventStmt.run({
        $sid: sessionId,
        $seq: seq,
        $kind: event.kind,
        $at: event.at,
        $bytes: bytes,
        $payload: JSON.stringify(event),
      })
    } catch {
      // NO-THROW — silent drop on disk side; in-memory append already ran.
    }
  }

  /** Write one cache row. NO-THROW. */
  const writeCacheRow = (
    sessionId: string,
    cacheKey: SystemPromptCacheKey,
    text: string,
    contentHash: string,
    builtAt: number,
  ): void => {
    try {
      const bytes = estimateCacheBytes(text)
      upsertSessionStmt.run({
        $sid: sessionId,
        $touched: now(),
        $bytes: bytes,
      })
      upsertCacheStmt.run({
        $sid: sessionId,
        $key: String(cacheKey),
        $text: text,
        $hash: contentHash,
        $built: builtAt,
        $bytes: bytes,
      })
    } catch {
      // NO-THROW.
    }
  }

  /** Read all prior events for `sessionId`. NO-THROW. */
  const readEvents = (sessionId: string): readonly TypedHistoryEvent[] => {
    try {
      const rows = selectEventsStmt.all(sessionId) as EventRow[]
      const out: TypedHistoryEvent[] = []
      for (const r of rows) {
        const ev = rowToEvent(r)
        if (ev !== null) out.push(ev)
      }
      return out
    } catch {
      return []
    }
  }

  /** Read all prior cache rows for `sessionId`. NO-THROW. */
  const readCache = (
    sessionId: string,
  ): readonly { readonly key: SystemPromptCacheKey; readonly text: string }[] => {
    try {
      const rows = selectCacheStmt.all(sessionId) as CacheRow[]
      return rows.map((r) => {
        const decoded = rowToCache(r)
        return { key: decoded.key, text: decoded.entry.text }
      })
    } catch {
      return []
    }
  }

  /**
   * Wrap an in-memory event store so every `append` is mirrored to
   * SQLite. NO-THROW: disk writes fail silently; in-memory append
   * still runs and the running process keeps a usable store.
   */
  const wrapStore = (inner: TypedHistoryEventStore, sessionId: string): TypedHistoryEventStore => ({
    append(event: TypedHistoryEvent): void {
      inner.append(event)
      writeEventRow(sessionId, event)
    },
    snapshot() {
      return inner.snapshot()
    },
    since(at: number) {
      return inner.since(at)
    },
    clear() {
      inner.clear()
      // Truncate the events rows for this session. NO-THROW.
      try {
        db.query("DELETE FROM events WHERE session_id = ?").run(sessionId)
      } catch {
        // NO-THROW.
      }
    },
  })

  /**
   * Wrap an in-memory cache so every `getOrBuild` MISS mirrors a row
   * to SQLite. Hits do NOT touch the disk. `invalidate` / `clearAll`
   * also mirror (best effort). NO-THROW.
   */
  const wrapCache = (inner: SystemPromptCachePort, sessionId: string): SystemPromptCachePort => ({
    getOrBuild(key, factory) {
      const before = inner.peek(key) !== null
      const out = inner.getOrBuild(key, factory)
      if (!before) {
        writeCacheRow(sessionId, key, out.text, out.contentHash, out.builtAt)
      }
      return out
    },
    peek(key) {
      return inner.peek(key)
    },
    invalidate(key, reason) {
      inner.invalidate(key, reason)
      try {
        db.query("DELETE FROM cache_entries WHERE session_id = ? AND cache_key = ?").run(
          sessionId,
          String(key),
        )
      } catch {
        // NO-THROW.
      }
    },
    clearAll(reason) {
      inner.clearAll(reason)
      try {
        db.query("DELETE FROM cache_entries WHERE session_id = ?").run(sessionId)
      } catch {
        // NO-THROW.
      }
    },
    stats() {
      return inner.stats()
    },
  })

  /** Mint a fresh `{ store, cache }` pair, wrapped + rehydrated from
   *  any prior SQLite rows. NO-THROW: rehydrate failures leave the
   *  pair empty (degraded but functional). */
  const mintResources = (sessionId: string): SessionResources => {
    const innerStore = createInMemoryTypedHistoryEventStore()
    const innerCache = createInMemorySystemPromptCache()
    // Rehydrate prior rows BEFORE wrapping, so the replay does not
    // re-write what we just read.
    try {
      for (const ev of readEvents(sessionId)) innerStore.append(ev)
      for (const { key, text } of readCache(sessionId)) {
        innerCache.getOrBuild(key, () => text)
      }
    } catch {
      // NO-THROW: replay failure leaves the fresh pair as-is.
    }
    return {
      store: wrapStore(innerStore, sessionId),
      cache: wrapCache(innerCache, sessionId),
    }
  }

  const touchRow = (sessionId: string, t: number): void => {
    try {
      touchSessionStmt.run({ $sid: sessionId, $touched: t })
    } catch {
      // NO-THROW.
    }
  }

  /** Same-id same-ref invariant lives here (the closed-port contract). */
  const getOrCreate = (sessionId: string): SessionResources => {
    try {
      const t = now()
      const hit = entries.get(sessionId)
      if (hit !== undefined) {
        hit.lastTouched = t
        touchRow(sessionId, t)
        return hit.resources
      }
      const resources = mintResources(sessionId)
      entries.set(sessionId, { resources, lastTouched: t })
      touchRow(sessionId, t)
      return resources
    } catch {
      // Worst case: degraded one-shot pair, unmirrored. The closed-port
      // contract says NO-THROW so we hand back a functional pair even
      // though the registry could not register it.
      return {
        store: createInMemoryTypedHistoryEventStore(),
        cache: createInMemorySystemPromptCache(),
      }
    }
  }

  const peek = (sessionId: string): SessionResources | null => {
    try {
      const hit = entries.get(sessionId)
      return hit !== undefined ? hit.resources : null
    } catch {
      return null
    }
  }

  const evict = (sessionId: string): void => {
    try {
      entries.delete(sessionId)
      // FK cascade drops dependent events + cache_entries.
      deleteSessionStmt.run(sessionId)
    } catch {
      // NO-THROW.
    }
  }

  const size = (): number => {
    try {
      return entries.size
    } catch {
      return 0
    }
  }

  const clear = (): void => {
    try {
      entries.clear()
      truncateSessionsStmt.run()
    } catch {
      // NO-THROW.
    }
  }

  /**
   * ADR-0386 — read-only enumerate of in-process tracked session ids.
   *
   * Reads from the in-process Map (same surface as `size()`). Does NOT
   * issue `SELECT session_id FROM sessions` — the SQLite file is the
   * durable mirror, not the source of truth for in-process port
   * semantics (cross-process visibility belongs to the inspector
   * slash command, not the closed port). NO-THROW.
   */
  const listSessionIds = (): readonly string[] => {
    try {
      return Array.from(entries.keys())
    } catch {
      return []
    }
  }

  return { getOrCreate, peek, evict, size, clear, listSessionIds }
}
