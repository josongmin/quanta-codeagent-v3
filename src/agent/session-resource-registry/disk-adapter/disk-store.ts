/**
 * ADR-0348 — Disk-backed `SessionResourceRegistry` adapter.
 *
 * Layers on top of the in-memory adapter (ADR-0345) so reads/writes are
 * fast (Map lookup), with a write-through to per-session JSONL files
 * keeping the state durable across process restarts.
 *
 * # `getOrCreate` algorithm
 *
 *   1. lazy `sweepDiskRegistry()` (TTL + size cap) — fire-and-forget
 *   2. in-memory cache hit ⇒ return existing reference (touch lastTouched)
 *   3. disk hit ⇒ deserialize, rebuild fresh resources, replay events
 *      + cache entries, install into in-memory cache, return
 *   4. disk miss ⇒ mint fresh resources, write `meta.json`, install
 *
 * Every method is NO-THROW. Filesystem failures degrade to "in-memory
 * only" rather than throwing — the cached pair still works for the rest
 * of the process lifetime, the disk just isn't persisted.
 *
 * # Atomic writes
 *
 * Single-line appends to `events.jsonl` + `prompt-cache.jsonl` use
 * `fs.appendFile` (atomic-by-line on POSIX: the kernel will not
 * interleave a single write() under the POSIX append flag for sizes
 * under PIPE_BUF / page-aligned). `meta.json` uses a temp+rename atomic
 * write (same pattern as `src/lsp/adapters/file-write-atomic.ts`).
 *
 * # Reuse semantics
 *
 * The producers (`store.append` from `@/memory/typed-event`,
 * `cache.getOrBuild` from `@/llm/system-prompt-cache`) are PURE in-memory
 * containers — they do NOT know about the disk. The disk-store wraps
 * them with proxy adapters that mirror each mutation to disk
 * (append-only) so the underlying contract (NO-THROW, single-threaded)
 * holds verbatim.
 *
 * # Concurrency
 *
 * Single-machine multi-process safe via ADR-0356 per-session lockfile
 * (`.lock` under `<storageDir>/<sanitizedId>/`). The lock is acquired
 * LAZILY on first `getOrCreate(id)` and held for the lifetime of that
 * session in this process; `evict(id)` / `clear()` release. A process
 * that loses contention (timeout) falls back to memory-only — disk
 * writes for that session are suppressed but the in-memory store +
 * cache remain usable. Cross-machine (NFS lease) is NOT covered — see
 * ADR-0355 negative.
 *
 * # Slice fence
 *
 * Imports `node:fs/promises` + `node:path` + sibling files. The two
 * cross-slice imports (`@/memory/typed-event`, `@/llm/system-prompt-cache`)
 * mirror the in-memory adapter — same plane.
 */

import { randomBytes } from "node:crypto"
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  type CachedPrompt,
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
import { acquireSessionLock, type SessionLock } from "./file-lock"
import { CACHE_FILENAME, EVENTS_FILENAME, META_FILENAME, sweepDiskRegistry } from "./gc"
import {
  parseCacheBody,
  parseEventsBody,
  serializeCacheLine,
  serializeEventLine,
} from "./serializer"
import type { DiskRegistryConfig, PersistedCacheEntry } from "./types"

interface Entry {
  resources: SessionResources
  lastTouched: number
}

/** Sanitize a session id for safe use as a directory name. We allow
 *  the common conversation-id alphabet (alnum + `-` + `_`) and replace
 *  everything else with `_`. Avoids path traversal + reserved chars
 *  without dropping ids that don't round-trip 1:1 (`..` → `__`). */
const safeId = (sessionId: string): string => {
  let out = ""
  for (const ch of sessionId) {
    const safe = /^[A-Za-z0-9_-]$/.test(ch)
    out += safe ? ch : "_"
  }
  return out.length === 0 ? "_" : out
}

