/**
 * RFC-04 §5.2 / ADR-0437 — `TurnWakeRegistry`.
 *
 * Sibling of {@link InputChannelRegistry} (handlers-6.ts) but with a CRUCIAL
 * difference: `InputChannelRegistry` is ONE-SHOT and only for a child "paused
 * awaiting input" (its `deliver` pops the entry). `followup_task` must wake a
 * BUSY or IDLE running child and may wake it REPEATEDLY over the loop's
 * lifetime — so this registry is PERSISTENT (the waker stays registered until
 * the loop disposes it).
 *
 * The runner registers a waker when a child loop starts and calls the returned
 * disposer when the loop ends. The waker decides the outcome:
 *   - "woke"   — the child was idle (awaiting its next turn) and a turn was
 *     started/enqueued immediately.
 *   - "queued" — the child was mid-turn; a pending-wake was marked and the loop
 *     will take one more turn after the current one completes.
 *
 * If no waker is registered (the child never wired one), `wake` returns
 * "no-receiver" — the `followup_task` handler surfaces honest degradation
 * (`cause:"no_waker"`) while the mailbox delivery still stands.
 *
 * PURE: no `node:`, no clock, no globals. Deterministic.
 */

/** Outcome of a wake attempt. Closed enum. */
export type WakeOutcome = "woke" | "queued" | "no-receiver"

/** A waker function the runner registers for a child loop. `reason` is
 *  `"followup"` for a normal followup or `"interrupt"` when the caller asked to
 *  stop the current task and handle the message immediately. */
export type Waker = (reason: string) => WakeOutcome

export class TurnWakeRegistry {
  private readonly wakers = new Map<string, Waker>()

  /** Register a persistent waker for `agentId`. Returns a disposer the runner
   *  MUST call when the child loop terminates (so a wake on a dead agent
   *  reports `no-receiver`, not a leaked callback). Registering twice for the
   *  same id replaces the prior waker (last-writer-wins — the latest loop owns
   *  the child). */
  register(agentId: string, waker: Waker): () => void {
    this.wakers.set(agentId, waker)
    return () => {
      // Only delete if it is still OUR waker (a re-register may have replaced
      // it; the older disposer must not clobber the newer entry).
      if (this.wakers.get(agentId) === waker) this.wakers.delete(agentId)
    }
  }

  has(agentId: string): boolean {
    return this.wakers.has(agentId)
  }

  /** Wake `agentId`. Returns the waker's outcome, or `"no-receiver"` when no
   *  waker is registered. A throwing waker is treated as `"no-receiver"` (the
   *  trigger could not be honored) — the handler still reports delivery. */
  wake(agentId: string, reason: string): WakeOutcome {
    const waker = this.wakers.get(agentId)
    if (waker === undefined) return "no-receiver"
    try {
      return waker(reason)
    } catch {
      return "no-receiver"
    }
  }
}
