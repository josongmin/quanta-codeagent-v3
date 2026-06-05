/**
 * N1 — Background side-agent daemon (RFC `docs/plans/jun-4-background-side-agent.md`).
 *
 * A PERSISTENT background agent that runs side tasks (monitor / cleanup / tee /
 * periodic check) WITHOUT blocking the main loop. Distinct from the one-shot
 * subagent-bg (ADR-0130) and from the scheduler (ADR-0161, drives the MAIN
 * loop): a daemon is resident, wakes on its own cadence (interval/event), runs
 * ONE bounded pass per wake on its own thread, and PUSHES findings back via a
 * mailbox + optional stream sink — never by blocking.
 *
 * Phase-1 PURE LEAF: this slice imports NOTHING concrete. Every effect (the
 * runner, the mailbox, the stream sink, the event source, timers, the clock) is
 * an injected port, so the supervise loop is fully testable over fakes and
 * carries no `Date.now()`/`setInterval`/randomness of its own (the host injects
 * the real ones at composition). NO-THROW surface except `spawn`'s single
 * `cap-exceeded` (mirrors ADR-0130 `fork`).
 */

export type SideAgentStatus = "running" | "stopped" | "failed" | "idle-reaped"

/** What wakes a daemon. Closed union — no free-form scheduling. */
export type SideAgentTrigger =
  | { readonly kind: "interval"; readonly everyMs: number }
  | { readonly kind: "event"; readonly topic: string }

export interface SideAgentSpec {
  /** Charter prompt the daemon re-runs each wake. */
  readonly task: string
  readonly trigger: SideAgentTrigger
  /** Hard ceiling on total wakes before auto-stop (runaway guard). */
  readonly maxWakes: number
  /** Per-wake model-turn budget (each pass is bounded like an ADR-0130 fork). */
  readonly maxTurnsPerWake: number
  /** Auto-stop after this much wall-idle (ms) with no finding. Omitted ⇒ never. */
  readonly idleReapMs?: number
  readonly metadata?: Readonly<Record<string, string>>
}

/** One finding a wake produced (or `null` from a pass = nothing to report). */
export interface SideAgentFinding {
  readonly daemonId: string
  readonly wake: number
  readonly summary: string
  readonly detail?: string
  readonly at: number
}

export interface SideAgentSnapshot {
  readonly id: string
  readonly status: SideAgentStatus
  readonly spec: SideAgentSpec
  readonly wakesDone: number
  readonly lastFindingAt?: number
  readonly startedAt: number
  readonly stoppedAt?: number
}

export type SideAgentErrorCode = "cap-exceeded" | "invalid-spec"

export class SideAgentError extends Error {
  constructor(
    readonly code: SideAgentErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "SideAgentError"
  }
}

// ── injected ports (Phase-2 host adapts the real subagent/mailbox/stream) ─────

/** One bounded pass. Returns a finding, or `null` when the wake found nothing
 *  to report (idle accumulates on `null`). NO-THROW is NOT required — a throw is
 *  caught by the supervise loop and transitions the daemon to `failed`. */
export interface SideAgentRunnerPort {
  run(args: {
    readonly task: string
    readonly wake: number
    readonly maxTurns: number
    readonly signal: AbortSignal
  }): Promise<{ readonly summary: string; readonly detail?: string } | null>
}

/** Where findings are published (ADR-0416 mailbox, adapted). */
export interface SideAgentMailboxPort {
  send(msg: {
    readonly from: string
    readonly to: string
    readonly kind: "finding"
    readonly summary: string
    readonly detail?: string
  }): void
}

/** Optional render-only stream signal. */
export interface SideAgentSinkPort {
  emit(finding: SideAgentFinding): void
}

/** Event source for `trigger.kind === "event"`. Returns an unsubscribe fn. */
export interface SideAgentEventSourcePort {
  subscribe(topic: string, handler: () => void): () => void
}

export interface SideAgentDaemonOpts {
  /** REUSE ADR-0130 — one bounded pass per wake. */
  readonly runner: SideAgentRunnerPort
  /** REUSE ADR-0416 — findings channel. */
  readonly mailbox: SideAgentMailboxPort
  /** Recipient id (the main session) findings are sent to. */
  readonly mainRecipient: string
  readonly sink?: SideAgentSinkPort
  readonly events?: SideAgentEventSourcePort
  /** Runaway guard — max concurrent daemons (default 2, < subagent-bg's 3). */
  readonly maxConcurrent?: number
  /** Injected timers + clock — REQUIRED so the slice stays a pure leaf (no
   *  `setInterval`/`Date.now()` of its own). The host passes the real ones. */
  readonly setInterval: (handler: () => void, ms: number) => unknown
  readonly clearInterval: (handle: unknown) => void
  readonly now: () => number
  /** Optional id generator (default: a deterministic monotonic `sa-<n>`). */
  readonly idGen?: () => string
  /** Ring-buffer cap on the in-memory findings log (default 1000). Oldest are
   *  evicted past this — bounds memory for a long-lived chatty daemon. */
  readonly maxFindings?: number
  /** Cap on retained TERMINAL daemons (stopped/failed/idle-reaped). Past this,
   *  the oldest terminal daemons are pruned from `list()` (default 100) — bounds
   *  memory for a long session that spawns many short-lived daemons. Running
   *  daemons are NEVER pruned. */
  readonly maxRetained?: number
  /** Capability C (multi-agent coordination) — team-idle barrier. When injected
   *  (the host wires `createIdleBarrier` only under `QUANTA_TEAM_IDLE`), the
   *  registry beacons a daemon idle at spawn + after each completed pass, and
   *  clears the beacon while a pass is in flight — so a leader can fan IN by
   *  awaiting `teamIdle()` instead of polling `list()`. Absent ⇒ `teamIdle()`
   *  returns false / `idleSince()` undefined (byte-identical legacy). */
  readonly idleBarrier?: SideAgentIdleBarrierPort
}

/** Duck-typed mirror of `@/subagent/coordination#IdleBarrierPort` — kept LOCAL
 *  so the `src/side-agent/**` slice does not hard-import the coordination slice.
 *  The host adapts the real barrier behind this shape. */
export interface SideAgentIdleBarrierPort {
  beacon(agentId: string): void
  reactivate(agentId: string): void
  teamIdle(members: readonly string[]): boolean
  idleSince(members: readonly string[]): number | undefined
}

export interface SideAgentDaemonRegistry {
  /** Spawn a resident daemon; returns the id immediately (loop runs detached).
   *  Throws `SideAgentError("cap-exceeded")` at `maxConcurrent` (only throw). */
  spawn(spec: SideAgentSpec): string
  /** Drain findings newer than `since` (epoch ms). NO-THROW. */
  findings(opts?: { readonly since?: number }): ReadonlyArray<SideAgentFinding>
  /** Enumerate daemons, newest-first. NO-THROW. */
  list(): ReadonlyArray<SideAgentSnapshot>
  /** Request stop (idempotent; conversation/findings KEPT). True if id exists. */
  stop(id: string): boolean
  /** Stop every running daemon (session shutdown). Returns count stopped. */
  stopAll(): number
  /** Capability C — true iff EVERY running daemon is quiescent (no pass in
   *  flight) per the injected team-idle barrier. No barrier wired ⇒ false
   *  (the team-idle signal is opt-in via `QUANTA_TEAM_IDLE`). NO-THROW. */
  teamIdle(): boolean
  /** Capability C — the instant the team last became fully idle (MAX beacon
   *  across running daemons), or undefined when not all idle / no barrier. */
  idleSince(): number | undefined
}
