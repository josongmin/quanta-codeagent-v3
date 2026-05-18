import { Database } from "bun:sqlite"
import type { PersistentStorePort } from "../ports"
import { rankEntries } from "../ranking"
import type { MemoryEntry, MemoryKind, MemoryQuery } from "../types"

/** Row shape as stored in / read from sqlite. */
interface MemoryRow {
  id: string
  kind: string
  text: string
  tags: string
  created_at: number
  session_id: string | null
}

const VALID_KINDS: readonly MemoryKind[] = ["fact", "decision", "observation"]

const isKind = (v: string): v is MemoryKind => (VALID_KINDS as readonly string[]).includes(v)

/**
 * Durable {@link PersistentStorePort} backed by `bun:sqlite` (zero npm deps).
 *
 * Schema is created idempotently (CREATE TABLE IF NOT EXISTS) so constructing
 * twice on the same path is safe. Tags are stored as a JSON array string; we
 * push the cheap `kind` filter into SQL and do the full relevance ranking in
 * TS via the shared {@link rankEntries} (identical semantics to InMemoryStore).
 */
export class SqliteStore implements PersistentStorePort {
  private readonly db: Database
  private readonly insertStmt: ReturnType<Database["query"]>
  private readonly selectAllStmt: ReturnType<Database["query"]>

  /** @param path file path, or ":memory:" for an ephemeral db. */
  constructor(path = ":memory:") {
    this.db = new Database(path)
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        tags TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        session_id TEXT
      )
    `)
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at)")
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind)")

    this.insertStmt = this.db.query(`
      INSERT INTO memories (id, kind, text, tags, created_at, session_id)
      VALUES ($id, $kind, $text, $tags, $created_at, $session_id)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        text = excluded.text,
        tags = excluded.tags,
        created_at = excluded.created_at,
        session_id = excluded.session_id
    `)
    this.selectAllStmt = this.db.query("SELECT * FROM memories")
  }

  save(entry: MemoryEntry): Promise<void> {
    if (!entry.id) return Promise.reject(new Error("MemoryEntry.id is required"))
    this.insertStmt.run({
      $id: entry.id,
      $kind: entry.kind,
      $text: entry.text,
      $tags: JSON.stringify(entry.tags),
      $created_at: entry.createdAt,
      $session_id: entry.sessionId ?? null,
    })
    return Promise.resolve()
  }

  recall(query: MemoryQuery): Promise<MemoryEntry[]> {
    // Cheap SQL prefilter on kind; full ranking/filtering in shared TS fn.
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

const parseTags = (raw: string): string[] => {
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

const rowToEntry = (row: MemoryRow): MemoryEntry => ({
  id: row.id,
  kind: isKind(row.kind) ? row.kind : "observation",
  text: row.text,
  tags: parseTags(row.tags),
  createdAt: row.created_at,
  ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
})
