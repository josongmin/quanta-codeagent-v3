/**
 * ADR-0215 — Hexagonal `AutomationEnginePort` (engine seam).
 *
 * Codex `automations` / `automation_runs` / `inbox_items` are the production
 * reference; this port wraps the 5-verb engine surface so the host swaps
 * `inMemoryAutomationEngine` (tests) ↔ `sqliteAutomationEngine` (prod) without
 * touching call sites. The port is intentionally THIN: the RRULE parser
 * (sibling `@/scheduler/rrule-parser`) supplies `next_run_at`; this layer
 * persists + invokes.
 *
 * Default-OFF: the port is constructed lazily by the host. Importing the
 * barrel does NOT open a SQLite handle / create a table.
 *
 * NO-THROW public surface: every method returns a typed `Result<…>` so the
 * caller branches on `ok: false` rather than catching. `markRun` is the only
 * write-with-side-effects verb; failures surface as `ok:false` with the row
 * left in its previous state (no half-write).
 *
 * EXACTLY one row per `id`. `cancel` is idempotent (cancelling a missing id
 * is `{ ok:true }`); `markRun` on a missing/cancelled id is `{ ok:false,
 * code:"not-found" }` so the scheduler observes the divergence.
 *
 * Slice: `@/scheduler/automation-engine`. Imports nothing from outside this
 * directory + `../types` (shared `RRule`).
 */

import type { RRule } from "../types"

/** 4-arm engine lifecycle. Distinct from `AutomationStatus` (host UX) — the
 *  engine only cares about fire-eligibility, so `paused` collapses to
 *  `cancelled` here (engine doesn't expose resume; that's the host's job by
 *  re-scheduling). */
export type EngineStatus = "scheduled" | "fired" | "cancelled" | "errored"

/** All engine statuses — closed array for exhaustiveness checks. */
export const ALL_ENGINE_STATUSES: ReadonlyArray<EngineStatus> = [
  "scheduled",
  "fired",
  "cancelled",
  "errored",
]

/**
 * Persisted automation row — slim mirror of Codex `automations` table.
 *
 * exactOptionalPropertyTypes: `lastRunAt` / `lastError` keys are OMITTED
 * when absent. Serializers (sqlite mapper + in-memory clone) MUST preserve
 * omission, never emit `field: undefined`.
 */
export interface EngineAutomation {
  readonly id: string
  /** Human label — Codex calls this `name`; we keep `title` to match our
   *  existing `Automation` type. */
  readonly title: string
  /** The recurring rule. Parsed elsewhere; the engine stores it verbatim. */
  readonly rule: RRule
  readonly prompt: string
  /** ms-epoch — when the next fire SHOULD occur per the rule. */
  readonly nextRunAt: number
  /** ms-epoch — most recent successful fire. KEY OMITTED on a freshly
   *  scheduled row (never been fired). */
  readonly lastRunAt?: number
  /** Closed engine lifecycle (see {@link EngineStatus}). */
  readonly status: EngineStatus
  /** Free-form error string when `status === 'errored'`. KEY OMITTED
   *  otherwise. */
  readonly lastError?: string
  /** ms-epoch when the row was first scheduled. */
  readonly createdAt: number
  /** Cumulative fire count — preserved across status transitions. */
  readonly fireCount: number
}

/** Input to `schedule()` — caller already computed `nextRunAt`. */
export interface ScheduleInput {
  readonly id: string
  readonly title: string
  readonly rule: RRule
  readonly prompt: string
  readonly nextRunAt: number
  readonly createdAt: number
}

/**
 * Codex `automation_runs` row — per-fire audit trail. Append-only.
 *
 * `outcome` is closed: `fired` (handler returned without throwing) /
 * `errored` (handler threw — `errorMessage` populated).
 */
export interface AutomationRun {
  readonly id: string
  readonly automationId: string
  readonly firedAt: number
  readonly outcome: "fired" | "errored"
  readonly errorMessage?: string
}

/**
 * Codex `inbox_items` row — host-facing notification trail. Written
 * synchronously with the run by `markRun` so the host's inbox UI sees a
 * complete history.
 *
 * `read` defaults to `false` on creation; the host flips it via its own
 * UI path (not exposed on the engine port — engine is write-side only).
 */
export interface InboxItem {
  readonly id: string
  readonly automationId: string
  readonly title: string
  readonly summary: string
  readonly createdAt: number
  readonly read: boolean
}

/** Closed result discriminated union — no throw. */
export type EngineResult<T> = { readonly ok: true; readonly value: T } | EngineErrorResult

export type EngineErrorResult =
  | { readonly ok: false; readonly code: "duplicate-id"; readonly message: string }
  | { readonly ok: false; readonly code: "not-found"; readonly message: string }
  | { readonly ok: false; readonly code: "io-failed"; readonly message: string }
  | { readonly ok: false; readonly code: "invalid-input"; readonly message: string }

/**
 * The 5-verb closed engine seam.
 *
 * - `schedule` — create a new row. Rejects on duplicate id.
 * - `list`     — enumerate ALL non-cancelled rows. (Cancelled rows survive
 *                as tombstones for re-schedule prevention; not returned to
 *                the caller.) Order: `nextRunAt ASC, id ASC` for
 *                determinism.
 * - `cancel`   — soft-delete by id. Idempotent (missing id ⇒ ok:true).
 * - `next`     — find the soonest-due row at-or-before `now`. Returns
 *                `value: null` when no row is due.
 * - `markRun`  — record a fire (writes `automation_runs` + `inbox_items` +
 *                bumps `lastRunAt`/`nextRunAt`/`fireCount`). If `nextRunAt`
 *                is null in input, status transitions to `fired` and the
 *                row stops appearing in `next`.
 */
export interface AutomationEnginePort {
  schedule(input: ScheduleInput): Promise<EngineResult<EngineAutomation>>
  list(): Promise<EngineResult<ReadonlyArray<EngineAutomation>>>
  cancel(id: string): Promise<EngineResult<void>>
  next(now: number): Promise<EngineResult<EngineAutomation | null>>
  markRun(input: MarkRunInput): Promise<EngineResult<EngineAutomation>>
}

/**
 * Input to `markRun`. The caller (ticker) supplies the next-fire computation
 * outcome via `nextRunAt`:
 *   - number → row stays `scheduled`, its `nextRunAt` advances.
 *   - null   → row transitions to `fired` (rule exhausted) and stops being
 *              picked by `next()`.
 */
export interface MarkRunInput {
  readonly id: string
  readonly firedAt: number
  readonly outcome: "fired" | "errored"
  readonly errorMessage?: string
  /** Next fire timestamp, or null to retire the row. */
  readonly nextRunAt: number | null
  /** Inbox surface — host-facing title + summary for the run. */
  readonly inboxTitle: string
  readonly inboxSummary: string
}
