/**
 * RFC-04 §11 / ADR-0437 follow-up — `SubagentTurnGate`.
 *
 * Closes the ADR-0437 documented limitation: `followup_task` delivered a
 * message over the mailbox and called {@link TurnWakeRegistry.wake}, but the
 * runner never registered a per-child waker, so `wake` always returned
 * `no-receiver` (`cause:"no_waker"`). This gate is the bridge between a wake
 * and the child loop's ACTUAL turn-injection seam.
 *
 * --- How a turn is actually triggered (no parallel driver) ---
 *
 * The agent loop (`src/agent/loop.ts`) is a synchronous `for (turn …)` that
 * drains the follow-up queue at the TOP of every turn (`pollFollowUpQueue`).
 * A child loop normally runs turns back-to-back until it would
 * `finish("completed", …)` and exit the `for`. With a gate wired, the loop
 * instead PARKS at the gate at that completion point: {@link wait} resolves
 * either (a) immediately if a wake is already pending (`reason:"resume"`), or
 * (b) when {@link wake} is called while parked (`reason:"woke"`), or (c) when
 * the abort signal fires / parking is disallowed (`reason:"settle"` ⇒ the loop
 * really finishes). On a `resume`/`woke` resolution the loop takes ANOTHER
 * turn — and that next turn's top-of-loop mailbox read surfaces the
 * followup_task message. So the gate reuses the existing per-turn injection
 * seam; it does NOT invent a second turn driver.
 *
 * --- idle vs busy (the woke/queued distinction) ---
 *
 * The gate tracks whether the loop is currently PARKED (idle) on it:
 *   - `wake` while PARKED → resolve the park → the loop runs a turn now ⇒
 *     `"woke"`.
 *   - `wake` while NOT parked (the loop is mid-turn / busy) → set a pending
 *     flag → the NEXT `wait` returns immediately and clears the flag ⇒
 *     `"queued"` (the turn runs after the current one completes).
 * This is the precise `woke`/`queued` contract the RFC documents.
 *
 * --- interrupt (ADR-0437 follow-up — the limitation CLOSED) ---
 *
 * `wake("interrupt")` on a BUSY (mid-turn) child must STOP the in-flight turn
 * and handle the message immediately — not merely queue it for after the turn.
 * The gate owns a per-turn {@link AbortController} (`turnAbort`): the child loop
 * calls {@link armTurn} at the top of every turn to mint a fresh controller and
 * compose an EFFECTIVE turn signal (`AbortSignal.any([loopSignal, turnAbort])`).
 * The turn body threads THAT signal into the LLM stream + tool dispatch — the
 * SAME AbortController→signal→stream/tool mechanism `task_stop`/`forceStop` use
 * to unwind in-flight work (no parallel abort path). On `wake("interrupt")`
 * while busy the gate aborts `turnAbort` (the in-flight stream/tool unwinds) AND
 * records a pending wake — so once the aborted turn unwinds to the gate the
 * pending wake resolves `resume` and the loop runs a FRESH turn whose
 * top-of-loop mailbox read surfaces the interrupting message. The controller is
 * reset per turn by `armTurn`, so a fired interrupt never pre-aborts the NEXT
 * turn. On an IDLE (parked) child there is nothing in flight, so interrupt
 * behaves exactly like followup (release the park ⇒ `woke`). `wake("followup")`
 * NEVER aborts — byte-identical to the pre-interrupt contract.
 *
 * Turn-level (not tool-mid-instruction) guarantee: the in-flight LLM stream
 * aborts and `streamingTurn` stops dispatching further tool calls between
 * phases; an already-running tool observes the effective signal via its
 * `ToolContext.signal` (cooperative abort). The loop then unwinds to the gate
 * and a fresh turn handles the message. We do NOT forcibly kill a tool that
 * ignores its abort signal — that is the same cooperative contract `task_stop`
 * has today.
 *
 * PURE: no `node:`, no clock, no `Math.random`, no real timer. The only async
 * primitive is a `Promise` resolved by `wake`/abort — deterministic and
 * driven entirely by injected events.
 */

/** How a {@link SubagentTurnGate.wait} resolved.
 *   - `woke`   — a wake arrived WHILE the loop was parked (idle); take a turn.
 *   - `resume` — a wake was already pending when the loop reached the gate
 *     (it was busy when the wake arrived); take a turn now without parking.
 *   - `settle` — no wake; the abort signal fired or parking is disallowed; the
 *     loop should really finish. */
export type GateWaitResult = "woke" | "resume" | "settle"

/** Outcome a {@link SubagentTurnGate.wake} reports back to the waker, mapping
 *  1:1 onto {@link import("./turn-wake").WakeOutcome}:
 *   - `woke`   — the loop was parked; it was released (a turn runs now).
 *   - `queued` — the loop was busy; a pending wake was recorded (next turn). */
export type GateWakeResult = "woke" | "queued"

/**
 * Per-child idle-wait + pending-wake primitive. One gate is created per child
 * loop start and disposed when the loop ends. Single-consumer (the child loop
 * is the only `wait`er) and multi-producer (`followup_task` calls `wake` from
 * the parent's turn) — but everything runs on one event loop, so no locking.
 */
