/**
 * Thread-history persistence for the web daemon.
 *
 * Storage: `bun:sqlite` (zero-dep, Bun-native). One DB file at
 * `~/.quanta/web-daemon/threads.db` (override via
 * `QUANTA_WEB_DB_DIR`). Two tables: `threads` (id + lifecycle stamps) and
 * `events` (append-only `SessionEvent` log, keyed by `(thread_id, event_id)`
 * so duplicate inserts are silently ignored — replay-safe).
 *
 * The store deliberately does NOT mutate the runtime — it just observes
 * the `SessionEvent` stream the `sharedSession.subscribe(...)` callback
 * forwards. Old threads stay in the DB even after the daemon shuts down;
 * a future iteration can add `/threads` HTTP endpoint + replay wire so
 * new clients see a transcript across daemon restarts.
 */

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { SessionEvent } from "@/protocol/session"
import { quantaHomeDir } from "@/shared"

export interface ThreadInfo {
  readonly id: string
  readonly title: string | null
  readonly createdAt: number
  readonly lastTouched: number
  readonly eventCount: number
}

export interface ThreadStore {
  /** Append one `SessionEvent` to the thread log. Idempotent on
   *  `(thread_id, event_id)` so retries / re-attach do not duplicate. */
  appendEvent(threadId: string, event: SessionEvent): void
  /** Load all events for a thread with `seq > sinceSeq` in ascending order. */
  loadEvents(threadId: string, sinceSeq?: number): readonly SessionEvent[]
  /** Insert the thread row if absent; bump `last_touched` always. */
  upsertThread(meta: { readonly id: string; readonly title?: string }): void
  /** List every persisted thread (most-recently-touched first). */
  listThreads(): readonly ThreadInfo[]
  /** Close the SQLite handle. Safe to call multiple times. */
  close(): void
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at INTEGER NOT NULL,
    last_touched INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    emitted_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_events_thread_event
    ON events(thread_id, event_id);
  CREATE INDEX IF NOT EXISTS idx_events_thread_seq
    ON events(thread_id, seq);
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous  = NORMAL;
`

/**
 * Open the SQLite-backed thread store. The DB file is created lazily;
 * the parent directory is created with `mkdir -p` semantics.
 */
export const openThreadStore = (): ThreadStore => {
  const dir = process.env.QUANTA_WEB_DB_DIR ?? join(quantaHomeDir(), "web-daemon")
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, "threads.db")
  const db = new Database(dbPath)
  db.exec(SCHEMA)

  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events
       (thread_id, seq, event_id, type, payload_json, emitted_at)
     VALUES ($threadId, $seq, $eventId, $type, $payload, $emittedAt)`,
  )
  const upsertThreadStmt = db.prepare(
    `INSERT INTO threads (id, title, created_at, last_touched)
     VALUES ($id, $title, $now, $now)
     ON CONFLICT(id) DO UPDATE
       SET last_touched = $now,
           title = COALESCE($title, threads.title)`,
  )
  const selectEventsStmt = db.prepare(
    `SELECT payload_json FROM events
     WHERE thread_id = $threadId AND seq > $sinceSeq
     ORDER BY seq ASC`,
  )
  const selectThreadsStmt = db.prepare(
    `SELECT threads.id        AS id,
            threads.title     AS title,
            threads.created_at AS createdAt,
            threads.last_touched AS lastTouched,
            (SELECT COUNT(*) FROM events WHERE thread_id = threads.id) AS eventCount
     FROM threads
     ORDER BY threads.last_touched DESC`,
  )

  let closed = false

  return {
    appendEvent(threadId, event) {
      if (closed) return
      const now = Date.now()
      upsertThreadStmt.run({
        $id: threadId,
        $title: null,
        $now: now,
      })
      insertEvent.run({
        $threadId: threadId,
        $seq: event.seq,
        $eventId: event.eventId,
        $type: event.type,
        $payload: JSON.stringify(event),
        $emittedAt: event.emittedAt,
      })
    },
    loadEvents(threadId, sinceSeq = 0) {
      if (closed) return []
      const rows = selectEventsStmt.all({
        $threadId: threadId,
        $sinceSeq: sinceSeq,
      }) as Array<{ payload_json: string }>
      return rows.map((r) => JSON.parse(r.payload_json) as SessionEvent)
    },
    upsertThread(meta) {
      if (closed) return
      const now = Date.now()
      upsertThreadStmt.run({
        $id: meta.id,
        $title: meta.title ?? null,
        $now: now,
      })
    },
    listThreads() {
      if (closed) return []
      return selectThreadsStmt.all() as readonly ThreadInfo[]
    },
    close() {
      if (closed) return
      closed = true
      try {
        db.close()
      } catch {
        // best-effort — caller may have already torn down
      }
    },
  }
}
