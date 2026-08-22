/**
 * RFC-09 (A) — turn-completion terminal notification port.
 *
 * Closed-port DI: {@link NotificationPort} knows ONLY surface-level SEMANTIC
 * events ("a turn completed", "the agent is idle awaiting input", "tear down").
 * It does NOT know escape sequences, BEL, OSC, or any terminal encoding — the
 * adapter (`osc-adapter.ts`) translates them. This keeps the port liftable into
 * a Tauri / Web surface (which would translate the same events to a native
 * toast) without dragging terminal-only string logic across the boundary.
 *
 * The two trigger events mirror Claude Code's split between
 * `inputNeededNotifEnabled` ("push when actions required") and
 * `agentPushNotifEnabled` ("push when the agent decides / turn done"):
 *   - {@link NotificationPort.onTurnComplete} ⇒ agent-push (turn finished).
 *   - {@link NotificationPort.onIdleAwaitingInput} ⇒ input-needed (idle wait).
 *
 * Default-OFF: when the composition root builds NO port (env knob absent), the
 * loop's optional `notify?.` calls are no-ops ⇒ byte-identical output.
 */

/** Info handed to {@link NotificationPort.onTurnComplete} the moment a single
 *  REPL turn finishes. `durationMs` is the runner-measured wall-clock
 *  (`turn-runner.ts` `RunOneTurnResult.durationMs`) — the adapter uses it for
 *  the "slow turn only" gate, so NO new timing source is introduced. */
export interface TurnCompleteInfo {
  /** Wall-clock duration of the turn body (`RunOneTurnResult.durationMs`). */
  readonly durationMs: number
  /** True iff the turn produced a result and was not aborted. */
  readonly ok: boolean
  /** Short label for the terminal title (basename of the session cwd). */
  readonly cwdBasename: string
  /** Optional one-line summary ("3 tools · 12.3k tok"); reserved — the v1
   *  adapter does not append it to the title (kept fixed-format), but the
   *  field lets a future adapter enrich without changing the port shape. */
  readonly summary?: string
}

/** Info handed to {@link NotificationPort.onIdleAwaitingInput} the first time
 *  the agent enters the idle-awaiting-input state for a given wait. */
export interface IdleInfo {
  /** Short label for the terminal title (basename of the session cwd). */
  readonly cwdBasename: string
}

/** B5 (jul-03) — measurable presence-suppression accounting. `sent` counts
 *  pushes actually written; `suppressedUserPresent` counts pushes held back
 *  ONLY because the user was present (`!idle.isIdle()`). Fast-turn anti-spam
 *  and the idle latch are NOT counted here — they are not presence gates. */
export interface PushStats {
  readonly sent: number
  readonly suppressedUserPresent: number
}

export interface NotificationPort {
  /** A REPL turn finished. The adapter gates on `durationMs` so only SLOW
   *  turns notify (fast turns are silent — anti-spam). */
  onTurnComplete(info: TurnCompleteInfo): void
  /** The agent has entered idle, awaiting user input. The adapter notifies
   *  ONCE per idle entry (latched) so a long idle wait does not re-fire. */
  onIdleAwaitingInput(info: IdleInfo): void
  /** A user prompt was accepted / a new turn began. Resets the idle latch so
   *  the NEXT idle entry notifies again. Idempotent. */
  markActive(): void
  /** Session teardown — restore the terminal title to a neutral value. Idempotent. */
  dispose(): void
  /** B5 (jul-03) — optional presence-suppression counters. Optional so existing
   *  test doubles / callers stay assignable; the OSC adapter always provides it. */
  getPushStats?(): PushStats
}