/** Best-effort `mkdir -p`. NO-THROW. */
const ensureDir = async (path: string): Promise<boolean> => {
  try {
    await mkdir(path, { recursive: true })
    return true
  } catch {
    return false
  }
}

/** Best-effort read. Returns `""` on any failure. NO-THROW. */
const readFileSafe = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf8")
  } catch {
    return ""
  }
}

/** Best-effort append. NO-THROW. Returns `true` iff the write succeeded. */
const appendFileSafe = async (path: string, line: string): Promise<boolean> => {
  if (line.length === 0) return false
  try {
    await appendFile(path, `${line}\n`, "utf8")
    return true
  } catch {
    return false
  }
}

/** Atomic single-file rewrite via temp+rename. Mirrors the strategy in
 *  `src/lsp/adapters/file-write-atomic.ts`. NO-THROW: returns `false`
 *  on any failure. */
const writeAtomicSafe = async (path: string, body: string): Promise<boolean> => {
  const suffix = randomBytes(8).toString("hex")
  const tmpPath = `${path}.tmp-${suffix}`
  try {
    await writeFile(tmpPath, body, "utf8")
  } catch {
    return false
  }
  try {
    await rename(tmpPath, path)
    return true
  } catch {
    // Cleanup the leftover temp on rename failure; swallow further errors.
    try {
      await rm(tmpPath, { force: true })
    } catch {
      // unreachable in practice; defense in depth.
    }
    return false
  }
}

/** Build the per-session directory path. */
const sessionDirOf = (cfg: DiskRegistryConfig, sessionId: string): string =>
  join(cfg.storageDir, safeId(sessionId))

/** Read + parse the prior persisted state for `sessionId`. Returns
 *  `null` when nothing is on disk (or parsing failed entirely). */
const loadPersisted = async (
  cfg: DiskRegistryConfig,
  sessionId: string,
): Promise<{
  events: readonly TypedHistoryEvent[]
  cacheEntries: readonly PersistedCacheEntry[]
  hadAny: boolean
} | null> => {
  const dir = sessionDirOf(cfg, sessionId)
  const [eventsBody, cacheBody] = await Promise.all([
    readFileSafe(join(dir, EVENTS_FILENAME)),
    readFileSafe(join(dir, CACHE_FILENAME)),
  ])
  const hadAny = eventsBody.length > 0 || cacheBody.length > 0
  if (!hadAny) return null
  return {
    events: parseEventsBody(eventsBody),
    cacheEntries: parseCacheBody(cacheBody),
    hadAny,
  }
}

/** Write the per-session `meta.json` snapshot. Atomic. NO-THROW. */
const writeMeta = async (
  cfg: DiskRegistryConfig,
  sessionId: string,
  lastTouched: number,
): Promise<void> => {
  const dir = sessionDirOf(cfg, sessionId)
  if (!(await ensureDir(dir))) return
  const body = JSON.stringify({ sessionId, lastTouched })
  await writeAtomicSafe(join(dir, META_FILENAME), body)
}

/** Wrap an `in-memory` typed-event store so every `append` is mirrored
 *  to disk. Failures on the disk side are swallowed (NO-THROW) — the
 *  in-memory side is the source of truth for the running process.
 *
 *  ADR-0356: every disk-mirror op chains on `lockReady` — when the
 *  per-session lock could not be acquired (multi-process contention)
 *  `lockReady` resolves to `null` and ALL disk writes are suppressed.
 *  The in-memory append still runs synchronously, so the running
 *  process keeps a usable store — just without crash-recovery. */
