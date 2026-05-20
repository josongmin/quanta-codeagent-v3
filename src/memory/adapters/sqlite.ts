import { Database } from "bun:sqlite"
import type { PersistentStorePort } from "../ports"
import { rankEntries } from "../ranking"
import {
  MEMORY_KINDS,
  type MemoryEntry,
  type MemoryKind,
  type MemoryQuery,
  type MemoryTier,
  normalizeEntry,
} from "../types"
import { deserializeVec, serializeVec } from "../vector"

/** Row shape as stored in / read from sqlite (post-migration schema). */
interface MemoryRow {
  id: string
  kind: string
  tier: string | null
  text: string
  tags: string
  importance: number | null
  created_at: number
  updated_at: number | null
  access_count: number | null
  last_accessed_at: number | null
  embedding: Uint8Array | null
  superseded_by: string | null
  session_id: string | null
}

const isKind = (v: string): v is MemoryKind => (MEMORY_KINDS as readonly string[]).includes(v)

/**
 * Columns added by long-term memory on top of the legacy schema
 * (`id, kind, text, tags, created_at, session_id`). The constructor ALTERs in
 * any that are missing so a legacy db migrates transparently on open.
 */
const NEW_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["tier", "TEXT"],
  ["importance", "REAL"],
  ["updated_at", "INTEGER"],
  ["access_count", "INTEGER"],
  ["last_accessed_at", "INTEGER"],
  ["embedding", "BLOB"],
  ["superseded_by", "TEXT"],
]

/**
 * Durable {@link PersistentStorePort} backed by `bun:sqlite` (zero npm deps).
 *
 * The schema is created idempotently (CREATE TABLE IF NOT EXISTS) and
 * forward-migrated on construction: `PRAGMA table_info` is diffed against the
 * full long-term-memory column set and any missing columns are `ALTER TABLE ... ADD
 * COLUMN`-ed, so opening a legacy db (only `id,kind,text,tags,created_at,
 * session_id`) just works and old rows stay readable. The cheap `kind` filter
 * is pushed into SQL; all other filtering / ranking (incl. vector) is the
 * shared {@link rankEntries} so semantics never diverge from InMemoryStore.
 */
export class SqliteStore implements PersistentStorePort {
  private readonly db: Database
  private readonly insertStmt: ReturnType<Database["query"]>
  private readonly selectAllStmt: ReturnType<Database["query"]>
  private readonly selectByIdStmt: ReturnType<Database["query"]>
  private readonly deleteStmt: ReturnType<Database["query"]>

