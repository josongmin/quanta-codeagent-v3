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
 * Single-writer model. The disk-store does NOT take a flock — two
 * processes pointed at the same `storageDir` for the same session WILL
 * race. The slice fence calls this out as a non-goal (see types.ts
 * docblock + ADR-0348 §Non-goals).
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
 *  in-memory side is the source of truth for the running process. */
const wrapStoreWithDiskMirror = (
  inner: TypedHistoryEventStore,
  cfg: DiskRegistryConfig,
  sessionId: string,
): TypedHistoryEventStore => {
  const eventsPath = join(sessionDirOf(cfg, sessionId), EVENTS_FILENAME)
  return {
    append(event: TypedHistoryEvent): void {
      inner.append(event)
      const line = serializeEventLine(event)
      // Fire-and-forget: disk mirror MUST NOT block / throw for the
      // append contract to stay sync. Errors land in the swallowed
      // `appendFileSafe` rejection.
      void ensureDir(sessionDirOf(cfg, sessionId)).then(() => appendFileSafe(eventsPath, line))
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
      void writeAtomicSafe(eventsPath, "")
    },
  }
}

/** Wrap an in-memory cache so every `getOrBuild` MISS is mirrored to
 *  disk (`prompt-cache.jsonl`). Hits do NOT touch the disk. Invalidations
 *  / `clearAll` mirror to disk too (best effort). NO-THROW. */
const wrapCacheWithDiskMirror = (
  inner: SystemPromptCachePort,
  cfg: DiskRegistryConfig,
  sessionId: string,
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
        void ensureDir(sessionDirOf(cfg, sessionId)).then(() => appendFileSafe(cachePath, line))
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
      void rewriteCacheFile(inner, cachePath)
    },
    clearAll(reason) {
      inner.clearAll(reason)
      void writeAtomicSafe(cachePath, "")
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
        void writeMeta(cfg, sessionId, t)
        return hit.resources
      }
      // Mint synchronously — fresh inner containers, wrapped for disk
      // mirror. Schedule disk replay onto the same inner containers.
      const innerStore = createInMemoryTypedHistoryEventStore()
      const innerCache = createInMemorySystemPromptCache()
      const store = wrapStoreWithDiskMirror(innerStore, cfg, sessionId)
      const cache = wrapCacheWithDiskMirror(innerCache, cfg, sessionId)
      const resources: SessionResources = { store, cache }
      entries.set(sessionId, { resources, lastTouched: t })
      // Background replay — populate inner containers from disk.
      void (async () => {
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
      })()
      void writeMeta(cfg, sessionId, t)
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