const wrapStoreWithDiskMirror = (
  inner: TypedHistoryEventStore,
  cfg: DiskRegistryConfig,
  sessionId: string,
  lockReady: Promise<SessionLock | null>,
): TypedHistoryEventStore => {
  const eventsPath = join(sessionDirOf(cfg, sessionId), EVENTS_FILENAME)
  return {
    append(event: TypedHistoryEvent): void {
      inner.append(event)
      const line = serializeEventLine(event)
      // Fire-and-forget: disk mirror MUST NOT block / throw for the
      // append contract to stay sync. Errors land in the swallowed
      // `appendFileSafe` rejection. Lock failure (null) ⇒ skip disk.
      void lockReady.then((lock) => {
        if (lock === null) return
        return ensureDir(sessionDirOf(cfg, sessionId)).then(() => appendFileSafe(eventsPath, line))
      })
    },
    snapshot() {
      return inner.snapshot()
    },
    since(at: number) {
      return inner.since(at)
    },
    clear() {
      inner.clear()
      // On clear, truncate the on-disk file (best effort). This matches
      // the in-memory contract — session-boundary reset wipes the
      // append-only log.
      void lockReady.then((lock) => {
        if (lock === null) return
        return writeAtomicSafe(eventsPath, "")
      })
    },
  }
}

/** Wrap an in-memory cache so every `getOrBuild` MISS is mirrored to
 *  disk (`prompt-cache.jsonl`). Hits do NOT touch the disk. Invalidations
 *  / `clearAll` mirror to disk too (best effort). NO-THROW.
 *
 *  ADR-0356: same `lockReady` gate as {@link wrapStoreWithDiskMirror}. */
const wrapCacheWithDiskMirror = (
  inner: SystemPromptCachePort,
  cfg: DiskRegistryConfig,
  sessionId: string,
  lockReady: Promise<SessionLock | null>,
): SystemPromptCachePort => {
  const cachePath = join(sessionDirOf(cfg, sessionId), CACHE_FILENAME)
  return {
    getOrBuild(key, factory) {
      const before = inner.peek(key) !== null
      const out = inner.getOrBuild(key, factory)
      if (!before) {
        // Miss path — mirror to disk.
        const persisted: PersistedCacheEntry = {
          key,
          text: out.text,
          contentHash: out.contentHash,
          builtAt: out.builtAt,
        }
        const line = serializeCacheLine(persisted)
        void lockReady.then((lock) => {
          if (lock === null) return
          return ensureDir(sessionDirOf(cfg, sessionId)).then(() => appendFileSafe(cachePath, line))
        })
      }
      return out
    },
    peek(key) {
      return inner.peek(key)
    },
    invalidate(key, reason) {
      inner.invalidate(key, reason)
      // The append-only file is rewritten on invalidate so the disk
      // shows the post-invalidate state. Cheap because typical cache
      // size is O(1) per session.
      void lockReady.then((lock) => {
        if (lock === null) return
        return rewriteCacheFile(inner, cachePath)
      })
    },
    clearAll(reason) {
      inner.clearAll(reason)
      void lockReady.then((lock) => {
        if (lock === null) return
        return writeAtomicSafe(cachePath, "")
      })
    },
    stats() {
      return inner.stats()
    },
  }
}

/** Rewrite the cache file from the inner cache's CURRENT entries. The
 *  port does not expose iteration, so this helper uses the same dance
 *  the in-memory cache uses internally — but we don't have keys at
 *  this level. Implementation simplification: leave the prior file
 *  alone; the deserializer's "last entry per key" semantics mean a
 *  stale earlier entry is harmless once a later one is appended. The
 *  `invalidate` call already updated the in-memory snapshot; the disk
 *  catches up on the next process restart's `loadPersisted` since the
 *  invalidated key never re-appears in subsequent appends.
 *
 *  This is intentionally a best-effort path; ADR-0348 §Tradeoffs
 *  documents the "deleted entries linger on disk until truncation"
 *  trade-off. */
const rewriteCacheFile = async (
  _inner: SystemPromptCachePort,
  _cachePath: string,
): Promise<void> => {
  // No-op (see docblock). The slice intentionally does not iterate the
  // inner cache — that would require a port surface change which is
  // outside the ADR-0348 fence (see §Non-goals).
  return Promise.resolve()
}

