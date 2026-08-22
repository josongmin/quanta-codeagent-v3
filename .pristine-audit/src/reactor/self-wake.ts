/**
 * ADR-0132 Stage 3 (Phase C) — Self-simulated turn injection.
 *
 * Three hard guards, evaluated IN ORDER (the order matters for the audit
 * event's `reason` field, which exposes WHICH guard rejected the wake):
 *
 *   1. ENV — `QUANTA_PROACTIVE_REACTOR=1` MUST be set. Default-OFF discipline
 *      ([[codex-absorption-complete]] byte-identical replay invariant).
 *   2. QUIET WINDOW — at least {@link QUIET_WINDOW_MS} since the last user
 *      input. Prevents racing the human (a wake that lands while the user is
 *      mid-typing is confusing UX and re-creates the same runaway shape we
 *      were trying to avoid).
 *   3. PRIOR OUTCOME — the previous turn's outcome MUST be `"success"` or
 *      `"uncertain"`. `partial` / `fail` / absent outcome stay closed to
 *      avoid resuming on an unfinished or contradicted state.
 *
 * On success: appends a `[reason=<r> evidence=<v>]` suffix to the trigger's
 * `simulatedMessage` and hands it to {@link AgentLoopPort.enqueueUserMessage}.
 * On injected or guard-skipped paths, emits a {@link ReactorSelfWakeEvent}
 * through the optional event sink so the host can wire telemetry (the
 * ADR-0132 validation budget is ≤50/day per workspace; the sink is how the
 * host measures it). Pre-aborted triggers stay outside that audit stream.
 */

import type {
  AgentLoopPort,
  AutorunVerdict,
  ClockPort,
  EnvPort,
  LastTurnOutcome,
  ProactiveTrigger,
  ReactorSelfWakeEvent,
} from "./types"

/** Env flag — exported so tests reference the SSOT, not a string literal. */
export const REACTOR_ENV_FLAG = "QUANTA_PROACTIVE_REACTOR" as const

/** Minimum quiet window after last user input, in ms. 30s is the ADR-0132
 *  documented value; exported so tests AND any future tuning live at one
 *  site (and the no-undocumented-magic-timeout scanner stays happy if it
 *  ever extends to this slice). */
export const QUIET_WINDOW_MS = 30_000

export interface SelfWakeOpts {
  readonly trigger: ProactiveTrigger
  readonly agentLoop: AgentLoopPort
  readonly envPort: EnvPort
  readonly clockPort: ClockPort
  /** ms since epoch the surface observed the last user input. */
  readonly lastUserInputAt: number
  /** Prior turn outcome from ADR-0131 (when wired). Absent stays closed:
   *  auto-wake is allowed only for explicit `"success"` / `"uncertain"`,
   *  so omitted outcome is treated equivalently to `"partial"`. */
  readonly lastTurnOutcome?: LastTurnOutcome
  /** ADR-0453 — OPTIONAL per-thread autorun-eligibility gate (the 4th guard).
   *  When injected, it is evaluated AFTER the three hard guards pass; a
   *  NOT-eligible verdict blocks the wake (emitting `not-eligible`). When
   *  ABSENT (default), the self-wake path is byte-identical to the
   *  pre-ADR-0453 3-guard behavior. The composition root binds this by reading
   *  the thread's approval policy from `@/permission`'s store and calling
   *  `evaluateAutorunEligibility`. The gate is additive: it can only BLOCK a
   *  wake the 3 guards already permitted, never force one. Returning
   *  `undefined` ⇒ no opinion ⇒ proceed (equivalent to no resolver). */
  readonly eligibility?: () => AutorunVerdict | undefined
  /** Optional audit sink. Called exactly once for each injected or
   *  guard-skipped self-wake decision. Pre-aborted triggers are dropped
   *  silently because the trigger source already owns that audit path. The
   *  sink MUST NOT throw — wrap host code that might. */
  readonly onEvent?: (event: ReactorSelfWakeEvent) => void
}

export interface SelfWakeResult {
  readonly injected: boolean
  /** Human-readable reason. `"injected"` on success; one of `"env-off"` /
   *  `"quiet-window"` / `"prior-outcome"` / `"not-eligible"` / `"aborted"` on
   *  non-inject. */
  readonly reason:
    | "injected"
    | "env-off"
    | "quiet-window"
    | "prior-outcome"
    | "not-eligible"
    | "aborted"
  /** ADR-0453 — closed eligibility reason anchor when `reason ===
   *  "not-eligible"`; omitted otherwise. */
  readonly eligibilityReason?: string
}

