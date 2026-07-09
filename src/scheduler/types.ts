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
 * Supported FREQ values. SECONDLY / YEARLY remain out of scope. HOURLY /
 * MINUTELY are supported (B2) for sub-daily cadences — the evaluator advances
 * by fixed wall-clock deltas honoring `INTERVAL` (no BYHOUR/BYMINUTE refinement,
 * which stays out of scope).
 */
export type Frequency = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY"

/** All supported FREQ — closed array for runtime exhaustiveness checks. */
export const ALL_FREQUENCIES: ReadonlyArray<Frequency> = [
  "MINUTELY",
  "HOURLY",
  "DAILY",
  "WEEKLY",
  "MONTHLY",
]

/** RFC 5545 weekday tokens (BYDAY). */
export type WeekdayDay = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU"

/** All weekdays — closed array for runtime exhaustiveness checks. */
export const ALL_WEEKDAYS: ReadonlyArray<WeekdayDay> = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]

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
 * H8 — automation KIND (Codex `cron` vs `heartbeat`).
 *   - `cron` (default when absent): the historical behavior — each fire enqueues
 *     the prompt onto a FRESH agent loop (thread-detached). Byte-identical to the
 *     pre-H8 automation.
 *   - `heartbeat`: the fire is routed to an EXISTING conversation thread
 *     ({@link Automation.targetThreadId}) and inherits that thread's permission /
 *     sandbox / collaboration posture ({@link Automation.inheritedPolicy}) — a
 *     repeating agent that keeps working one thread under a fixed approval stance.
 */
export type AutomationKind = "cron" | "heartbeat"

/** All kind arms — closed array for exhaustiveness. */
export const ALL_AUTOMATION_KINDS: ReadonlyArray<AutomationKind> = ["cron", "heartbeat"]

/**
 * H8 — the permission/sandbox/collaboration posture a heartbeat automation
 * INHERITS from its target thread, captured at creation time so each fire
 * re-applies the SAME stance (it never silently escalates). All fields are
 * opaque strings (the host owns the closed vocabularies); the scheduler only
 * stores + forwards them verbatim.
 */
