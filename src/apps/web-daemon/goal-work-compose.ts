/**
 * GOAL-08 rail 15 (web half) — compose the daemon's user-requested goal-work
 * handler over the LIVE session.
 *
 * `/goal work` on the CLI mints `user-requested-goal-work` provenance: ONE
 * foreground turn that charges the user turn budget and mints a progress
 * receipt, but NEVER the autonomous hard-cap counter. This is that verb for the
 * web surface, reached by the out-of-band `goalWork` frame (see
 * {@link ./goal-work-frame}) — the host verb `turn.submitGoalWork` is the only
 * minter of the capability, so the wire cannot forge it.
 *
 * Refusals are TYPED and answered on the requesting socket. The round-4 lesson
 * from the CLI is load-bearing here: a request that CANNOT be claimed (no
 * active goal / fail-stopped attempt slot / over-long text) must be refused at
 * REQUEST time — never accepted and then silently dropped.
 *
 * Ack semantics (two frames at most, deliberately):
 *   1. `{ok:true, status:"accepted"}` as soon as the pre-checks pass and the
 *      turn is dispatched — the turn itself can run for minutes, so the ack is
 *      not the completion.
 *   2. `{ok:false, reason}` ONLY if that dispatch is then refused (a revision
 *      conflict, a claim refusal, a closed session). A completed turn sends
 *      nothing further: its output is the session's own event stream.
 */

import { sleep } from "@/agent/loop/sleep"
import type { ObjectiveAttemptSlot, ObjectivePort } from "@/objective"
import { createObjectiveCapabilities } from "@/objective"
import type { RuntimeSession } from "@/sdk/runtime"
import { errMessage } from "@/shared"

/** Bound on the free text a client may spend a turn on. Deliberate, local:
 *  the daemon has no shared free-text bound to inherit. */
export const MAX_GOAL_WORK_TEXT = 4_000

/** Cap on how long a shutdown drains in-flight work turns. A turn that never
 *  settles must not wedge `stop()`. */
const SETTLE_DRAIN_MS = 10_000

export type GoalWorkResult =
  | { readonly ok: true; readonly status: "accepted" }
  | { readonly ok: false; readonly reason: string }

export interface WebGoalWorkHandler {
  /** Pre-check + dispatch. Every outcome is reported through `reply`. */
  request(text: string, reply: (result: GoalWorkResult) => void): void
  /** Resolves when every dispatched work turn has settled, or after a bounded
   *  drain (a turn that never settles must not wedge daemon shutdown). */
  settled(timeoutMs?: number): Promise<void>
}

export interface WebGoalWorkPorts {
  readonly objectiveAuthority?: ObjectivePort | undefined
  readonly objectiveAttemptSlot?: ObjectiveAttemptSlot | undefined
}

/** `undefined` when this surface cannot attribute a goal turn (no objective
 *  authority, or a session without the host verb) ⇒ the frame is never
 *  consumed and falls through byte-identically. */
export const composeWebGoalWork = (args: {
  readonly session: RuntimeSession
  readonly runtime: WebGoalWorkPorts
}): WebGoalWorkHandler | undefined => {
  const authority = args.runtime.objectiveAuthority
  const submit = args.session.turn.submitGoalWork
  if (authority === undefined || submit === undefined) return undefined
  const read = createObjectiveCapabilities(authority).read
  const threadId = args.session.sessionId
  const inFlight = new Set<Promise<unknown>>()

  /** Synchronous refusals: nothing here may depend on the live session. */
  const refuseOnDomain = (text: string): string | undefined => {
    if (text.length > MAX_GOAL_WORK_TEXT) {
      return `goal work text is too long (max ${MAX_GOAL_WORK_TEXT} characters)`
    }
    const domain = read.readDomain(threadId)
    if (domain.state === null || domain.state.objective.status !== "active") {
      return "the goal is not active"
    }
    // The authority refuses an over-budget attempt INSIDE the turn, where the
    // failure becomes a `turn.failed` event and the dispatch still resolves —
    // i.e. accepted-then-silently-dropped. Refuse it here instead.
    const budget = domain.state.objective.budget
    if (budget.maxTurns !== undefined && budget.turnsUsed >= budget.maxTurns) {
      return `the goal turn budget is exhausted (${budget.turnsUsed}/${budget.maxTurns})`
    }
    const slot = args.runtime.objectiveAttemptSlot?.status()
    if (slot?.kind === "fail-stopped") {
      return `attempt slot fail-stopped (${slot.reason}); start a new goal to recover`
    }
    if (slot?.kind === "claimed") return "another goal turn is already claimed"
    return undefined
  }

  /** Live-session refusals: the kernel would reject these AFTER the ack, so the
   *  ack would be a lie. Checked against the same snapshot the turn is
   *  dispatched at (a change in between is still caught by the late refusal). */
  const refuseOnSession = (snapshot: {
    readonly state: { readonly status: string; readonly draftInput: string }
    readonly pendingApproval: unknown
  }): string | undefined => {
    if (snapshot.state.status !== "idle") return "the session is busy with another turn"
    if (snapshot.state.draftInput.trim().length > 0) return "the session has an unsent draft"
    if (snapshot.pendingApproval !== null) return "an approval is pending on this session"
    return undefined
  }

  return {
    request: (text, reply) => {
      const refusal = refuseOnDomain(text)
      if (refusal !== undefined) {
        reply({ ok: false, reason: refusal })
        return
      }
      const domain = read.readDomain(threadId)
      const objectiveId = domain.state?.objective.objectiveId ?? ""
      const expectedObjectiveRevision = domain.revision
      let accepted = false
      const started = (async () => {
        const snapshot = await args.session.snapshot()
        const busy = refuseOnSession(snapshot as never)
        if (busy !== undefined) {
          reply({ ok: false, reason: busy })
          return
        }
        accepted = true
        reply({ ok: true, status: "accepted" })
        await submit.call(args.session.turn, {
          text,
          expectedSessionRevision: snapshot.revision,
          objectiveId,
          objectiveRevision: expectedObjectiveRevision,
          // The authority is re-read at consume time: the goal must still be
          // the SAME active generation at the same revision.
          validateCurrent: () => {
            const current = read.readDomain(threadId)
            return (
              current.state?.objective.status === "active" &&
              current.state.objective.objectiveId === objectiveId &&
              current.revision === expectedObjectiveRevision
            )
          },
        })
      })()
      const tracked = started.catch((error: unknown) => {
        // Before the ack this IS the answer; after it, the late refusal.
        reply({
          ok: false,
          reason: accepted
            ? `goal work turn refused: ${errMessage(error)}`
            : `goal work could not start: ${errMessage(error)}`,
        })
      })
      inFlight.add(tracked)
      void tracked.finally(() => inFlight.delete(tracked))
    },
    settled: async (timeoutMs = SETTLE_DRAIN_MS) => {
      if (inFlight.size === 0) return
      // Bounded drain: the cap is an ABORT, not a raw sleep — the wait ends the
      // moment the last turn settles, and the timer is torn down either way.
      const cap = new AbortController()
      const timer = setTimeout(() => cap.abort(), Math.max(1, timeoutMs))
      try {
        while (inFlight.size > 0 && !cap.signal.aborted) {
          await Promise.race([Promise.all([...inFlight]), sleep(timeoutMs, cap.signal)])
        }
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
