/**
 * ADR-0215 — SQLite `AutomationEnginePort` adapter (Codex schema verbatim).
 *
 * 3 tables — names + columns mirror the Codex `~/.codex/sqlite/codex-dev.db`
 * production schema observed in `docs/reviews-codex-agent/thread-management/
 * storage-and-db-audit.md` so a Codex-trained operator can read our DB and
 * a future v3 ↔ Codex round-trip stays plausible:
 *
 *   automations       (id PK, name, prompt, status, next_run_at, last_run_at,
 *                      rrule, model, model_fallbacks, last_error, created_at,
 *                      fire_count)
 *   automation_runs   (id PK, automation_id, fired_at, outcome, error_message)
 *   inbox_items       (id PK, automation_id, title, summary, created_at, read)
 *
 * Notes on divergence from Codex:
 *   - We don't yet have a `cwds` column — single-workspace v3 path.
 *   - `reasoning_effort` is wired elsewhere (ADR-0057) so we don't dup here.
 *   - `archived_*` columns on inbox are deferred (no user-message capture yet).
 *
 * NO-THROW: every public method returns `EngineResult`. All sqlite errors are
 * caught and mapped to `code:"io-failed"`. Schema migration runs ONCE on
 * construction; constructor MAY throw (host bootstrap is the right place for
 * "your disk is broken" loudness).
 *
 * Default-OFF: importing this module does not open a connection. The host
 * supplies the `Database` (so test code can pass `:memory:` and prod can pass
 * the resolved `~/.quanta/sqlite/automations.db`).
 *
 * Atomicity: `markRun` wraps the 3-table write in a SQLite transaction so
 * either ALL three updates land or none do (no half-written inbox).
 */

import type { Database } from "bun:sqlite"
import type { AutomationEnginePort } from "./port"
import { defaultRunIdAllocator, makeSeq, type RunIdAllocator } from "./run-model"
import {
  cancel,
  claim,
  type Deps,
  finalize,
  list,
  listAutomationRuns,
  listInboxItems,
  markRun,
  next,
  schedule,
} from "./sqlite/operations"
import { prepareStatements } from "./sqlite/statements"

// Re-export the read-side helpers from their new home so existing
// `./sqlite` importers (`./index.ts`, hellgate tests) keep working.
export { listAutomationRuns, listInboxItems }

/** Idempotent migration — create all 3 tables + supporting indices. */
export const ensureAutomationEngineSchema = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automations (
      id              TEXT    PRIMARY KEY,
      title           TEXT    NOT NULL,
      rule_json       TEXT    NOT NULL,
      prompt          TEXT    NOT NULL,
      next_run_at     INTEGER NOT NULL,
      last_run_at     INTEGER,
      status          TEXT    NOT NULL,
      last_error      TEXT,
      created_at      INTEGER NOT NULL,
      fire_count      INTEGER NOT NULL DEFAULT 0,
      claim_token     TEXT,
      claimed_at      INTEGER,
      model           TEXT,
      model_fallbacks TEXT
    )
  `)
  // T10 — additive migration for DBs created before the claim/finalize run
  // model. `ALTER TABLE ADD COLUMN` is idempotent here only via a probe (it
  // throws on a duplicate column), so guard on the pragma column list.
  ensureColumn(db, "automations", "claim_token", "TEXT")
  ensureColumn(db, "automations", "claimed_at", "INTEGER")
  // B2 — additive migration for the per-task model columns (Codex
  // `automations.model` / `.model_fallbacks`). `model_fallbacks` stores a JSON
  // array string; NULL ⇒ key omitted on read.
  ensureColumn(db, "automations", "model", "TEXT")
  ensureColumn(db, "automations", "model_fallbacks", "TEXT")
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_automations_next_run
      ON automations(status, next_run_at)
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id              TEXT    PRIMARY KEY,
      automation_id   TEXT    NOT NULL,
      fired_at        INTEGER NOT NULL,
      outcome         TEXT    NOT NULL,
      error_message   TEXT
    )
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runs_automation_id
      ON automation_runs(automation_id, fired_at DESC)
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      id              TEXT    PRIMARY KEY,
      automation_id   TEXT    NOT NULL,
      title           TEXT    NOT NULL,
      summary         TEXT    NOT NULL,
      created_at      INTEGER NOT NULL,
      read            INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_inbox_automation
      ON inbox_items(automation_id, created_at DESC)
  `)
}

/** Add `column` to `table` if a pre-T10 DB lacks it. Idempotent. */
const ensureColumn = (db: Database, table: string, column: string, type: string): void => {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (cols.some((c) => c.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}

export interface SqliteAutomationEngineOpts {
  /** Override run / inbox id generation (tests). The `seq` argument is a
   *  monotonic same-ms disambiguator (T10 M8). */
  readonly idAllocator?: RunIdAllocator
}

export const sqliteAutomationEngine = (
  db: Database,
  opts: SqliteAutomationEngineOpts = {},
): AutomationEnginePort => {
  ensureAutomationEngineSchema(db)
  const deps: Deps = {
    db,
    stmts: prepareStatements(db),
    idAlloc: opts.idAllocator ?? defaultRunIdAllocator,
    nextSeq: makeSeq(),
  }

  return {
    schedule: (input) => schedule(deps, input),
    list: () => list(deps),
    cancel: (id) => cancel(deps, id),
    next: (now) => next(deps, now),
    markRun: (input) => markRun(deps, input),
    claim: (now, claimOpts) => claim(deps, now, claimOpts),
    finalize: (input) => finalize(deps, input),
  }
}
