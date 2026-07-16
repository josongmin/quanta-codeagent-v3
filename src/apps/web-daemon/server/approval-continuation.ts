/**
 * `@/apps/web-daemon/server/approval-continuation` — ADR-0540 W1-B: the
 * post-approval continuation, ownership moved from the browser to the daemon.
 *
 * TODAY (gate OFF): the kernel does NOT auto-continue a resolved approval — a
 * fresh bare `turn.run` is what claims the grant lease and re-dispatches the
 * approved tool, and that `turn.run` is RE-ISSUED BY THE CLIENT (browser
 * `shouldContinueAfterApproval` + attach-client `decision === "approve"`
 * branch). The continuation therefore leaks to the client edge (ADR-0540
 * "관측된 결함"). Gate OFF ⇒ this module subscribes NOTHING (byte-identical).
 *
 * W1-B (gate ON): the daemon owns the continuation. It subscribes to the
 * shared session's events and, on every `approval.resolved` with decision
 * `approve` (normal OR escalation approve — both ride the wire as
 * `decision: "approve"`), fires a daemon-minted bare `turn.run` with
 * `{ enqueue: true }` so it rides the session's transport dispatch tail:
 *
 *  - NO DEADLOCK / NO SAME-CYCLE INLINE AWAIT: the subscriber fires while the
 *    `approval.respond` dispatch is still in flight; the re-issue is chained
 *    onto the tail (fire-and-forget) and runs strictly AFTER the respond
 *    settles — never `await`ed inside the respond's own dispatch cycle (the
 *    ADR-0540 web-inline deadlock class, `engine.ts` `transportDispatchQueue`).
 *  - EXACTLY-ONCE per resolution: the kernel emits `approval.resolved` only
 *    when a respond actually resolved the pending approval (a stale/duplicate
 *    respond is rejected `unknown_approval` and emits nothing), so a follower
 *    relay and an in-band browser respond can never double-arm the re-issue.
 *  - DENY = ABORT (no re-issue): the kernel clears the turn draft on deny, so
 *    a continuation `turn.run` would only reject `empty_turn_input`. This
 *    matches the wire reality of the legacy client flow (the browser's
 *    escalation-deny `turn.run` is already kernel-rejected for the same
 *    reason) — deny simply settles idle.
 *  - OLD-CLIENT DOUBLE `turn.run` is NEUTRALIZED server-side, with no absorb
 *    layer: transport commands and this re-issue serialize on ONE tail, and
 *    the completed continuation consumes the draft — so a non-marker-aware
 *    client's duplicate dispatches only after the turn settled and is
 *    deterministically rejected `empty_turn_input` (pinned in
 *    `tests/integration/approval-respond-mid-turn-web-daemon-e2e.test.ts`).
 *    KNOWN EDGE (pre-existing class, documented not absorbed): if the
 *    continued turn suspends on a SECOND approval, a stale duplicate re-runs
 *    the turn up to that gate — exactly what any bare `turn.run` during
 *    `awaiting_approval` does today, gate ON or OFF.
 *
 * The `serverAutoContinues` capability marker (see `runtime-factory.ts` +
 * `@/protocol/session/capabilities`) is declared under the SAME gate so
 * marker-aware clients skip their re-issue.
 */

import { SessionProtocolValidationError } from "@/protocol/session"
import type { RuntimeSession } from "@/sdk/runtime"
import { errMessage, gateOn, logger } from "@/shared"

/**
 * ADR-0540 gate — SAME env key W1-A introduced for the headless inline
 * resolver (`HEADLESS_INLINE_APPROVAL_GATE` in `apps/headless/approval-wiring`,
 * registered in the knob inventory). W1-B re-uses the key for the web-daemon
 * continuation ownership; declared locally because `@/apps/web-daemon` must
 * not import another app's composition module.
 */
export const WEB_INLINE_APPROVAL_GATE = "QUANTA_INLINE_APPROVAL_RESOLVER"

export interface ApprovalContinuationWiring {
  /** Detach the event subscription — `null` when the gate is OFF (nothing was
   *  subscribed; byte-identical legacy daemon). */
  readonly unsub: (() => void) | null
}

export const setupApprovalContinuation = (
  session: RuntimeSession,
  env: Record<string, string | undefined>,
): ApprovalContinuationWiring => {
  if (!gateOn(env, WEB_INLINE_APPROVAL_GATE)) return { unsub: null }
  const fire = (approvalId: string, retriedAfterLeaseRace: boolean): void => {
    // Daemon-minted continuation (the session library mints a fresh commandId
    // server-side). Enqueued, never awaited here — see the module contract.
    void session.turn.run(undefined, { enqueue: true }).catch((error: unknown) => {
      const issue = error instanceof SessionProtocolValidationError ? error.issue : undefined
      // Backstop (audit M-1): `enqueue` already chains behind the in-flight
      // direct dispatch (`engine.ts` activeDispatch) — deterministic for the
      // single-respond case. A lease-held here means MULTIPLE direct dispatches
      // overlapped the tail (latest-wins window); one re-enqueue re-chains
      // behind the then-current activity. Bounded to one retry: a second miss
      // is surfaced loudly below instead of polling the lease.
      if (issue === "single_writer_lease_held" && !retriedAfterLeaseRace) {
        fire(approvalId, true)
        return
      }
      // `empty_turn_input` = a (non-marker-aware) client's own re-issue won the
      // tail first and already consumed the draft — the benign duplicate case.
      const benign = issue === "empty_turn_input"
      const log = benign ? logger.info.bind(logger) : logger.warn.bind(logger)
      log("web-daemon: post-approval continuation turn.run settled without running", {
        approvalId,
        error: errMessage(error),
      })
    })
  }
  const unsub = session.subscribe((event) => {
    if (event.type !== "approval.resolved" || event.decision !== "approve") return
    fire(event.approvalId, false)
  })
  return { unsub }
}
