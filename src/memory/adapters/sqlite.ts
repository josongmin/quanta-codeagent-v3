import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { errMessage } from "@/shared"
import type { PersistentStorePort } from "../ports"
import { rankEntries } from "../ranking"
import type { MemoryTelemetryPort } from "../telemetry-port"
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
  // ADR-0554 decay clock (forward-migrated; null on legacy rows).
  last_decayed_at: number | null
  embedding: Uint8Array | null
  superseded_by: string | null
  session_id: string | null
  // §10.6 routing meta (forward-migrated; null on legacy rows).
  task_group: string | null
  applies_to_cwd: string | null
  reuse_rule: string | null
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
  // §10.6 routing meta — added on top of the long-term-memory schema; legacy
  // dbs migrate transparently on open (null on pre-existing rows).
  ["task_group", "TEXT"],
  ["applies_to_cwd", "TEXT"],
  ["reuse_rule", "TEXT"],
  // ADR-0554 — once-per-window decay clock; legacy dbs migrate on open.
  ["last_decayed_at", "INTEGER"],
]

/**
 * Audit C-18 — typed corrupt-embedding degradation signal. A stored embedding
 * BLOB whose byte length is not a positive multiple of 4 (odd / partial write /
 * legacy corruption) cannot be decoded; the row still loads (fail-open
 * ranking), but the demotion to "no embedding" is no longer SILENT — it is
 * surfaced through {@link SqliteStoreOptions.onCorruptEmbedding} so operators
 * can see the data-quality issue instead of being blind to it.
 */
export interface CorruptEmbeddingEvent {
  /** The affected row's id. */
  readonly id: string
  /** Raw BLOB byte length that failed to decode. */
  readonly byteLength: number
}

/** Construction options. All optional — default behavior is byte-identical to
 *  the pre-C-18 store (no observer ⇒ silent fail-open, as before). */
