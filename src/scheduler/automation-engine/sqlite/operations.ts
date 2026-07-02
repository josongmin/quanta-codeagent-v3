/**
 * Engine-method bodies + row-mapping helpers for the SQLite-backed
 * `AutomationEnginePort` adapter. Extracted verbatim from `../sqlite.ts`
 * (god-FUNCTION decomposition). Each method takes a {@link Deps} bundle
 * (db handle + prepared statements + id allocation state, passed BY
 * REFERENCE) so the returned port object is a thin delegating shell.
 */

import type { Database } from "bun:sqlite"
import { errMessage } from "@/shared"
import type { RRule, Weekday } from "../../types"
import type {
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
} from "../port"
import { advancedStatus, mintClaimToken, type RunIdAllocator } from "../run-model"
import type { PreparedStatements } from "./statements"

/** Everything the engine methods close over, passed BY REFERENCE. */
export interface Deps {
  readonly db: Database
  readonly stmts: PreparedStatements
  readonly idAlloc: RunIdAllocator
  readonly nextSeq: () => number
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
  model: string | null
  model_fallbacks: string | null
}

const isEngineStatus = (s: string): s is EngineStatus =>
  s === "scheduled" || s === "running" || s === "fired" || s === "cancelled" || s === "errored"

const parseRuleJson = (raw: string): RRule | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const r = parsed as Partial<RRule>
  if (
    r.freq !== "MINUTELY" &&
    r.freq !== "HOURLY" &&
    r.freq !== "DAILY" &&
    r.freq !== "WEEKLY" &&
    r.freq !== "MONTHLY"
  ) {
    return undefined
  }
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

/** Parse the persisted `model_fallbacks` JSON array. NULL / malformed / non-
 *  string-array ⇒ undefined (key omitted). Never throws. */
