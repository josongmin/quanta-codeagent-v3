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
import { errMessage } from "@/shared"
import type { RRule, Weekday } from "../types"
import type {
  AutomationEnginePort,
  AutomationRun,
  ClaimedRun,
  ClaimOpts,
  EngineAutomation,
  EngineResult,
  EngineStatus,
  FinalizeInput,
  InboxItem,
  MarkRunInput,
  ScheduleInput,
} from "./port"
import {
  advancedStatus,
  defaultRunIdAllocator,
  makeSeq,
  mintClaimToken,
  type RunIdAllocator,
} from "./run-model"

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
      claimed_at      INTEGER
    )
  `)
  // T10 — additive migration for DBs created before the claim/finalize run
  // model. `ALTER TABLE ADD COLUMN` is idempotent here only via a probe (it
  // throws on a duplicate column), so guard on the pragma column list.
  ensureColumn(db, "automations", "claim_token", "TEXT")
  ensureColumn(db, "automations", "claimed_at", "INTEGER")
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

interface AutomationRow {
  id: string
  title: string
  rule_json: string
  prompt: string
  next_run_at: number
  last_run_at: number | null
  status: string
  last_error: string | null
  created_at: number
  fire_count: number
  claim_token: string | null
  claimed_at: number | null
}

const isEngineStatus = (s: string): s is EngineStatus =>
  s === "scheduled" ||
  s === "running" ||
  s === "fired" ||
  s === "cancelled" ||
  s === "errored"

const parseRuleJson = (raw: string): RRule | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const r = parsed as Partial<RRule>
  if (r.freq !== "DAILY" && r.freq !== "WEEKLY" && r.freq !== "MONTHLY") return undefined
  const base = { freq: r.freq } as { freq: RRule["freq"] }
  return {
    ...base,
    ...(typeof r.interval === "number" ? { interval: r.interval } : {}),
    ...(typeof r.count === "number" ? { count: r.count } : {}),
    ...(typeof r.until === "number" ? { until: r.until } : {}),
    ...(Array.isArray(r.byDay) ? { byDay: r.byDay as ReadonlyArray<Weekday> } : {}),
    ...(Array.isArray(r.byMonthDay) ? { byMonthDay: r.byMonthDay as ReadonlyArray<number> } : {}),
  }
}

const rowToEngineAutomation = (row: AutomationRow): EngineAutomation | undefined => {
  if (!isEngineStatus(row.status)) return undefined
  const rule = parseRuleJson(row.rule_json)
  if (rule === undefined) return undefined
  const base = {
    id: row.id,
    title: row.title,
    rule,
    prompt: row.prompt,
    nextRunAt: row.next_run_at,
    status: row.status,
    createdAt: row.created_at,
    fireCount: row.fire_count,
  } as const
  return {
    ...base,
    ...(row.last_run_at !== null ? { lastRunAt: row.last_run_at } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    ...(row.claim_token !== null ? { claimToken: row.claim_token } : {}),
    ...(row.claimed_at !== null ? { claimedAt: row.claimed_at } : {}),
  }
}

const ioFail = (message: string): EngineResult<never> => ({
  ok: false,
  code: "io-failed",
  message,
})

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
  const idAlloc = opts.idAllocator ?? defaultRunIdAllocator
  const nextSeq = makeSeq()

  const insertStmt = db.query(`
    INSERT INTO automations
      (id, title, rule_json, prompt, next_run_at, last_run_at, status,
       last_error, created_at, fire_count)
    VALUES
      ($id, $title, $rule, $prompt, $next_run_at, NULL, 'scheduled',
       NULL, $created_at, 0)
  `)
  const existsStmt = db.query("SELECT 1 AS n FROM automations WHERE id = ?")
  const listStmt = db.query(`
    SELECT * FROM automations
    WHERE status != 'cancelled'
    ORDER BY next_run_at ASC, id ASC
  `)
  const cancelStmt = db.query(`
    UPDATE automations SET status = 'cancelled'
    WHERE id = ? AND status != 'cancelled'
  `)
  const nextStmt = db.query(`
    SELECT * FROM automations
    WHERE status = 'scheduled' AND next_run_at <= ?
    ORDER BY next_run_at ASC, id ASC
    LIMIT 1
  `)
  const getStmt = db.query("SELECT * FROM automations WHERE id = ?")
  const updateOnRunStmt = db.query(`
    UPDATE automations SET
      last_run_at = $last_run_at,
      next_run_at = $next_run_at,
      status      = $status,
      last_error  = $last_error,
      fire_count  = fire_count + 1,
      claim_token = NULL,
      claimed_at  = NULL
    WHERE id = $id AND status != 'cancelled'
  `)
  // T10 — atomic claim. A SINGLE `UPDATE ... RETURNING` flips the soonest-due
  // claimable row to `running` and hands it back, so two overlapping ticker
  // callers can never receive the same row. A `scheduled` row is always
  // claimable; a `running` row is claimable ONLY when its claim is stale
  // (claimed_at <= $reclaim_before) — recovering a crashed worker's claim.
  const claimStmt = db.query(`
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
  `)
  const insertRunStmt = db.query(`
    INSERT INTO automation_runs (id, automation_id, fired_at, outcome, error_message)
    VALUES ($id, $automation_id, $fired_at, $outcome, $error_message)
  `)
  const insertInboxStmt = db.query(`
    INSERT INTO inbox_items (id, automation_id, title, summary, created_at, read)
    VALUES ($id, $automation_id, $title, $summary, $created_at, 0)
  `)

  return {
    schedule(input: ScheduleInput): Promise<EngineResult<EngineAutomation>> {
      if (input.id.length === 0) {
        return Promise.resolve({
          ok: false,
          code: "invalid-input",
          message: "id is empty",
        })
      }
      try {
        const dup = existsStmt.get(input.id)
        if (dup !== null) {
          return Promise.resolve({
            ok: false,
            code: "duplicate-id",
            message: `automation '${input.id}' already scheduled`,
          })
        }
        insertStmt.run({
          $id: input.id,
          $title: input.title,
          $rule: JSON.stringify(input.rule),
          $prompt: input.prompt,
          $next_run_at: input.nextRunAt,
          $created_at: input.createdAt,
        })
      } catch (e) {
        return Promise.resolve(ioFail(`schedule failed: ${errMessage(e)}`))
      }
      const row = getStmt.get(input.id) as AutomationRow | null
      if (row === null) {
        return Promise.resolve(ioFail("schedule: row vanished after insert"))
      }
      const mapped = rowToEngineAutomation(row)
      if (mapped === undefined) {
        return Promise.resolve(ioFail("schedule: row malformed after insert"))
      }
      return Promise.resolve({ ok: true, value: mapped })
    },

    list(): Promise<EngineResult<ReadonlyArray<EngineAutomation>>> {
      let rows: unknown[]
      try {
        rows = listStmt.all() as unknown[]
      } catch (e) {
        return Promise.resolve(ioFail(`list failed: ${errMessage(e)}`))
      }
      const out: EngineAutomation[] = []
      for (const r of rows) {
        if (typeof r !== "object" || r === null) continue
        const mapped = rowToEngineAutomation(r as AutomationRow)
        if (mapped !== undefined) out.push(mapped)
      }
      return Promise.resolve({ ok: true, value: out })
    },

    cancel(id: string): Promise<EngineResult<void>> {
      try {
        cancelStmt.run(id)
      } catch (e) {
        return Promise.resolve(ioFail(`cancel failed: ${errMessage(e)}`))
      }
      return Promise.resolve({ ok: true, value: undefined })
    },

    next(now: number): Promise<EngineResult<EngineAutomation | null>> {
      let row: unknown
      try {
        row = nextStmt.get(now)
      } catch (e) {
        return Promise.resolve(ioFail(`next failed: ${errMessage(e)}`))
      }
      if (row === null) return Promise.resolve({ ok: true, value: null })
      const mapped = rowToEngineAutomation(row as AutomationRow)
      if (mapped === undefined) {
        return Promise.resolve(ioFail("next: row malformed"))
      }
      return Promise.resolve({ ok: true, value: mapped })
    },

    markRun(input: MarkRunInput): Promise<EngineResult<EngineAutomation>> {
      const existing = getStmt.get(input.id) as AutomationRow | null
      if (existing === null || existing.status === "cancelled") {
        return Promise.resolve({
          ok: false,
          code: "not-found",
          message: `automation '${input.id}' not found / cancelled`,
        })
      }
      return Promise.resolve(runFinalize(input))
    },

    claim(now: number, claimOpts?: ClaimOpts): Promise<EngineResult<ClaimedRun | null>> {
      const claimToken = mintClaimToken(`pending-${now}`, now, nextSeq())
      let row: unknown
      try {
        // Single atomic UPDATE...RETURNING — the row flips to `running` and is
        // returned in ONE statement, so an overlapping claim cannot see it as
        // `scheduled`.
        row = claimStmt.get({
          $now: now,
          $claim_token: claimToken,
          $claimed_at: now,
          $reclaim_before: claimOpts?.reclaimBefore ?? null,
        })
      } catch (e) {
        return Promise.resolve(ioFail(`claim failed: ${errMessage(e)}`))
      }
      if (row === null || row === undefined) {
        return Promise.resolve({ ok: true, value: null })
      }
      const mapped = rowToEngineAutomation(row as AutomationRow)
      if (mapped === undefined) {
        return Promise.resolve(ioFail("claim: row malformed"))
      }
      return Promise.resolve({ ok: true, value: { automation: mapped, claimToken } })
    },

    finalize(input: FinalizeInput): Promise<EngineResult<EngineAutomation>> {
      const existing = getStmt.get(input.id) as AutomationRow | null
      if (
        existing === null ||
        existing.status !== "running" ||
        existing.claim_token !== input.claimToken
      ) {
        return Promise.resolve({
          ok: false,
          code: "not-found",
          message: `automation '${input.id}' not claimable / token mismatch`,
        })
      }
      return Promise.resolve(runFinalize(input))
    },
  }

  /** Shared finalize body for `markRun` + `finalize`: 3-table atomic write
   *  (run + inbox + advance), with the post-fire status decided by the shared
   *  {@link advancedStatus} rule so both verbs stay byte-equal. Caller has
   *  already validated the row is finalize-eligible. */
  function runFinalize(input: {
    id: string
    firedAt: number
    outcome: "fired" | "errored"
    errorMessage?: string
    nextRunAt: number | null
    inboxTitle: string
    inboxSummary: string
  }): EngineResult<EngineAutomation> {
    const nextStatus: EngineStatus = advancedStatus(input.outcome, input.nextRunAt !== null)
    const persistedNextRunAt = input.nextRunAt ?? input.firedAt
    const errorBind: string | null =
      input.outcome === "errored" && input.errorMessage !== undefined ? input.errorMessage : null

    const seq = nextSeq()
    const runId = idAlloc("run", input.id, input.firedAt, seq)
    const inboxId = idAlloc("inbox", input.id, input.firedAt, seq)

    try {
      db.transaction(() => {
        insertRunStmt.run({
          $id: runId,
          $automation_id: input.id,
          $fired_at: input.firedAt,
          $outcome: input.outcome,
          $error_message: errorBind,
        })
        insertInboxStmt.run({
          $id: inboxId,
          $automation_id: input.id,
          $title: input.inboxTitle,
          $summary: input.inboxSummary,
          $created_at: input.firedAt,
        })
        updateOnRunStmt.run({
          $id: input.id,
          $last_run_at: input.firedAt,
          $next_run_at: persistedNextRunAt,
          $status: nextStatus,
          $last_error: errorBind,
        })
      })()
    } catch (e) {
      return ioFail(`finalize failed: ${errMessage(e)}`)
    }

    const after = getStmt.get(input.id) as AutomationRow | null
    if (after === null) return ioFail("finalize: row vanished after update")
    const mapped = rowToEngineAutomation(after)
    if (mapped === undefined) return ioFail("finalize: row malformed after update")
    return { ok: true, value: mapped }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Read-side helpers for tests / host UX. NOT on the engine port — the engine is
// write-side only; the host owns its own inbox read UI. These are exported so
// hellgate tests can assert what landed on disk.
// ──────────────────────────────────────────────────────────────────────────────

export const listAutomationRuns = (db: Database, automationId: string): AutomationRun[] => {
  const stmt = db.query(`
    SELECT id, automation_id, fired_at, outcome, error_message
    FROM automation_runs
    WHERE automation_id = ?
    ORDER BY fired_at ASC, id ASC
  `)
  const rows = stmt.all(automationId) as Array<{
    id: string
    automation_id: string
    fired_at: number
    outcome: string
    error_message: string | null
  }>
  const out: AutomationRun[] = []
  for (const r of rows) {
    if (r.outcome !== "fired" && r.outcome !== "errored") continue
    const base = {
      id: r.id,
      automationId: r.automation_id,
      firedAt: r.fired_at,
      outcome: r.outcome,
    } as const
    out.push(r.error_message !== null ? { ...base, errorMessage: r.error_message } : { ...base })
  }
  return out
}

export const listInboxItems = (db: Database, automationId?: string): InboxItem[] => {
  const stmt =
    automationId === undefined
      ? db.query(
          "SELECT id, automation_id, title, summary, created_at, read FROM inbox_items ORDER BY created_at ASC, id ASC",
        )
      : db.query(
          "SELECT id, automation_id, title, summary, created_at, read FROM inbox_items WHERE automation_id = ? ORDER BY created_at ASC, id ASC",
        )
  const rows = (automationId === undefined ? stmt.all() : stmt.all(automationId)) as Array<{
    id: string
    automation_id: string
    title: string
    summary: string
    created_at: number
    read: number
  }>
  return rows.map((r) => ({
    id: r.id,
    automationId: r.automation_id,
    title: r.title,
    summary: r.summary,
    createdAt: r.created_at,
    read: r.read === 1,
  }))
}