export class SubagentTurnGate {
  /** Resolver for an in-flight `wait` park, or `undefined` when not parked. */
  private parkResolve: ((r: GateWaitResult) => void) | undefined
  /** A wake that arrived while the loop was NOT parked — consumed by the next
   *  `wait`. */
  private pending = false
  /** Set once {@link dispose} runs; a parked `wait` is released with `settle`
   *  and all future `wait`s return `settle` immediately (the loop must finish). */
  private disposed = false
  /** Per-turn interrupt controller. Reset to a fresh controller by
   *  {@link armTurn} at the top of every turn; aborted by `wake("interrupt")`
   *  on a busy child to unwind the in-flight turn. Undefined before the first
   *  `armTurn` (the loop has not started a turn yet) — `wake("interrupt")` then
   *  has nothing in flight to abort and degrades to a plain `pending` wake. */
  private turnAbort: AbortController | undefined

  /**
   * Arm a FRESH per-turn interrupt controller and return the EFFECTIVE signal
   * the loop must thread into this turn's stream + tool dispatch. Called at the
   * top of every turn BEFORE any in-flight work begins.
   *
   * The returned signal aborts when EITHER (a) the loop's lifetime signal
   * (`loopSignal`, i.e. `config.signal` — user/host/`task_stop` cancel) aborts,
   * OR (b) `wake("interrupt")` aborts THIS turn's controller. Resetting the
   * controller each turn means a previous interrupt never pre-aborts the next
   * turn. When `loopSignal` is already aborted, `AbortSignal.any` returns an
   * already-aborted signal (the turn unwinds at once) — preserving the lifetime
   * cancel contract.
   *
   * @param loopSignal the child loop's lifetime abort signal (`config.signal`).
   * @returns the per-turn effective {@link AbortSignal}.
   */
  armTurn(loopSignal: AbortSignal): AbortSignal {
    const ac = new AbortController()
    this.turnAbort = ac
    return AbortSignal.any([loopSignal, ac.signal])
  }

  /** True iff the CURRENT turn's interrupt controller has been aborted by
   *  `wake("interrupt")` (and NOT by the loop's lifetime signal). The loop uses
   *  this to distinguish an interrupt (park + run a fresh turn) from a real
   *  lifetime abort (finish). Reset on the next {@link armTurn}. */
  wasInterrupted(): boolean {
    return this.turnAbort?.signal.aborted === true
  }

  /**
   * Park until a wake arrives (or resolve immediately if one is pending /
   * the abort signal is already tripped / the gate is disposed). The child
   * loop calls this AT its completion point instead of exiting the turn loop.
   *
   * @param signal the child loop's abort signal (`config.signal`). When it
   *   fires while parked, the park resolves `settle` so the loop unwinds — the
   *   parent controls child lifetime via `task_stop`/cancel, so abort is the
   *   deterministic "stop waiting" event (no timer needed).
   */
  wait(signal: AbortSignal): Promise<GateWaitResult> {
    if (this.disposed) return Promise.resolve("settle")
    if (this.pending) {
      // A wake arrived while we were busy — consume it and run a turn now.
      this.pending = false
      return Promise.resolve("resume")
    }
    if (signal.aborted) return Promise.resolve("settle")
    return new Promise<GateWaitResult>((resolve) => {
      const onAbort = (): void => {
        // The parked resolver is cleared so a `wake` racing the abort cannot
        // resolve a stale promise.
        this.parkResolve = undefined
        resolve("settle")
      }
      this.parkResolve = (r: GateWaitResult): void => {
        signal.removeEventListener("abort", onAbort)
        this.parkResolve = undefined
        resolve(r)
      }
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  /** Trigger a turn. Parked (IDLE) ⇒ release the park (`woke`); busy ⇒ record a
   *  pending wake the next `wait` consumes (`queued`). Disposed ⇒ `queued` is
   *  a no-op lie, so we return `woke`/`queued` only for a LIVE gate — a
   *  disposed gate is unregistered by the runner's disposer, so `wake` never
   *  reaches it (the registry reports `no-receiver`).
   *
   *  INTERRUPT (`reason === "interrupt"`): on a BUSY child (not parked) we abort
   *  THIS turn's controller ({@link armTurn}'s `turnAbort`) so the in-flight
   *  stream/tool unwinds NOW, then record the pending wake so the unwound loop
   *  resumes into a fresh turn (the outcome is still `queued` — a turn WILL run,
   *  just after the interrupted one collapses immediately rather than completing
   *  its work). On an IDLE child there is nothing in flight, so interrupt is
   *  identical to followup: release the park (`woke`). `reason === "followup"`
   *  (or any other) NEVER aborts — byte-identical to the prior contract. */
  wake(reason: string): GateWakeResult {
    if (this.disposed) return "queued"
    const resolve = this.parkResolve
    if (resolve !== undefined) {
      // IDLE: nothing in flight — interrupt and followup are identical here.
      resolve("woke")
      return "woke"
    }
    // BUSY: a turn is in flight. An interrupt aborts it via the per-turn
    // controller (the in-flight stream/tool unwinds); followup leaves it to
    // complete. Either way a pending wake makes the loop take one more turn.
    if (reason === "interrupt") this.turnAbort?.abort()
    this.pending = true
    return "queued"
  }

  /** True iff the loop is currently parked on this gate (test/introspection). */
  isParked(): boolean {
    return this.parkResolve !== undefined
  }

  /** Release any park with `settle` and refuse future parks. Idempotent. The
   *  runner calls this from its `finally` so a child whose loop has ended can
   *  never leave a leaked promise or accept a wake. */
  dispose(): void {
    this.disposed = true
    const resolve = this.parkResolve
    if (resolve !== undefined) {
      // Restore the field guard before resolving so a re-entrant wake observes
      // "not parked".
      this.parkResolve = undefined
      resolve("settle")
    }
  }
}