export interface SqliteStoreOptions {
  /** Invoked (no-throw — a throwing observer is swallowed) once per row that
   *  carries a non-null but undecodable embedding BLOB, during read paths
   *  ({@link SqliteStore.get} / {@link SqliteStore.all} / {@link SqliteStore.recall}). */
  readonly onCorruptEmbedding?: (event: CorruptEmbeddingEvent) => void
}

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
  private readonly onCorruptEmbedding?: (event: CorruptEmbeddingEvent) => void

  /** @param path file path, or ":memory:" for an ephemeral db.
   *  @param opts optional observability seam (see {@link SqliteStoreOptions}). */
  constructor(path = ":memory:", opts: SqliteStoreOptions = {}) {
    if (opts.onCorruptEmbedding !== undefined) {
      this.onCorruptEmbedding = opts.onCorruptEmbedding
    }
    // ADR-0557: `bun:sqlite` does not create intermediate directories, and the
    // default store now lives under `~/.quanta/memory/` which may not exist on
    // a fresh machine. Create the parent (idempotent) before opening a FILE
    // path; in-memory / temp / URI forms are left to sqlite.
    if (path !== ":memory:" && path !== "" && !path.startsWith("file:")) {
      mkdirSync(dirname(path), { recursive: true })
    }
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
        session_id TEXT,
        task_group TEXT,
        applies_to_cwd TEXT,
        reuse_rule TEXT,
        last_decayed_at INTEGER
      )
    `)
    this.migrate()
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at)")
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind)")
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_memories_superseded_by ON memories(superseded_by)")

    this.insertStmt = this.db.query(`
      INSERT INTO memories (
        id, kind, tier, text, tags, importance, created_at, updated_at,
        access_count, last_accessed_at, embedding, superseded_by, session_id,
        task_group, applies_to_cwd, reuse_rule, last_decayed_at
      ) VALUES (
        $id, $kind, $tier, $text, $tags, $importance, $created_at, $updated_at,
        $access_count, $last_accessed_at, $embedding, $superseded_by, $session_id,
        $task_group, $applies_to_cwd, $reuse_rule, $last_decayed_at
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
        session_id = excluded.session_id,
        task_group = excluded.task_group,
        applies_to_cwd = excluded.applies_to_cwd,
        reuse_rule = excluded.reuse_rule,
        last_decayed_at = excluded.last_decayed_at
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
    // R-Phase5 P1-H: an INSERT can fail synchronously for non-data reasons
    // (database locked, disk full, constraint violation introduced by a
    // future schema bug) AND embedding serialization can throw if the vector
    // is structurally malformed (NaN, length mismatch, ArrayBuffer corrupt).
    // Wrap both so callers see a structured `Promise.reject(Error)` instead
    // of a synchronous throw out of a function whose signature promises a
    // Promise. The error message names the entry id so trajectory/probe can
    // correlate. `persistSession` (caller) already swallows + reports stats.
    try {
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
        $task_group: n.taskGroup ?? null,
        $applies_to_cwd: n.appliesTo?.cwd ?? null,
        $reuse_rule: n.reuseRule ?? null,
        $last_decayed_at: n.lastDecayedAt ?? null,
      })
    } catch (e) {
      const message = errMessage(e)
      return Promise.reject(new Error(`SqliteStore.save(${n.id}) failed: ${message}`))
    }
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
    // R-Phase5 / audit C-5: a DELETE has the same synchronous failure modes as
    // save()'s INSERT (database locked / disk full / handle closed). The
    // signature promises `Promise<void>`, so a synchronous throw would bypass
    // the promise boundary and escape callers' `await` try/catch (the eviction
    // sweep / memory-tools delete). Normalize the failure into a rejected
    // promise so the contract holds end-to-end.
    try {
      this.deleteStmt.run(id)
    } catch (e) {
      return Promise.reject(new Error(`SqliteStore.delete(${id}) failed: ${errMessage(e)}`))
    }
    return Promise.resolve()
  }

  /** Map a row to an entry, surfacing a corrupt-embedding degradation (C-18)
   *  via the injected observer before delegating to the shared mapper. The
   *  observer is no-throw — a hostile observer can never break a read. */
  private toEntry(row: MemoryRow): MemoryEntry {
    if (
      this.onCorruptEmbedding !== undefined &&
      row.embedding !== null &&
      deserializeVec(row.embedding) === undefined
    ) {
      try {
        this.onCorruptEmbedding({ id: row.id, byteLength: row.embedding.byteLength })
      } catch {
        // Observability is advisory; never let it break the read.
      }
    }
    return rowToEntry(row)
  }

  get(id: string): Promise<MemoryEntry | undefined> {
    const row = this.selectByIdStmt.get(id) as MemoryRow | null
    return Promise.resolve(row ? normalizeEntry(this.toEntry(row)) : undefined)
  }

  all(): Promise<MemoryEntry[]> {
    const rows = this.selectAllStmt.all() as MemoryRow[]
    return Promise.resolve(rows.map((r) => normalizeEntry(this.toEntry(r))))
  }

  recall(query: MemoryQuery, telemetry?: MemoryTelemetryPort): Promise<MemoryEntry[]> {
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
    const entries = rows.map((r) => this.toEntry(r))
    return Promise.resolve(rankEntries(entries, query, undefined, telemetry))
  }

  /** Test-only: the raw underlying handle, so a hellgate can inject a corrupt
   *  embedding BLOB the public API cannot produce. NOT for production use. */
  rawDbForTest(): Database {
    return this.db
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
    ...(row.task_group !== null ? { taskGroup: row.task_group } : {}),
    ...(row.applies_to_cwd !== null ? { appliesTo: { cwd: row.applies_to_cwd } } : {}),
    ...(row.reuse_rule !== null ? { reuseRule: row.reuse_rule } : {}),
    ...(row.last_decayed_at !== null ? { lastDecayedAt: row.last_decayed_at } : {}),
  }
}