export interface HeartbeatPolicySnapshot {
  readonly approvalPolicy: string
  readonly sandboxPolicy: string
  readonly collaborationMode: string
}

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
  /** H8 — automation kind. ABSENT ⇒ `"cron"` (byte-identical legacy: fresh
   *  thread-detached fire). `"heartbeat"` routes to {@link targetThreadId}. */
  readonly kind?: AutomationKind
  /** H8 — for `kind:"heartbeat"`, the conversation thread this automation is
   *  attached to. The fire is enqueued onto THIS thread, not a fresh one. */
  readonly targetThreadId?: string
  /** H8 — for `kind:"heartbeat"`, the posture snapshot inherited from the
   *  target thread at creation time, re-applied on every fire. */
  readonly inheritedPolicy?: HeartbeatPolicySnapshot
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
 * WS-D (jul-10, UUX-4-01) — a typed NON-DELIVERY verdict an `AgentLoopPort`
 * impl may RESOLVE with when it can prove the message was NOT accepted into
 * any queue (e.g. the CLI heartbeat binder's `thread-not-found`). Distinct
 * from a THROW (unknown/hard failure): a resolved rejection is a definite
 * no-side-effect outcome, so the runtime may safely retry the occurrence.
 * Resolving `void`/`undefined` remains the delivery receipt.
 */
export interface EnqueueRejected {
  readonly delivered: false
  /** Closed-vocabulary-ish reason string (host-owned; e.g. `thread-not-found`,
   *  `posture-rejected`, `enqueue-failed`). Surfaced in `scheduler.error`. */
  readonly reason: string
}

/**
 * Agent-loop port — voice-match `@/reactor` `AgentLoopPort`. The scheduler
 * calls this exactly the same way reactor's `manual_resume` does. The
 * composition root binds both to the same downstream queue.
 *
 * `enqueueUserMessage` MUST be idempotent in shape (dispatch-dedup
 * collapses identical content); returns once the message is ACCEPTED into
 * the queue (NOT once the loop processed it).
 *
 * EFFECT-RECEIPT CONTRACT (WS-D jul-10): resolving `void` IS the acceptance
 * receipt — the runtime emits `scheduler.fired` only then. An impl that can
 * prove non-delivery resolves an {@link EnqueueRejected} instead (the runtime
 * emits `scheduler.error`, keeps the occurrence, and retries bounded). An
 * impl that doesn't know (partial side effects possible) THROWS — the runtime
 * then keeps the advanced anchor (at-most-once) and marks the automation
 * `error` (the M7 hard-fail path).
 */
export interface AgentLoopPort {
  enqueueUserMessage(
    message: string,
    opts?: {
      signal?: AbortSignal
      modelOverride?: string
      /** H8 — heartbeat routing. When present, the host enqueues onto THIS
       *  existing thread (instead of a fresh one) and re-applies
       *  {@link inheritedPolicy}. Absent ⇒ fresh thread-detached fire (cron). */
      targetThreadId?: string
      inheritedPolicy?: HeartbeatPolicySnapshot
    },
    // biome-ignore lint/suspicious/noConfusingVoidType: `void` (not `undefined`) keeps every existing `async (…) => { push(…) }` impl assignable — Promise<void> is not assignable to Promise<undefined | EnqueueRejected>, so the undefined-union would break all delivery-receipt impls.
  ): Promise<void | EnqueueRejected>
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
 * Audit event emitted by the runtime. Three arms:
 *   - `"scheduler.fired"` — an automation's prompt was ACCEPTED by the agent
 *     loop (emitted only on a delivery receipt — never on a rejected enqueue).
 *   - `"scheduler.error"` — a fire attempt failed: all models unavailable, an
 *     enqueue threw, or the enqueue resolved {@link EnqueueRejected}
 *     (soft-fail). `willRetry: true` marks a soft-fail whose occurrence was
 *     retained for a bounded retry on the next tick (the automation stays
 *     `active`); absent/false means the automation transitioned to `"error"`.
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
      /** WS-D soft-fail marker — `true` when the occurrence was NOT consumed
       *  and the runtime will retry it next tick (bounded). Omitted on the
       *  terminal paths (status → `error`). */
      readonly willRetry?: boolean
      readonly at: number
    }
  | {
      readonly type: "scheduler.skipped"
      readonly automationId: string
      readonly reason:
        | "paused"
        | "deleted"
        | "status-error"
        | "store-save-failed"
        | "store-load-failed"
        | "not-eligible"
      /** ADR-0453 — when `reason === "not-eligible"`, the closed eligibility
       *  reason anchor (e.g. `policy-never`, `on-failure-not-failed`) so the
       *  audit trail records WHY the autorun was blocked. Omitted otherwise. */
      readonly eligibilityReason?: string
      readonly at: number
    }

export interface SchedulerSinkPort {
  emit(event: SchedulerEvent): void
}

/**
 * ADR-0453 — Optional autorun-eligibility resolver. The composition root binds
 * this by reading the automation's thread approval policy from `@/permission`'s
 * store and calling `evaluateAutorunEligibility`. The runtime consults it (when
 * injected) BEFORE dispatch.
 *
 * Returning `undefined` means "no per-thread eligibility opinion for this
 * automation" ⇒ the runtime fires as if no resolver were injected (the policy
 * gate is purely additive — it can BLOCK a fire, never force one that the RRULE
 * gate would not have permitted).
 *
 * Default-OFF: when no resolver is injected, `tickOnce()` is byte-identical to
 * the pre-ADR-0453 RRULE-only fire path.
 */
export interface AutorunEligibilityResolverPort {
  resolve(automation: Automation): AutorunVerdict | undefined
}

/** Minimal verdict shape the runtime needs — structurally compatible with
 *  `@/permission`'s `AutorunEligibility`. Defined locally (not imported) so the
 *  scheduler slice keeps zero cross-slice dependency; the composition root maps
 *  the permission verdict onto this at the bind site. */
export interface AutorunVerdict {
  readonly eligible: boolean
  /** Closed eligibility reason anchor (e.g. `policy-never`). */
  readonly reason: string
}
