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

/** 5-arm engine lifecycle. Distinct from `AutomationStatus` (host UX) — the
 *  engine only cares about fire-eligibility, so `paused` collapses to
 *  `cancelled` here (engine doesn't expose resume; that's the host's job by
 *  re-scheduling).
 *
 *  `running` is the durable in-flight marker written by `claim()` — it is the
 *  middle state of the `claim -> execute -> finalize` run model (T10). A row
 *  in `running` is NOT re-handed-out by `next()`/`claim()` (so overlapping
 *  ticks cannot double-execute it) UNTIL `finalize()` transitions it back to
 *  `scheduled`/`fired`/`errored`, OR a restart reclaims a stale claim. */
export type EngineStatus = "scheduled" | "running" | "fired" | "cancelled" | "errored"

/** All engine statuses — closed array for exhaustiveness checks. */
export const ALL_ENGINE_STATUSES: ReadonlyArray<EngineStatus> = [
  "scheduled",
  "running",
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
   *  otherwise. Also retained while `status === 'scheduled'` after a
   *  recoverable error so the host can observe the last failure even though
   *  the row is still retrying (T10 H5). */
  readonly lastError?: string
  /** ms-epoch when the row was first scheduled. */
  readonly createdAt: number
  /** Cumulative fire count — preserved across status transitions. */
  readonly fireCount: number
  /** Opaque token written by `claim()` and cleared by `finalize()`. Present
   *  ONLY while `status === 'running'` (durable in-flight marker). KEY OMITTED
   *  otherwise. */
  readonly claimToken?: string
  /** ms-epoch when the row was claimed. Present ONLY while
   *  `status === 'running'`; used to reclaim stale claims after a crash. */
  readonly claimedAt?: number
  /** B2 — per-task first-choice model (Codex `automations.model`). The engine
   *  stores + returns it verbatim; model reroute is the host's job. KEY OMITTED
   *  when absent (byte-identical to a modelless row). */
  readonly model?: string
  /** B2 — ordered fallback probe list (Codex `automations.model_fallbacks`).
   *  KEY OMITTED when absent. */
  readonly modelFallbacks?: ReadonlyArray<string>
}

/** Input to `schedule()` — caller already computed `nextRunAt`. */
export interface ScheduleInput {
  readonly id: string
  readonly title: string
  readonly rule: RRule
  readonly prompt: string
  readonly nextRunAt: number
  readonly createdAt: number
  /** B2 — OPTIONAL per-task first-choice model. Absent ⇒ the row carries no
   *  model (host falls back to its global default). Persisted + returned. */
  readonly model?: string
  /** B2 — OPTIONAL ordered fallback probe list. Absent ⇒ omitted. */
  readonly modelFallbacks?: ReadonlyArray<string>
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
  /**
   * T10 — the `claim` verb of the `claim -> execute -> finalize` run model.
   *
   * Atomically pick the soonest-due `scheduled` row at-or-before `now`, flip
   * it to `running` with a fresh `claimToken`/`claimedAt`, and return it. The
   * flip is a SINGLE atomic statement (SQLite `UPDATE ... RETURNING`; the
   * in-memory engine does it under its synchronous critical section), so two
   * overlapping ticker invocations can never receive the SAME row — a fired
   * automation is executed at most once per due instant.
   *
   * `value: null` when nothing is claimable.
   *
   * `opts.reclaimBefore` — when set, a row already `running` whose `claimedAt`
   * is `<= reclaimBefore` (a stale claim left by a crashed worker) is also
   * eligible: it is re-claimed with a fresh token. Absent ⇒ only `scheduled`
   * rows are claimable.
   */
  claim(now: number, opts?: ClaimOpts): Promise<EngineResult<ClaimedRun | null>>
  /**
   * T10 — the `finalize` verb. Records the run + inbox rows and advances the
   * automation (back to `scheduled` for a live recurring fire, `fired` when
   * the rule is exhausted, `errored` only when an error coincides with rule
   * exhaustion). The supplied `claimToken` MUST match the row's current token
   * (the token the matching `claim()` returned); a mismatch yields
   * `not-found` so a stale worker cannot finalize a row another worker owns.
   */
  finalize(input: FinalizeInput): Promise<EngineResult<EngineAutomation>>
}

/** Options for {@link AutomationEnginePort.claim}. */
export interface ClaimOpts {
  /** Reclaim a stale `running` row whose `claimedAt <= reclaimBefore`. */
  readonly reclaimBefore?: number
}

/** Result of a successful {@link AutomationEnginePort.claim}. */
export interface ClaimedRun {
  /** The claimed automation snapshot (status === 'running'). */
  readonly automation: EngineAutomation
  /** The token the caller passes back to {@link AutomationEnginePort.finalize}. */
  readonly claimToken: string
}

/**
 * Input to `finalize`. Mirrors {@link MarkRunInput} but carries the
 * `claimToken` minted by `claim()`. `nextRunAt` semantics:
 *   - number → row returns to `scheduled`, `nextRunAt` advances (the row
 *              retries on its next due instant even when `outcome:"errored"`,
 *              because a live future fire means the failure is transient).
 *   - null   → rule exhausted: `fired` (success) or `errored` (failure).
 */
export interface FinalizeInput {
  readonly id: string
  readonly claimToken: string
  readonly firedAt: number
  readonly outcome: "fired" | "errored"
  readonly errorMessage?: string
  readonly nextRunAt: number | null
  readonly inboxTitle: string
  readonly inboxSummary: string
}

/**
 * Input to `markRun`. The caller (ticker) supplies the next-fire computation
 * outcome via `nextRunAt`:
 *   - number → row stays `scheduled`, its `nextRunAt` advances. This holds
 *              EVEN when `outcome:"errored"` — a live future fire means the
 *              failure is transient and the automation retries next tick
 *              (T10 H5). `lastError` is recorded but the row is NOT retired.
 *   - null   → rule exhausted. `outcome:"fired"` → `fired`; `outcome:"errored"`
 *              → `errored` (terminal). Either way it stops being picked.
 *
 * `markRun` is retained as the pre-T10 single-shot verb (no claim token). The
 * T10 `claim -> finalize` pair is the idempotent run model; `markRun` shares
 * the same advance/retire rules so both paths stay byte-equal.
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