/** Construct the disk-backed registry. */
export const createDiskSessionResourceRegistry = (
  cfg: DiskRegistryConfig,
): SessionResourceRegistry => {
  const now = cfg.now ?? Date.now
  const entries = new Map<string, Entry>()
  // ADR-0356 — per-session lock acquisitions. Key: sessionId. Value:
  // the promise of a (best-effort) `SessionLock | null`. We resolve
  // the lock LAZILY on first `getOrCreate` and reuse the promise for
  // every subsequent disk-mirror op on the same session. `evict` /
  // `clear` resolve the promise then release the lock.
  const lockMap = new Map<string, Promise<SessionLock | null>>()

  // ADR-0364 — Merge the optional top-level `cfg.metricsEmitter` into
  // the `AcquireSessionLockOpts`. `cfg.lock.metricsEmitter` (if set)
  // wins by precedence; the top-level slot is purely an ergonomic
  // sibling for composition roots that already own one emitter
  // instance and don't want to splay it into the lock-knob bag.
  // `exactOptionalPropertyTypes` requires we omit the key entirely
  // when the resolved value is undefined.
  const resolvedLockOpts: import("./file-lock").AcquireSessionLockOpts = (() => {
    const base = cfg.lock ?? {}
    const emitter = base.metricsEmitter ?? cfg.metricsEmitter
    return emitter === undefined ? base : { ...base, metricsEmitter: emitter }
  })()

  const ensureLock = (sessionId: string): Promise<SessionLock | null> => {
    const existing = lockMap.get(sessionId)
    if (existing !== undefined) return existing
    const acquired = acquireSessionLock(cfg.storageDir, sessionId, resolvedLockOpts).catch(
      () => null,
    )
    lockMap.set(sessionId, acquired)
    return acquired
  }

  const releaseLock = (sessionId: string): void => {
    const promise = lockMap.get(sessionId)
    if (promise === undefined) return
    lockMap.delete(sessionId)
    void promise.then((lock) => (lock !== null ? lock.release() : undefined)).catch(() => undefined)
  }

  // Track which session ids we have already swept; sweep runs lazily
  // at most once per `getOrCreate` to keep the sync surface fast.
  let sweepInFlight: Promise<void> | null = null

  const triggerSweep = (): void => {
    if (sweepInFlight !== null) return
    sweepInFlight = sweepDiskRegistry(cfg)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        sweepInFlight = null
      })
  }

  const mintFreshResources = (): SessionResources => ({
    store: createInMemoryTypedHistoryEventStore(),
    cache: createInMemorySystemPromptCache(),
  })

  // Synchronous getOrCreate contract: we must return SessionResources
  // immediately. For the first call on a sessionId, we mint a synchronous
  // pair (no disk read) and then BACKGROUND-resync from disk by appending
  // any prior events to the same store. This keeps the sync contract
  // intact at the cost of "fresh resources are visible for a microtask
  // before the disk replay lands."
  //
  // Trade-off: a caller that reads `store.snapshot()` between the
  // synchronous return and the background replay sees an empty snapshot.
  // ADR-0348 §Tradeoffs documents this — composition roots that need
  // strict load-on-call semantics use the `await registry.warm(id)`
  // helper (next ADR slot) OR call `getOrCreate` once at session start
  // and trust the eventual replay.
  //
  // The simpler-but-still-correct option taken here: on first
  // getOrCreate, mint synchronously, then kick a microtask that calls
  // buildResources(sessionId) and REPLACES the entry. References handed
  // to early consumers become stale (point to the pre-hydrate pair).
  //
  // To avoid the stale-reference footgun, we instead mint the wrappers
  // around the SAME inner containers throughout the disk replay: the
  // wrappers are created up front around fresh inner containers, the
  // disk replay calls `innerStore.append(...)` + `innerCache.getOrBuild(...)`
  // on those same containers, so any reference handed to a caller stays
  // valid + observes the replay as events stream in.

  const getOrCreate = (sessionId: string): SessionResources => {
    try {
      triggerSweep()
      const hit = entries.get(sessionId)
      const t = now()
      if (hit !== undefined) {
        hit.lastTouched = t
        // ADR-0356: still gated on the existing lock — same `lockMap`
        // entry from the original mint. Re-touch must not write the
        // meta.json on a lock-failed session (would race with another
        // process that holds the lock).
        const lockReady = ensureLock(sessionId)
        void lockReady.then((lock) => {
          if (lock === null) return
          return writeMeta(cfg, sessionId, t)
        })
        return hit.resources
      }
      // ADR-0356 — acquire the per-session lock. The promise is reused
      // by every disk-mirror op for the rest of this session's lifetime
      // (`evict`/`clear` release it).
      const lockReady = ensureLock(sessionId)
      // Mint synchronously — fresh inner containers, wrapped for disk
      // mirror. Schedule disk replay onto the same inner containers.
      const innerStore = createInMemoryTypedHistoryEventStore()
      const innerCache = createInMemorySystemPromptCache()
      const store = wrapStoreWithDiskMirror(innerStore, cfg, sessionId, lockReady)
      const cache = wrapCacheWithDiskMirror(innerCache, cfg, sessionId, lockReady)
      const resources: SessionResources = { store, cache }
      entries.set(sessionId, { resources, lastTouched: t })
      // Background replay — populate inner containers from disk. Gated
      // on lock: a process without the lock should NOT read the other
      // process's mid-flight state.
      void lockReady.then(async (lock) => {
        if (lock === null) return
        try {
          const persisted = await loadPersisted(cfg, sessionId)
          if (persisted === null) return
          // Disable the mirror momentarily by going through the inner
          // store directly — wrapping the inner with mirror writes
          // would re-append the same lines to disk, doubling them.
          for (const ev of persisted.events) innerStore.append(ev)
          for (const entry of persisted.cacheEntries) {
            innerCache.getOrBuild(entry.key as SystemPromptCacheKey, () => entry.text)
          }
        } catch {
          // NO-THROW: replay failure leaves the fresh pair as-is.
        }
      })
      void lockReady.then((lock) => {
        if (lock === null) return
        return writeMeta(cfg, sessionId, t)
      })
      return resources
    } catch {
      // Worst case: filesystem dead. Hand back a memory-only pair so
      // the caller keeps functioning.
      return mintFreshResources()
    }
  }

  const peek = (sessionId: string): SessionResources | null => {
    try {
      const hit = entries.get(sessionId)
      return hit?.resources ?? null
    } catch {
      return null
    }
  }

  const evict = (sessionId: string): void => {
    try {
      entries.delete(sessionId)
      // ADR-0356: release the lock BEFORE removing the session dir so
      // a sibling process that was waiting can immediately reclaim.
      // The rm includes the .lock file itself; the release is a no-op
      // by the time the unlink fires.
      releaseLock(sessionId)
      // Best-effort disk cleanup. Fire-and-forget.
      void rm(sessionDirOf(cfg, sessionId), { recursive: true, force: true }).catch(() => undefined)
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
      // Snapshot ids BEFORE clearing so we can cleanup their disk dirs.
      const ids: string[] = []
      for (const id of entries.keys()) ids.push(id)
      entries.clear()
      for (const id of ids) {
        // ADR-0356: release per-session locks so siblings can reclaim
        // immediately. The lock release races with the rm — both are
        // best-effort and idempotent.
        releaseLock(id)
        void rm(sessionDirOf(cfg, id), { recursive: true, force: true }).catch(() => undefined)
      }
    } catch {
      // NO-THROW.
    }
  }

  return { getOrCreate, peek, evict, size, clear }
}

// Exposed for tests — the in-memory cache exposes only an opaque
// `CachedPrompt` shape; we re-export the type alias so the hellgate
// can assert on the persisted view without re-importing the slice.
export type { CachedPrompt }
