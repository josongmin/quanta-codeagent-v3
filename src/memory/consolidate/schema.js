/** Run on store construction (idempotent). Caller is the same place
 *  that opens the `memories` DB so the consolidator shares one connection. */
export const ensureConsolidateSchema = (db) => {
    // stage1_outputs — per-thread distillation row.
    // PRIMARY KEY = thread_id (UPSERT semantics: re-distilling the same
    // thread replaces the prior row). preference_signals is JSON-array TEXT
    // (sqlite has no native array; JSON keeps the migration cost zero).
    db.exec(`
    CREATE TABLE IF NOT EXISTS stage1_outputs (
      thread_id                                   TEXT    PRIMARY KEY,
      rollout_slug                                TEXT    NOT NULL,
      rollout_summary                             TEXT    NOT NULL,
      raw_memory                                  TEXT    NOT NULL,
      preference_signals                          TEXT    NOT NULL,
      source_updated_at                           INTEGER NOT NULL,
      selected_for_phase2                         INTEGER NOT NULL DEFAULT 0,
      selected_for_phase2_source_updated_at       INTEGER,
      last_usage                                  INTEGER,
      usage_count                                 INTEGER NOT NULL DEFAULT 0
    )
  `);
    // DESC index mirrors Codex `idx_stage1_outputs_source_updated_at`. Phase 2
    // fetches "rows newer than watermark, ordered DESC" — this index covers
    // both the WHERE and the ORDER BY.
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_stage1_outputs_source_updated_at
      ON stage1_outputs(source_updated_at DESC, thread_id DESC)
  `);
    // consolidate_watermark — singleton row keyed at id=1. The CHECK
    // constraint enforces exactly-one-row semantics at the schema level
    // (no application-layer race window for "two watermark rows" bug).
    db.exec(`
    CREATE TABLE IF NOT EXISTS consolidate_watermark (
      id                          INTEGER PRIMARY KEY CHECK (id = 1),
      last_success_at             INTEGER,
      last_init_at                INTEGER,
      last_consolidated_count     INTEGER NOT NULL DEFAULT 0
    )
  `);
    // Seed the singleton row if absent. INSERT OR IGNORE is the
    // standard SQLite idiom for "create if missing, otherwise no-op";
    // safe under concurrent first-runs because the PK + CHECK make any
    // second insert a no-op rather than a duplicate.
    db.exec(`
    INSERT OR IGNORE INTO consolidate_watermark (id, last_success_at, last_init_at, last_consolidated_count)
    VALUES (1, NULL, NULL, 0)
  `);
};