/**
 * Hand a trigger to the agent loop, gated by the three hard guards.
 *
 * Idempotency note: the function does NOT dedup. Callers (the cron watcher,
 * the babysit skill) are expected to drop already-handled triggers (the
 * trigger sources own that — see {@link createInMemorySeenRuns} +
 * {@link WatermarkStore}). Double-wake is annoying but not destructive; the
 * loop's existing dispatch-dedup will collapse identical content.
 */
export const injectSimulatedTurn = async (opts: SelfWakeOpts): Promise<SelfWakeResult> => {
  // Abort short-circuit is upstream, not a self-wake guard. A dead trigger
  // must not emit a misleading skip audit such as "env-off".
  if (opts.trigger.abortSignal.aborted) {
    return { injected: false, reason: "aborted" }
  }

  const now = opts.clockPort.now()
  // Guard 1 — env. Cheapest check first so a default-OFF process never even
  // reads the clock.
  if (opts.envPort.get(REACTOR_ENV_FLAG) !== "1") {
    emitSkip(opts, "env-off", now)
    return { injected: false, reason: "env-off" }
  }
  // Guard 2 — quiet window since last user input.
  if (now - opts.lastUserInputAt < QUIET_WINDOW_MS) {
    emitSkip(opts, "quiet-window", now)
    return { injected: false, reason: "quiet-window" }
  }
  // Guard 3 — prior turn outcome. Only explicit success/uncertain are
  // eligible; absent outcome stays closed as ADR-0131's safe-default partial.
  const prior = opts.lastTurnOutcome ?? "partial"
  if (prior !== "success" && prior !== "uncertain") {
    emitSkip(opts, "prior-outcome", now)
    return { injected: false, reason: "prior-outcome" }
  }
  // Guard 4 — ADR-0453 per-thread autorun-eligibility (OPTIONAL, default-OFF).
  //   Consulted only when a resolver is injected AND returns a verdict.
  //   `undefined` ⇒ no opinion ⇒ proceed (byte-identical to no resolver). A
  //   NOT-eligible verdict blocks the wake and surfaces the closed reason.
  const verdict = opts.eligibility?.()
  if (verdict !== undefined && !verdict.eligible) {
    opts.onEvent?.({
      type: "reactor.self_wake",
      outcome: "skipped",
      reason: "not-eligible",
      eligibilityReason: verdict.reason,
      trigger: {
        reason: opts.trigger.reason,
        evidenceKind: opts.trigger.evidence.kind,
        evidenceValue: opts.trigger.evidence.value,
      },
      at: now,
    })
    return { injected: false, reason: "not-eligible", eligibilityReason: verdict.reason }
  }

  const message = buildSimulatedMessage(opts.trigger)
  await opts.agentLoop.enqueueUserMessage(message, {
    signal: opts.trigger.abortSignal,
  })

  opts.onEvent?.({
    type: "reactor.self_wake",
    outcome: "injected",
    reason: opts.trigger.reason,
    trigger: {
      reason: opts.trigger.reason,
      evidenceKind: opts.trigger.evidence.kind,
      evidenceValue: opts.trigger.evidence.value,
    },
    at: now,
  })
  return { injected: true, reason: "injected" }
}

/**
 * Build the user-facing simulated message. The `[reason=X evidence=Y]`
 * suffix is INVARIANT — the ADR-0132 validation criterion requires 100%
 * presence so transcript audit always anchors to the external signal.
 *
 * Exported for direct unit-test inspection (the suffix shape is part of the
 * contract a downstream UI lint may grep for).
 */
export const buildSimulatedMessage = (trigger: ProactiveTrigger): string => {
  const evidence = `${trigger.evidence.kind}=${trigger.evidence.value}`
  return `${trigger.simulatedMessage} [reason=${trigger.reason} evidence=${evidence}]`
}

const emitSkip = (
  opts: SelfWakeOpts,
  reason: "env-off" | "quiet-window" | "prior-outcome",
  now: number,
): void => {
  opts.onEvent?.({
    type: "reactor.self_wake",
    outcome: "skipped",
    reason,
    trigger: {
      reason: opts.trigger.reason,
      evidenceKind: opts.trigger.evidence.kind,
      evidenceValue: opts.trigger.evidence.value,
    },
    at: now,
  })
}
