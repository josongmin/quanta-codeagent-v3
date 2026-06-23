/**
 * Method + helper bodies for the SQLite-backed
 * `SessionResourceRegistry` adapter. Extracted verbatim from
 * `../sqlite-store.ts` (god-FUNCTION decomposition).
 *
 * Every function takes an explicit `Deps` bundle (db handle + prepared
 * statements + state passed BY REFERENCE) so the parent factory stays
 * a thin assembler. Control-flow, transaction boundaries, and the
 * NO-THROW invariant are preserved byte-for-byte.
 */

import type { Database } from "bun:sqlite"
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
import type { SessionResources } from "../../types"
import {
  type CacheRow,
  type EventRow,
  estimateCacheBytes,
  estimateEventBytes,
  rowToCache,
  rowToEvent,
} from "../serializer"
import type { PreparedStatements } from "./statements"
import { DELETE_CACHE_ENTRY_SQL, DELETE_CACHE_SESSION_SQL, DELETE_EVENTS_SQL } from "./statements"

export interface Entry {
  readonly resources: SessionResources
  lastTouched: number
}

/** Everything the registry methods close over, passed BY REFERENCE. */
export interface Deps {
  readonly db: Database
  readonly stmts: PreparedStatements
  readonly now: () => number
  readonly entries: Map<string, Entry>
}

/** Write one event row. NO-THROW. */
export const writeEventRow = (deps: Deps, sessionId: string, event: TypedHistoryEvent): void => {
  try {
    const bytes = estimateEventBytes(event)
    const seqRow = deps.stmts.nextSeq.get(sessionId) as { next_seq: number } | null
    const seq = seqRow !== null ? seqRow.next_seq : 0
    deps.stmts.upsertSession.run({
      $sid: sessionId,
      $touched: deps.now(),
      $bytes: bytes,
    })
    deps.stmts.insertEvent.run({
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
export const writeCacheRow = (
  deps: Deps,
  sessionId: string,
  cacheKey: SystemPromptCacheKey,
  text: string,
  contentHash: string,
  builtAt: number,
): void => {
  try {
    const bytes = estimateCacheBytes(text)
    deps.stmts.upsertSession.run({
      $sid: sessionId,
      $touched: deps.now(),
      $bytes: bytes,
    })
    deps.stmts.upsertCache.run({
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
export const readEvents = (deps: Deps, sessionId: string): readonly TypedHistoryEvent[] => {
  try {
    const rows = deps.stmts.selectEvents.all(sessionId) as EventRow[]
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
export const readCache = (
  deps: Deps,
  sessionId: string,
): readonly { readonly key: SystemPromptCacheKey; readonly text: string }[] => {
  try {
    const rows = deps.stmts.selectCache.all(sessionId) as CacheRow[]
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
export const wrapStore = (
  deps: Deps,
  inner: TypedHistoryEventStore,
  sessionId: string,
): TypedHistoryEventStore => ({
  append(event: TypedHistoryEvent): void {
    inner.append(event)
    writeEventRow(deps, sessionId, event)
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
      deps.db.query(DELETE_EVENTS_SQL).run(sessionId)
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
export const wrapCache = (
  deps: Deps,
  inner: SystemPromptCachePort,
  sessionId: string,
): SystemPromptCachePort => ({
  getOrBuild(key, factory) {
    const before = inner.peek(key) !== null
    const out = inner.getOrBuild(key, factory)
    if (!before) {
      writeCacheRow(deps, sessionId, key, out.text, out.contentHash, out.builtAt)
    }
    return out
  },
  peek(key) {
    return inner.peek(key)
  },
  invalidate(key, reason) {
    inner.invalidate(key, reason)
    try {
      deps.db.query(DELETE_CACHE_ENTRY_SQL).run(sessionId, String(key))
    } catch {
      // NO-THROW.
    }
  },
  clearAll(reason) {
    inner.clearAll(reason)
    try {
      deps.db.query(DELETE_CACHE_SESSION_SQL).run(sessionId)
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
export const mintResources = (deps: Deps, sessionId: string): SessionResources => {
  const innerStore = createInMemoryTypedHistoryEventStore()
  const innerCache = createInMemorySystemPromptCache()
  // Rehydrate prior rows BEFORE wrapping, so the replay does not
  // re-write what we just read.
  try {
    for (const ev of readEvents(deps, sessionId)) innerStore.append(ev)
    for (const { key, text } of readCache(deps, sessionId)) {
      innerCache.getOrBuild(key, () => text)
    }
  } catch {
    // NO-THROW: replay failure leaves the fresh pair as-is.
  }
  return {
    store: wrapStore(deps, innerStore, sessionId),
    cache: wrapCache(deps, innerCache, sessionId),
  }
}

export const touchRow = (deps: Deps, sessionId: string, t: number): void => {
  try {
    deps.stmts.touchSession.run({ $sid: sessionId, $touched: t })
  } catch {
    // NO-THROW.
  }
}

/** Same-id same-ref invariant lives here (the closed-port contract). */
export const getOrCreate = (deps: Deps, sessionId: string): SessionResources => {
  try {
    const t = deps.now()
    const hit = deps.entries.get(sessionId)
    if (hit !== undefined) {
      hit.lastTouched = t
      touchRow(deps, sessionId, t)
      return hit.resources
    }
    const resources = mintResources(deps, sessionId)
    deps.entries.set(sessionId, { resources, lastTouched: t })
    touchRow(deps, sessionId, t)
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

export const peek = (deps: Deps, sessionId: string): SessionResources | null => {
  try {
    const hit = deps.entries.get(sessionId)
    return hit !== undefined ? hit.resources : null
  } catch {
    return null
  }
}

export const evict = (deps: Deps, sessionId: string): void => {
  try {
    deps.entries.delete(sessionId)
    // FK cascade drops dependent events + cache_entries.
    deps.stmts.deleteSession.run(sessionId)
  } catch {
    // NO-THROW.
  }
}

export const size = (deps: Deps): number => {
  try {
    return deps.entries.size
  } catch {
    return 0
  }
}

export const clear = (deps: Deps): void => {
  try {
    deps.entries.clear()
    deps.stmts.truncateSessions.run()
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
export const listSessionIds = (deps: Deps): readonly string[] => {
  try {
    return Array.from(deps.entries.keys())
  } catch {
    return []
  }
}
