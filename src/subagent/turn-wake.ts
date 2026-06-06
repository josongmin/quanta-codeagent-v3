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
  /** `agentId` (the registry TASK id `followup_task` targets) → that child's
   *  MAILBOX label (`root/N`). The two id namespaces are disjoint: a child is
   *  registered here under its task id but reads its inbox under its mailbox
   *  label, so `followup_task`'s mailbox delivery MUST translate task id →
   *  label or the message goes to a phantom address (jun-07 BUG#4 fix). */
  private readonly labels = new Map<string, string>()

  /** Register a persistent waker for `agentId`. Returns a disposer the runner
   *  MUST call when the child loop terminates (so a wake on a dead agent
   *  reports `no-receiver`, not a leaked callback). Registering twice for the
   *  same id replaces the prior waker (last-writer-wins — the latest loop owns
   *  the child). `label` (when given) is the child's mailbox label, recorded so
   *  {@link labelOf} can translate this task id to its inbox address. */
  register(agentId: string, waker: Waker, label?: string): () => void {
    this.wakers.set(agentId, waker)
    if (label !== undefined) this.labels.set(agentId, label)
    return () => {
      // Only delete if it is still OUR waker (a re-register may have replaced
      // it; the older disposer must not clobber the newer entry). The label is
      // dropped under the SAME guard so a re-registered child keeps its label.
      if (this.wakers.get(agentId) === waker) {
        this.wakers.delete(agentId)
        this.labels.delete(agentId)
      }
    }
  }

  /** The mailbox label bound to `agentId` (its registry task id), or `undefined`
   *  when none was recorded — `followup_task` resolves the delivery address with
   *  this so a message reaches the child's real inbox (`root/N`), not its task id. */
  labelOf(agentId: string): string | undefined {
    return this.labels.get(agentId)
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
