/**
 * ADR-0132 — Autonomous proactive reactor: closed ports + types.
 *
 * The reactor lives behind THREE injected concerns (TriggerSourcePort /
 * AgentLoopPort / EnvPort + ClockPort) so it can be unit-tested without ever
 * spawning `gh` or `git`, and so the integration seam is one bind at the
 * composition root (apps/**).
 *
 * SLICE: `@/reactor` — library slice. Imports nothing else from the project.
 * Concrete adapters (gh CLI / PR-comment polling / git snapshot wiring) live
 * NEXT TO the port file but accept their externals (`GhCliPort` etc.) as
 * arguments so production code path never reaches into a real subprocess
 * unless the composition root passes one.
 *
 * Default-OFF discipline:
 *   1. {@link EnvPort.get}(`QUANTA_PROACTIVE_REACTOR`) !== "1" ⇒ self-wake is
 *      a NO-OP (returns `{ injected: false, reason: "env-off" }`).
 *   2. {@link ProactiveTrigger.simulatedMessage} MUST be the verbatim user-
 *      visible string; the self-wake injector appends a `[reason=X
 *      evidence=Y]` suffix so the transcript shows audit anchors.
 *   3. The 30-second post-user-input quiet window is enforced by
 *      {@link injectSimulatedTurn} using the injected ClockPort — no wall
 *      clock leakage.
 */

/**
 * Closed set of trigger reasons. Adding a variant is a compile-error elsewhere
 * (the union is consumed in `self-wake.ts` and the babysit wiring); this is
 * the ratchet against silent "new event source forgot to wire audit suffix".
 *
 * Each variant maps 1:1 to a {@link TriggerSourcePort} family:
 *   - `ci_completion` — `trigger-source-ci.ts` (`gh pr checks` exit-code 0).
 *   - `pr_comment`    — `trigger-source-pr-comment.ts` (`gh api`, watermarked).
 *   - `build_completion` / `diff_ready` / `test_pass` — reserved for V2
 *     (build / test watchers; not implemented in this batch).
 *   - `manual_resume` — `/babysit` slash command (skill wiring, Phase D).
 */
export type TriggerReason =
  | "ci_completion"
  | "pr_comment"
  | "build_completion"
  | "diff_ready"
  | "test_pass"
  | "manual_resume"

/**
 * All trigger reasons enumerated. Mirrors the `ALL_*` pattern used elsewhere
 * (`agent/conversation-action.ts#ALL_ACTION_KINDS`) for runtime exhaustiveness
 * sanity tests.
 */
export const ALL_TRIGGER_REASONS: ReadonlyArray<TriggerReason> = [
  "ci_completion",
  "pr_comment",
  "build_completion",
  "diff_ready",
  "test_pass",
  "manual_resume",
]

/**
 * Evidence anchor — every trigger MUST carry one. This is the
 * [[no-heuristics-only-validated]] discipline made structural: the agent's
 * next turn always has a verifiable pointer (URL, sha, or log path) to the
 * external signal that woke it.
 *
 * `kind` is closed (`url` | `sha` | `log_path`). `value` is opaque to the
 * reactor — the consumer (the agent prompt) decides how to fetch / render.
 */
export interface TriggerEvidence {
  readonly kind: "url" | "sha" | "log_path"
  readonly value: string
}

/**
 * A produced trigger. Owned by the trigger source (it allocates the abort
 * signal); the consumer (self-wake) MUST observe `abortSignal.aborted` before
 * acting. Sources that use a poll-time AbortSignal for their own GH/file I/O
 * should detach from that signal once the trigger is fully materialized, so a
 * late poll cancellation cannot invalidate an already-committed wake.
 *
 * `simulatedMessage` is the user-visible text the agent will receive. The
 * self-wake injector appends ` [reason=<reason> evidence=<value>]` so the
 * transcript and audit trail always anchor.
 */
export interface ProactiveTrigger {
  readonly reason: TriggerReason
  readonly evidence: TriggerEvidence
  readonly simulatedMessage: string
  readonly abortSignal: AbortSignal
}

/**
 * Trigger source port — pull semantics (same shape as
 * `ConversationActionPort`). Caller drives the cadence (cron script /
 * watcher), the port returns ALL triggers it has accumulated since the last
 * poll.
 *
 * Returning an empty array is the happy "no events" case. THROWING is
 * reserved for boundary violations (e.g. the source was constructed without
 * its required dep); transient errors (`gh` exited non-zero, network down)
 * MUST collapse to an empty array so a single bad poll never crashes the
 * watcher.
 */
export interface TriggerSourcePort {
  poll(opts?: { signal?: AbortSignal }): Promise<readonly ProactiveTrigger[]>
}

/**
 * Minimal env port — single method, mirrors `EnvLike` used in
 * `src/llm/factory.ts`. Inject at composition. Tests pass `{ get: () =>
 * undefined }` to assert default-OFF behavior without touching `process.env`.
 */
export interface EnvPort {
  get(name: string): string | undefined
}

/**
 * Clock port — `now()` returns ms since epoch. Mirrors the
 * `(opts.now ?? Date.now)()` pattern documented in `docs/ARCHITECTURE.md` §4
 * (Determinism contract). The reactor consumes the port; the composition
 * root passes `() => Date.now()`.
 */
export interface ClockPort {
  now(): number
}

/**
 * The agent-loop seam the reactor needs. Not a full re-export of
 * `ConversationActionPort` — only the one verb the reactor calls. The
 * composition root binds this to a real queue/wrapper around the loop's
 * `ConversationActionPort` (see ADR-0132 Stage 3).
 *
 * `enqueueUserMessage` MUST be idempotent in shape (the loop dedups via
 * `dispatch-dedup`); it returns a promise that resolves once the message
 * has been ACCEPTED into the queue (NOT once the loop has processed it).
 */
export interface AgentLoopPort {
  enqueueUserMessage(
    message: string,
    opts?: { signal?: AbortSignal; modelOverride?: string },
  ): Promise<void>
}

/**
 * Prior-turn outcome — mirrors ADR-0131's 4-state outcome enum, but defined
 * locally so this slice does not pretend to own the SSOT. When the host
 * wires ADR-0131, it converts to this minimal shape at the composition
 * boundary.
 *
 * Self-wake injects only when the prior outcome is explicit `"success"` or
 * `"uncertain"`. `partial`, `fail`, and omitted outcome stay closed to avoid
 * auto-resume on incomplete or contradicted state.
 */
export type LastTurnOutcome = "success" | "partial" | "uncertain" | "fail"

/**
 * Audit event emitted whenever {@link injectSimulatedTurn} injects OR rejects
 * via one of its self-wake guards. Pre-aborted triggers are upstream drops
 * and intentionally emit no `reactor.self_wake` event. The composition root
 * subscribes via the event bus / stream and exports to telemetry — runaway
 * diagnostic if the count climbs above the ADR-0132 validation budget
 * (≤50/day per workspace).
 */
export interface ReactorSelfWakeEvent {
  readonly type: "reactor.self_wake"
  readonly outcome: "injected" | "skipped"
  readonly reason: TriggerReason | "env-off" | "quiet-window" | "prior-outcome"
  readonly trigger?: {
    readonly reason: TriggerReason
    readonly evidenceKind: TriggerEvidence["kind"]
    readonly evidenceValue: string
  }
  /** ms since epoch — clock-port reading at decision time. */
  readonly at: number
}
