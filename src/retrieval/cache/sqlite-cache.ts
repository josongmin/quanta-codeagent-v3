/**
 * ADR-0263 — durable `bun:sqlite` adapter for {@link EmbedCache}.
 *
 * On-disk layout:
 *   - default path `~/.quanta/embed-cache.db` (dir 0700, file 0600)
 *   - single table `embed_cache (key TEXT PRIMARY KEY, text TEXT, model_tag
 *     TEXT, vector BLOB, cached_at INTEGER)` — vector stored as packed
 *     Float64 little-endian bytes (Uint8Array → BLOB) for byte-exact
 *     round-trip without JSON quantisation.
 *   - default TTL 30 days; expired rows are filtered on `get` AND lazily
 *     deleted so disk doesn't accumulate stale embeddings.
 *
 * Closed I/O: every external (homedir / clock) is constructor-injected
 * so tests can drive deterministic TTL expiry and a temp dir for 0600
 * proof. Default args wire the production defaults so call sites stay
 * one-liners.
 */
import { Database } from "bun:sqlite"
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { omitUndef } from "@/shared"
import type { EmbedCache } from "./port"
import type { EmbedCacheHit } from "./types"

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const DIR_MODE = 0o700
const FILE_MODE = 0o600

export interface SqliteEmbedCacheOptions {
  /** Absolute path to the sqlite file. Default `~/.quanta/embed-cache.db`. */
  readonly path?: string
  /** Time-to-live in milliseconds. Default 30 days. */
  readonly ttlMs?: number
  /** Injectable clock — tests drive expiry by stepping this. */
  readonly now?: () => number
}

const defaultPath = (): string => join(homedir(), ".quanta", "embed-cache.db")

const ensureParentDir = (file: string): void => {
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE })
}

const ensureFileMode = (file: string): void => {
  try {
    const m = statSync(file).mode & 0o777
    if (m !== FILE_MODE) chmodSync(file, FILE_MODE)
  } catch {
    // best-effort — first-time open before any write is fine
  }
}

const packVector = (v: readonly number[]): Uint8Array => {
  const buf = new ArrayBuffer(v.length * 8)
  const view = new DataView(buf)
  for (let i = 0; i < v.length; i++) {
    view.setFloat64(i * 8, v[i] as number, true)
  }
  return new Uint8Array(buf)
}

const unpackVector = (bytes: Uint8Array): number[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Array<number>(bytes.byteLength / 8)
  for (let i = 0; i < out.length; i++) {
    out[i] = view.getFloat64(i * 8, true)
  }
  return out
}

const syncKey = (text: string, modelTag: string): string => {
  // Fast non-crypto mix — collisions cost a re-embed, not correctness.
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return `${h.toString(16).padStart(8, "0")}:${modelTag}`
}

interface Row {
  key: string
  text: string
  model_tag: string
  vector: Uint8Array
  cached_at: number
}

export const newSqliteEmbedCache = (opts: SqliteEmbedCacheOptions = {}): EmbedCache => {
  const filled = omitUndef({
    path: opts.path ?? defaultPath(),
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
    now: opts.now ?? (() => Date.now()),
  })
  const path = filled.path
  const ttlMs = filled.ttlMs
  const now = filled.now

  ensureParentDir(path)
  const db = new Database(path)
  ensureFileMode(path)
  db.exec("PRAGMA journal_mode = WAL")
  db.exec(`
    CREATE TABLE IF NOT EXISTS embed_cache (
      key TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      model_tag TEXT NOT NULL,
      vector BLOB NOT NULL,
      cached_at INTEGER NOT NULL
    )
  `)
  db.exec("CREATE INDEX IF NOT EXISTS idx_embed_cache_model_tag ON embed_cache(model_tag)")
  db.exec("CREATE INDEX IF NOT EXISTS idx_embed_cache_cached_at ON embed_cache(cached_at)")

  const selectStmt = db.query<Row, { $key: string }>(
    "SELECT key, text, model_tag, vector, cached_at FROM embed_cache WHERE key = $key",
  )
  const insertStmt = db.query<
    unknown,
    {
      $key: string
      $text: string
      $tag: string
      $vec: Uint8Array
      $ts: number
    }
  >(
    `INSERT INTO embed_cache (key, text, model_tag, vector, cached_at)
       VALUES ($key, $text, $tag, $vec, $ts)
       ON CONFLICT(key) DO UPDATE SET
         vector = excluded.vector,
         cached_at = excluded.cached_at`,
  )
  const deleteByKeyStmt = db.query<unknown, { $key: string }>(
    "DELETE FROM embed_cache WHERE key = $key",
  )
  const deleteByTagStmt = db.query<unknown, { $tag: string }>(
    "DELETE FROM embed_cache WHERE model_tag = $tag",
  )
  const sizeStmt = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM embed_cache")
  const clearStmt = db.query<unknown, []>("DELETE FROM embed_cache")

  return {
    get(text, modelTag) {
      const key = syncKey(text, modelTag)
      const row = selectStmt.get({ $key: key })
      if (row === null) return null
      if (row.text !== text || row.model_tag !== modelTag) return null
      const age = now() - row.cached_at
      if (age > ttlMs) {
        deleteByKeyStmt.run({ $key: key })
        return null
      }
      const hit: EmbedCacheHit = {
        vector: unpackVector(row.vector),
        cachedAt: row.cached_at,
      }
      return hit
    },
    put(text, modelTag, vector) {
      const key = syncKey(text, modelTag)
      insertStmt.run({
        $key: key,
        $text: text,
        $tag: modelTag,
        $vec: packVector(vector),
        $ts: now(),
      })
    },
    invalidate(modelTag) {
      // count first so the return value matches the LRU adapter shape
      const before = (sizeStmt.get() as { n: number }).n
      deleteByTagStmt.run({ $tag: modelTag })
      const after = (sizeStmt.get() as { n: number }).n
      return before - after
    },
    size() {
      const row = sizeStmt.get()
      return row === null ? 0 : row.n
    },
    clear() {
      clearStmt.run()
    },
  }
}
