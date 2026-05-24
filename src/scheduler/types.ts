/**
 * ADR-0161 — Scheduled agent: closed ports + types.
 *
 * Pure types — every concrete effect (clock, fs, network, env, agent loop) is a
 * port. This slice imports NOTHING else from the project; concrete adapters
 * live next to the port file but accept their externals as arguments so the
 * library never reaches into a real subprocess unless the composition root
 * passes one.
 *
 * Default-OFF discipline:
 *   1. The `SchedulerRuntime` only fires when `start()` is called by the
 *      composition root. No automation is fired by import alone.
 *   2. The runtime calls into {@link AgentLoopPort} — the same seam reactor's
 *      `manual_resume` trigger uses ([[ADR-0132]]).
 *   3. All time-dependent decisions go through {@link ClockPort.now}; no wall
 *      clock leakage in core (parsers / evaluators).
 *
 * SLICE: `@/scheduler` — library slice. Imports nothing else from the project.
 */

// ============================================================================
// RRULE — RFC 5545 §3.3.10 strict subset
// ============================================================================

/**
 * Supported FREQ values. HOURLY / MINUTELY / SECONDLY / YEARLY are
 * intentionally out of scope — Codex `automation-schedule-BpeIuMts.js` also
 * uses only DAILY / WEEKLY / MONTHLY in production.
 */
export type Frequency = "DAILY" | "WEEKLY" | "MONTHLY"

/** All supported FREQ — closed array for runtime exhaustiveness checks. */
export const ALL_FREQUENCIES: ReadonlyArray<Frequency> = ["DAILY", "WEEKLY", "MONTHLY"]

/** RFC 5545 weekday tokens (BYDAY). */
export type WeekdayDay = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"

/** All weekdays — closed array for runtime exhaustiveness checks. */
export const ALL_WEEKDAYS: ReadonlyArray<WeekdayDay> = [
  "MO",
  "TU",
  "WE",
  "TH",
  "FR",
  "SA",
  "SU",
]

/**
 * BYDAY entry — `MO` (every Monday) or `+2MO` / `-1FR` (nth-occurrence).
 *
 * `nth`:
 *   - present + positive `1..5` → N-th occurrence from start of month.
 *   - present + negative `-1..-5` → N-th occurrence from end of month.
 *   - absent → every occurrence of that weekday.
 *
 * exactOptionalPropertyTypes: when `nth` is absent the key is OMITTED, never
 * `undefined`-set. This is preserved across parse / serialize / JSONL round
 * trip.
 */
export interface Weekday {
  readonly day: WeekdayDay
  readonly nth?: number
}

/**
 * Parsed RRULE record. The serializer reconstructs an RFC 5545 canonical
 * string from this; the parser produces this from a RFC 5545 string.
 *
 * exactOptional: `interval` / `count` / `until` / `byDay` / `byMonthDay`
 * keys are OMITTED when absent.
 */
export interface RRule {
  readonly freq: Frequency
  readonly interval?: number
  readonly count?: number
  /** ms since epoch — the parser converts `UNTIL=YYYYMMDDTHHMMSSZ` to ms. */
  readonly until?: number
  readonly byDay?: ReadonlyArray<Weekday>
  /** Day-of-month integers in `1..31`. */
  readonly byMonthDay?: ReadonlyArray<number>
}

/**
 * Closed error code union for {@link parseRRule}. Each variant maps 1:1 to a
 * documented RFC 5545 violation; callers branch deterministically.
 */
export type RRuleParseErrorCode =
  | "malformed"
  | "unsupported-freq"
  | "count-and-until"
  | "invalid-byday"

/**
 * Parser failure. Carries the offending input (truncated to a sane length) +
 * the closed error code. Never thrown — returned as a value.
 */
export interface RRuleParseError {
  readonly ok: false
  readonly code: RRuleParseErrorCode
  readonly message: string
}

// ============================================================================
// Automation lifecycle
// ============================================================================

/**
 * 4-arm lifecycle for a single automation. `deleted` is terminal (never
 * transitions back); `error` set by the runtime when all models are
 * unavailable; `paused` is a host-controlled hold; `active` is the only
 * fire-eligible state.
 */
export type AutomationStatus = "active" | "paused" | "deleted" | "error"

/** All status arms — closed array for runtime exhaustiveness checks. */
export const ALL_AUTOMATION_STATUSES: ReadonlyArray<AutomationStatus> = [
  "active",
  "paused",
  "deleted",
  "error",
]

