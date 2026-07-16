/**
 * Prepared-statement bundle + SQL strings for the SQLite-backed
 * `AutomationEnginePort` adapter. Extracted verbatim from `../sqlite.ts`
 * (god-FUNCTION decomposition). All writes go through these so the schema
 * is single-sourced from `ensureAutomationEngineSchema` in `../sqlite.ts`.
 */

import type { Database, Statement } from "bun:sqlite"

export const INSERT_SQL = `
    INSERT INTO automations
      (id, title, rule_json, prompt, next_run_at, last_run_at, status,
       last_error, created_at, fire_count, model, model_fallbacks, kind,
       target_thread_id, inherited_policy)
    VALUES
      ($id, $title, $rule, $prompt, $next_run_at, NULL, 'scheduled',
       NULL, $created_at, 0, $model, $model_fallbacks, $kind,
       $target_thread_id, $inherited_policy)
  `

export const EXISTS_SQL = "SELECT 1 AS n FROM automations WHERE id = ?"

export const LIST_SQL = `
    SELECT * FROM automations
    WHERE status != 'cancelled'
    ORDER BY next_run_at ASC, id ASC
  `

export const CANCEL_SQL = `
    UPDATE automations SET status = 'cancelled'
    WHERE id = ? AND status != 'cancelled'
  `

export const NEXT_SQL = `
    SELECT * FROM automations
    WHERE status = 'scheduled' AND next_run_at <= ?
    ORDER BY next_run_at ASC, id ASC
    LIMIT 1
  `

export const GET_SQL = "SELECT * FROM automations WHERE id = ?"

export const LIVE_HEARTBEAT_FOR_THREAD_SQL = `
  SELECT 1 AS n FROM automations
  WHERE kind = 'heartbeat' AND target_thread_id = ?
    AND status IN ('scheduled', 'running')
  LIMIT 1
`

export const UPDATE_ON_RUN_SQL = `
    UPDATE automations SET
      last_run_at = $last_run_at,
      next_run_at = $next_run_at,
      status      = $status,
      last_error  = $last_error,
      fire_count  = fire_count + 1,
      claim_token = NULL,
      claimed_at  = NULL
    WHERE id = $id AND status != 'cancelled'
  `

// T10 — atomic claim. A SINGLE `UPDATE ... RETURNING` flips the soonest-due
// claimable row to `running` and hands it back, so two overlapping ticker
// callers can never receive the same row. A `scheduled` row is always
// claimable; a `running` row is claimable ONLY when its claim is stale
// (claimed_at <= $reclaim_before) — recovering a crashed worker's claim.
export const CLAIM_SQL = `
    UPDATE automations SET
      status      = 'running',
      claim_token = $claim_token,
      claimed_at  = $claimed_at
    WHERE id = (
      SELECT id FROM automations
      WHERE (status = 'scheduled' AND next_run_at <= $now)
         OR (status = 'running'
             AND $reclaim_before IS NOT NULL
             AND claimed_at IS NOT NULL
             AND claimed_at <= $reclaim_before)
      ORDER BY next_run_at ASC, id ASC
      LIMIT 1
    )
    RETURNING *
  `

export const INSERT_RUN_SQL = `
    INSERT INTO automation_runs (id, automation_id, fired_at, outcome, error_message)
    VALUES ($id, $automation_id, $fired_at, $outcome, $error_message)
  `

export const INSERT_INBOX_SQL = `
    INSERT INTO inbox_items (id, automation_id, title, summary, created_at, read)
    VALUES ($id, $automation_id, $title, $summary, $created_at, 0)
  `

/** All prepared statements used by the engine methods. */
export interface PreparedStatements {
  readonly insert: Statement
  readonly exists: Statement
  readonly list: Statement
  readonly cancel: Statement
  readonly next: Statement
  readonly get: Statement
  readonly liveHeartbeatForThread: Statement
  readonly updateOnRun: Statement
  readonly claim: Statement
  readonly insertRun: Statement
  readonly insertInbox: Statement
}

/** Prepare all statements once on construction. */
export const prepareStatements = (db: Database): PreparedStatements => ({
  insert: db.query(INSERT_SQL),
  exists: db.query(EXISTS_SQL),
  list: db.query(LIST_SQL),
  cancel: db.query(CANCEL_SQL),
  next: db.query(NEXT_SQL),
  get: db.query(GET_SQL),
  liveHeartbeatForThread: db.query(LIVE_HEARTBEAT_FOR_THREAD_SQL),
  updateOnRun: db.query(UPDATE_ON_RUN_SQL),
  claim: db.query(CLAIM_SQL),
  insertRun: db.query(INSERT_RUN_SQL),
  insertInbox: db.query(INSERT_INBOX_SQL),
})