const parseModelFallbacks = (raw: string | null): ReadonlyArray<string> | undefined => {
  if (raw === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  if (!parsed.every((x): x is string => typeof x === "string")) return undefined
  return parsed
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
  const modelFallbacks = parseModelFallbacks(row.model_fallbacks)
  return {
    ...base,
    ...(row.last_run_at !== null ? { lastRunAt: row.last_run_at } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    ...(row.claim_token !== null ? { claimToken: row.claim_token } : {}),
    ...(row.claimed_at !== null ? { claimedAt: row.claimed_at } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    ...(modelFallbacks !== undefined ? { modelFallbacks } : {}),
  }
}

const ioFail = (message: string): EngineResult<never> => ({
  ok: false,
  code: "io-failed",
  message,
})

export const schedule = (
  deps: Deps,
  input: ScheduleInput,
): Promise<EngineResult<EngineAutomation>> => {
  if (input.id.length === 0) {
    return Promise.resolve({
      ok: false,
      code: "invalid-input",
      message: "id is empty",
    })
  }
  try {
    const dup = deps.stmts.exists.get(input.id)
    if (dup !== null) {
      return Promise.resolve({
        ok: false,
        code: "duplicate-id",
        message: `automation '${input.id}' already scheduled`,
      })
    }
    deps.stmts.insert.run({
      $id: input.id,
      $title: input.title,
      $rule: JSON.stringify(input.rule),
      $prompt: input.prompt,
      $next_run_at: input.nextRunAt,
      $created_at: input.createdAt,
      $model: input.model ?? null,
      $model_fallbacks:
        input.modelFallbacks !== undefined ? JSON.stringify(input.modelFallbacks) : null,
    })
  } catch (e) {
    return Promise.resolve(ioFail(`schedule failed: ${errMessage(e)}`))
  }
  const row = deps.stmts.get.get(input.id) as AutomationRow | null
  if (row === null) {
    return Promise.resolve(ioFail("schedule: row vanished after insert"))
  }
  const mapped = rowToEngineAutomation(row)
  if (mapped === undefined) {
    return Promise.resolve(ioFail("schedule: row malformed after insert"))
  }
  return Promise.resolve({ ok: true, value: mapped })
}

export const list = (deps: Deps): Promise<EngineResult<ReadonlyArray<EngineAutomation>>> => {
  let rows: unknown[]
  try {
    rows = deps.stmts.list.all() as unknown[]
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
}

export const cancel = (deps: Deps, id: string): Promise<EngineResult<void>> => {
  try {
    deps.stmts.cancel.run(id)
  } catch (e) {
    return Promise.resolve(ioFail(`cancel failed: ${errMessage(e)}`))
  }
  return Promise.resolve({ ok: true, value: undefined })
}

export const next = (deps: Deps, now: number): Promise<EngineResult<EngineAutomation | null>> => {
  let row: unknown
  try {
    row = deps.stmts.next.get(now)
  } catch (e) {
    return Promise.resolve(ioFail(`next failed: ${errMessage(e)}`))
  }
  if (row === null) return Promise.resolve({ ok: true, value: null })
  const mapped = rowToEngineAutomation(row as AutomationRow)
  if (mapped === undefined) {
    return Promise.resolve(ioFail("next: row malformed"))
  }
  return Promise.resolve({ ok: true, value: mapped })
}

export const markRun = (
  deps: Deps,
  input: MarkRunInput,
): Promise<EngineResult<EngineAutomation>> => {
  const existing = deps.stmts.get.get(input.id) as AutomationRow | null
  if (existing === null || existing.status === "cancelled") {
    return Promise.resolve({
      ok: false,
      code: "not-found",
      message: `automation '${input.id}' not found / cancelled`,
    })
  }
  return Promise.resolve(runFinalize(deps, input))
}

export const claim = (
  deps: Deps,
  now: number,
  claimOpts?: ClaimOpts,
): Promise<EngineResult<ClaimedRun | null>> => {
  const claimToken = mintClaimToken(`pending-${now}`, now, deps.nextSeq())
  let row: unknown
  try {
    // Single atomic UPDATE...RETURNING — the row flips to `running` and is
    // returned in ONE statement, so an overlapping claim cannot see it as
    // `scheduled`.
    row = deps.stmts.claim.get({
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
}

export const finalize = (
  deps: Deps,
  input: FinalizeInput,
): Promise<EngineResult<EngineAutomation>> => {
  const existing = deps.stmts.get.get(input.id) as AutomationRow | null
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
  return Promise.resolve(runFinalize(deps, input))
}

/** Shared finalize body for `markRun` + `finalize`: 3-table atomic write
 *  (run + inbox + advance), with the post-fire status decided by the shared
 *  {@link advancedStatus} rule so both verbs stay byte-equal. Caller has
 *  already validated the row is finalize-eligible. */
export const runFinalize = (
  deps: Deps,
  input: {
    id: string
    firedAt: number
    outcome: "fired" | "errored"
    errorMessage?: string
    nextRunAt: number | null
    inboxTitle: string
    inboxSummary: string
  },
): EngineResult<EngineAutomation> => {
  const nextStatus: EngineStatus = advancedStatus(input.outcome, input.nextRunAt !== null)
  const persistedNextRunAt = input.nextRunAt ?? input.firedAt
  const errorBind: string | null =
    input.outcome === "errored" && input.errorMessage !== undefined ? input.errorMessage : null

  const seq = deps.nextSeq()
  const runId = deps.idAlloc("run", input.id, input.firedAt, seq)
  const inboxId = deps.idAlloc("inbox", input.id, input.firedAt, seq)

  try {
    deps.db.transaction(() => {
      deps.stmts.insertRun.run({
        $id: runId,
        $automation_id: input.id,
        $fired_at: input.firedAt,
        $outcome: input.outcome,
        $error_message: errorBind,
      })
      deps.stmts.insertInbox.run({
        $id: inboxId,
        $automation_id: input.id,
        $title: input.inboxTitle,
        $summary: input.inboxSummary,
        $created_at: input.firedAt,
      })
      deps.stmts.updateOnRun.run({
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

  const after = deps.stmts.get.get(input.id) as AutomationRow | null
  if (after === null) return ioFail("finalize: row vanished after update")
  const mapped = rowToEngineAutomation(after)
  if (mapped === undefined) return ioFail("finalize: row malformed after update")
  return { ok: true, value: mapped }
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
