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

/**
 * WS2 (RFC jul-18 §4.2) — the typed per-child control endpoint registered as
 * the canonical registration variant. This registry only STORES + hands back the
 * endpoint; it never owns/constructs it (the `@/agent` runner builds the
 * endpoint over the child's private gate + `activeTurnRef` and passes it here),
 * so the registry stays a pure PURE slice leaf with no `@/agent` dependency.
 * Structurally mirrors `SubagentControlEndpoint`
 * (`@/agent/subagent-delivery/ports`) — duck-typed so this slice never imports
 * `@/agent`. The legacy waker API is retained as an adapter variant, not as a
 * parallel registry: one task id always has exactly one atomic registration.
 */
export interface ControlEndpoint {
  readonly mailboxLabel: string
  wake(): WakeOutcome
  interrupt(): string
  steer(submission: unknown): string
  currentTurnId(): string | undefined
}

type ControlRegistration =
  | { readonly kind: "legacy"; readonly waker: Waker; readonly mailboxLabel?: string }
  | { readonly kind: "endpoint"; readonly endpoint: ControlEndpoint }

export class TurnWakeRegistry {
  /** Single authority cell per task. Endpoint, label, and wake behavior cannot
   *  be replaced independently, so mixed legacy/typed registration cannot form
   *  a split-brain view. */
  private readonly registrations = new Map<string, ControlRegistration>()

  /** Register a persistent waker for `agentId`. Returns a disposer the runner
   *  MUST call when the child loop terminates (so a wake on a dead agent
   *  reports `no-receiver`, not a leaked callback). Registering twice for the
   *  same id replaces the prior waker (last-writer-wins — the latest loop owns
   *  the child). `label` (when given) is the child's mailbox label, recorded so
   *  {@link labelOf} can translate this task id to its inbox address. */
  register(agentId: string, waker: Waker, label?: string): () => void {
    const registration: ControlRegistration = {
      kind: "legacy",
      waker,
      ...(label !== undefined ? { mailboxLabel: label } : {}),
    }
    this.registrations.set(agentId, registration)
    return () => {
      if (this.registrations.get(agentId) === registration) this.registrations.delete(agentId)
    }
  }

  /**
   * WS2 (RFC jul-18 §4.2) — register the typed control {@link ControlEndpoint}
   * for `taskId`. This is the SUPERSET of {@link register}: it stores the
   * endpoint as the whole registration. The legacy {@link wake} adapter derives
   * its behavior from that same cell (`endpoint.wake()` for followup;
   * `endpoint.interrupt()` for interrupt), so there is no second waker authority.
   *
   * Returns a disposer the runner MUST call when the child loop ends. Like
   * {@link register}, the disposer is LAST-WRITER-SAFE: it only removes the
   * endpoint/waker/label when they are STILL this registration's — a re-register
   * for the same id (a newer loop owning the child) is never clobbered by the
   * older disposer.
   */
  registerEndpoint(taskId: string, endpoint: ControlEndpoint): () => void {
    const registration: ControlRegistration = { kind: "endpoint", endpoint }
    this.registrations.set(taskId, registration)
    return () => {
      if (this.registrations.get(taskId) === registration) this.registrations.delete(taskId)
    }
  }

  /** WS2 — the typed control endpoint bound to `taskId`, or `undefined` when
   *  none is registered (the child never wired one, or its disposer already
   *  ran). WS3's delivery controller reads this to issue typed wake/interrupt/
   *  steer commands. */
  endpointFor(taskId: string): ControlEndpoint | undefined {
    const registration = this.registrations.get(taskId)
    return registration?.kind === "endpoint" ? registration.endpoint : undefined
  }

  /** The mailbox label bound to `agentId` (its registry task id), or `undefined`
   *  when none was recorded — `followup_task` resolves the delivery address with
   *  this so a message reaches the child's real inbox (`root/N`), not its task id. */
  labelOf(agentId: string): string | undefined {
    const registration = this.registrations.get(agentId)
    return registration?.kind === "endpoint"
      ? registration.endpoint.mailboxLabel
      : registration?.mailboxLabel
  }

  has(agentId: string): boolean {
    return this.registrations.has(agentId)
  }

  /** Wake `agentId`. Returns the waker's outcome, or `"no-receiver"` when no
   *  waker is registered. A throwing waker is treated as `"no-receiver"` (the
   *  trigger could not be honored) — the handler still reports delivery. */
  wake(agentId: string, reason: string): WakeOutcome {
    const registration = this.registrations.get(agentId)
    if (registration === undefined) return "no-receiver"
    try {
      if (registration.kind === "legacy") return registration.waker(reason)
      if (reason !== "interrupt") return registration.endpoint.wake()
      return registration.endpoint.interrupt() === "woke_idle" ? "woke" : "queued"
    } catch {
      return "no-receiver"
    }
  }
}