/**
 * A single user-defined automation. Persisted in JSONL store
 * (`<baseDir>/<workspaceHash>/automations.jsonl`, last-line-per-id wins).
 *
 * `modelPreference` is the first-choice model; `modelFallbacks` is the
 * ordered probe list when preference is unavailable.
 *
 * exactOptional: `lastFiredAt` / `lastErrorMessage` keys are OMITTED when
 * absent — JSONL serialize / parse must preserve this.
 */
export interface Automation {
  readonly id: string
  readonly title: string
  readonly rule: RRule
  readonly prompt: string
  readonly status: AutomationStatus
  readonly modelPreference: string
  readonly modelFallbacks: ReadonlyArray<string>
  readonly createdAt: number
  readonly lastFiredAt?: number
  readonly lastErrorMessage?: string
  readonly fireCount: number
}

// ============================================================================
// Ports — closed seams
// ============================================================================

/**
 * Clock port — mirror of `@/reactor` `ClockPort` so the slices can share
 * the same composition-root binding. `now()` returns ms since epoch.
 */
export interface ClockPort {
  now(): number
}

/**
 * Env port — minimal single-method (mirror of `@/reactor` `EnvPort`).
 * Tests pass `{ get: () => undefined }` to exercise default-OFF paths
 * without touching `process.env`.
 */
export interface EnvPort {
  get(name: string): string | undefined
}

/**
 * Model availability port — caller-injected probe. Returns a Promise so the
 * underlying check can hit the real provider (rate-limited / async).
 *
 * Contract: a probe that throws is treated by callers as "unavailable" —
 * no exception leak. The port itself is allowed to throw (port consumers
 * wrap), but production adapters SHOULD return false on transient failure.
 */
export interface ModelAvailabilityPort {
  isAvailable(model: string): Promise<boolean>
}

/**
 * Agent-loop port — voice-match `@/reactor` `AgentLoopPort`. The scheduler
 * calls this exactly the same way reactor's `manual_resume` does. The
 * composition root binds both to the same downstream queue.
 *
 * `enqueueUserMessage` MUST be idempotent in shape (dispatch-dedup
 * collapses identical content); returns once the message is ACCEPTED into
 * the queue (NOT once the loop processed it).
 */
export interface AgentLoopPort {
  enqueueUserMessage(message: string, opts?: { signal?: AbortSignal }): Promise<void>
}

/**
 * Persistence port — closed. Concrete adapter `defaultJsonlAutomationStore`
 * lives next to the port. NO-THROW on `load` / `delete` (transient I/O →
 * empty array / no-op); `save` may throw `AutomationStoreError("io-failed")`
 * which the runtime swallows + surfaces via `sink`.
 */
export interface AutomationStorePort {
  load(workspace: string): Promise<ReadonlyArray<Automation>>
  save(workspace: string, automation: Automation): Promise<void>
  delete(workspace: string, id: string): Promise<void>
}

/**
 * Typed error class — exposes a closed `code` union the caller can branch
 * on deterministically.
 */
export class AutomationStoreError extends Error {
  constructor(
    public readonly code: "io-failed" | "parse-failed",
    message: string,
  ) {
    super(message)
    this.name = "AutomationStoreError"
  }
}

// ============================================================================
// Runtime telemetry sink
// ============================================================================

/**
 * Audit event emitted by the runtime. Two arms:
 *   - `"scheduler.fired"` — an automation triggered the agent loop.
 *   - `"scheduler.error"` — an automation transitioned to `"error"` (all
 *     models unavailable).
 *   - `"scheduler.skipped"` — an automation was due but skipped (paused /
 *     deleted / store load failed).
 *
 * Composition root wires this to OTel / event bus. `sink` is OPTIONAL —
 * default is no-op.
 */
export type SchedulerEvent =
  | {
      readonly type: "scheduler.fired"
      readonly automationId: string
      readonly chosenModel: string
      readonly rerouteReason: "preference-available" | "fallback" | "all-unavailable"
      readonly fallbackIndex?: number
      readonly at: number
    }
  | {
      readonly type: "scheduler.error"
      readonly automationId: string
      readonly errorMessage: string
      readonly at: number
    }
  | {
      readonly type: "scheduler.skipped"
      readonly automationId: string
      readonly reason: "paused" | "deleted" | "status-error" | "store-save-failed"
      readonly at: number
    }

export interface SchedulerSinkPort {
  emit(event: SchedulerEvent): void
}