  /** @param path file path, or ":memory:" for an ephemeral db. */
  constructor(path = ":memory:") {
    this.db = new Database(path)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT,
        tier TEXT,
        text TEXT,
        tags TEXT,
        importance REAL,
        created_at INTEGER,
        updated_at INTEGER,
        access_count INTEGER,
        last_accessed_at INTEGER,
        embedding BLOB,
        superseded_by TEXT,
        session_id TEXT
      )
    `)
    this.migrate()
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at)")
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind)")
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memories_superseded_by ON memories(superseded_by)")

    this.insertStmt = this.db.query(`
      INSERT INTO memories (
        id, kind, tier, text, tags, importance, created_at, updated_at,
        access_count, last_accessed_at, embedding, superseded_by, session_id
      ) VALUES (
        $id, $kind, $tier, $text, $tags, $importance, $created_at, $updated_at,
        $access_count, $last_accessed_at, $embedding, $superseded_by, $session_id
      )
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        tier = excluded.tier,
        text = excluded.text,
        tags = excluded.tags,
        importance = excluded.importance,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        access_count = excluded.access_count,
        last_accessed_at = excluded.last_accessed_at,
        embedding = excluded.embedding,
        superseded_by = excluded.superseded_by,
        session_id = excluded.session_id
    `)
    this.selectAllStmt = this.db.query("SELECT * FROM memories")
    this.selectByIdStmt = this.db.query("SELECT * FROM memories WHERE id = ?")
    this.deleteStmt = this.db.query("DELETE FROM memories WHERE id = ?")
  }

  /** Idempotently ALTER in any long-term-memory columns missing from a legacy db. */
  private migrate(): void {
    const cols = this.db.query("PRAGMA table_info(memories)").all() as Array<{
      name: string
    }>
    const have = new Set(cols.map((c) => c.name))
    for (const [name, type] of NEW_COLUMNS) {
      if (!have.has(name)) {
        this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`)
      }
    }
  }

  save(entry: MemoryEntry): Promise<void> {
    if (!entry.id) return Promise.reject(new Error("MemoryEntry.id is required"))
    const n = normalizeEntry(entry)
    this.insertStmt.run({
      $id: n.id,
      $kind: n.kind,
      $tier: n.tier,
      $text: n.text,
      $tags: JSON.stringify(n.tags),
      $importance: n.importance,
      $created_at: n.createdAt,
      $updated_at: n.updatedAt,
      $access_count: n.accessCount,
      $last_accessed_at: n.lastAccessedAt ?? null,
      $embedding: n.embedding ? serializeVec(n.embedding) : null,
      $superseded_by: n.supersededBy ?? null,
      $session_id: n.sessionId ?? null,
    })
    return Promise.resolve()
  }

  update(id: string, patch: Partial<MemoryEntry>): Promise<void> {
    const row = this.selectByIdStmt.get(id) as MemoryRow | null
    if (!row) return Promise.resolve()
    const merged: MemoryEntry = {
      ...rowToEntry(row),
      ...patch,
      updatedAt: Date.now(),
    }
    return this.save(merged)
  }

  delete(id: string): Promise<void> {
    this.deleteStmt.run(id)
    return Promise.resolve()
  }

  get(id: string): Promise<MemoryEntry | undefined> {
    const row = this.selectByIdStmt.get(id) as MemoryRow | null
    return Promise.resolve(row ? normalizeEntry(rowToEntry(row)) : undefined)
  }

  all(): Promise<MemoryEntry[]> {
    const rows = this.selectAllStmt.all() as MemoryRow[]
    return Promise.resolve(rows.map((r) => normalizeEntry(rowToEntry(r))))
  }

  recall(query: MemoryQuery): Promise<MemoryEntry[]> {
    // Cheap SQL prefilter on kind; all other filtering/ranking in shared TS fn.
    const kinds = query.kinds?.filter(isKind) ?? []
    let rows: MemoryRow[]
    if (kinds.length > 0) {
      const placeholders = kinds.map(() => "?").join(", ")
      rows = this.db
        .query(`SELECT * FROM memories WHERE kind IN (${placeholders})`)
        .all(...kinds) as MemoryRow[]
    } else {
      rows = this.selectAllStmt.all() as MemoryRow[]
    }
    const entries = rows.map(rowToEntry)
    return Promise.resolve(rankEntries(entries, query))
  }

  /** Release the underlying db handle. */
  close(): void {
    this.db.close()
  }
}

const parseTags = (raw: string | null): string[] => {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === "string")
    }
  } catch {
    // Corrupt/legacy value — treat as no tags rather than throwing.
  }
  return []
}

/**
 * Map a raw row to a {@link MemoryEntry}. Tolerant of legacy/corrupt data:
 * bad tags JSON → `[]`, bad embedding BLOB → `undefined` (deserializeVec
 * already returns undefined), unknown kind/tier resolved by normalizeEntry.
 */
const rowToEntry = (row: MemoryRow): MemoryEntry => {
  const embedding = deserializeVec(row.embedding)
  return {
    id: row.id,
    kind: isKind(row.kind) ? row.kind : "observation",
    text: row.text,
    tags: parseTags(row.tags),
    createdAt: row.created_at,
    ...(row.tier !== null ? { tier: row.tier as MemoryTier } : {}),
    ...(row.importance !== null ? { importance: row.importance } : {}),
    ...(row.updated_at !== null ? { updatedAt: row.updated_at } : {}),
    ...(row.access_count !== null ? { accessCount: row.access_count } : {}),
    ...(row.last_accessed_at !== null ? { lastAccessedAt: row.last_accessed_at } : {}),
    ...(embedding !== undefined ? { embedding } : {}),
    ...(row.superseded_by !== null ? { supersededBy: row.superseded_by } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
  }
}
