import {
  type SessionCommand,
  type SessionEvent,
  SessionProtocolValidationError,
} from "@/protocol/session"
import { applyObjectiveCommand } from "./objective-command"
import type { KernelDispatchContext, SessionHostDescription } from "./ports"
import { applyPostureCommand } from "./posture-command"
import { reduceSessionCommand } from "./reducer"
import { appendEvents, notifyCommitted } from "./scheduler-append-isolation"
import { activeTurnControllers, runTurn, settlePreAbortedTurnRun } from "./scheduler-turn-execution"
import type { KernelDispatchResult } from "./scheduler-turn-terminals"
import { applySkillCommand } from "./skill-command"
import { type KernelSessionState, toSessionStateView } from "./state"

/**
 * Session-command DISPATCH — the kernel's single front door.
 *
 * ONE responsibility: take one `SessionCommand` against one session state and
 * route it. That is the lease-free `turn.cancel` fast-path (which must reach a
 * live turn WITHOUT contending on the single-writer lease the turn holds), the
 * single-writer-lease-guarded body that reduces the command, applies the
 * host-owned projections (identity / tool-profile / posture / objective /
 * skill), persists + notifies, and finally the per-command-type routing that
 * hands `turn.run` to the executor.
 *
 * The three collaborators it composes each own one layer beneath it:
 *   · `scheduler-append-isolation.ts` — persistence / observer no-throw sinks.
 *   · `scheduler-turn-terminals.ts`   — what each turn terminal commits.
 *   · `scheduler-turn-execution.ts`   — running a `turn.run` + the cancel registry.
 *
 * Every public name this module carried before the split is still exported from
 * HERE (re-exported below where the definition moved), so no consumer import
 * path changes.
 */

export {
  getKernelStreamAppendFailures,
  getKernelTerminalAppendFailures,
  setKernelObserverErrorSink,
  setKernelStreamAppendErrorSink,
  setKernelTerminalAppendErrorSink,
} from "./scheduler-append-isolation"
export type { KernelDispatchResult } from "./scheduler-turn-terminals"

const reconcileSessionPostureState = (
  state: KernelSessionState,
  host: Pick<SessionHostDescription, "permissionMode" | "identityMode" | "toolProfile" | "posture">,
): KernelSessionState => {
  const {
    permissionMode: _permissionMode,
    identityMode: _identityMode,
    toolProfile: _toolProfile,
    posture: _posture,
    ...rest
  } = state
  return {
    ...rest,
    permissionMode: host.permissionMode,
    ...(host.identityMode !== undefined ? { identityMode: host.identityMode } : {}),
    ...(host.toolProfile !== undefined ? { toolProfile: host.toolProfile } : {}),
    // RFC-05 E4 — carry the host's resolved posture echo (requested/effective/
    // locks) at the same revision. Absent ⇒ byte-identical (no posture control).
    ...(host.posture !== undefined ? { posture: host.posture } : {}),
  }
}

const rewriteStateUpdatedEvent = (event: SessionEvent, state: KernelSessionState): SessionEvent =>
  event.type === "session.state.updated"
    ? {
        ...event,
        revision: state.revision,
        state: toSessionStateView(state),
      }
    : event

const validateTurnSubmitProvenance = (
  command: SessionCommand,
  ctx: KernelDispatchContext,
): void => {
  if (command.type !== "turn.submit") return
  if (ctx.consumeTurnSubmitProvenance?.(command.provenance) !== true) {
    throw new SessionProtocolValidationError("invalid_turn_submit_provenance")
  }
}

/** GOAL-08 (round 3) — claim the host's attributed-attempt slot for THIS
 *  turn, inside the serialized dispatch: after the reducer guards (idle /
 *  revision / approval) and the one-use capability were accepted, right
 *  before this same turn runs. Claiming any earlier (e.g. at the SDK verb,
 *  before `dispatch`) lets a user turn already queued ahead start first and
 *  `take()` the claim — the user's own turn would be charged as the goal
 *  attempt. Returns the release for a turn that fails to start after the
 *  claim; `undefined` for a turn that carries no goal provenance. */
const claimGoalAttemptForTurn = (
  state: KernelSessionState,
  command: SessionCommand,
  ctx: KernelDispatchContext,
): (() => void) | undefined => {
  if (command.type !== "turn.submit") return undefined
  const provenance = command.provenance
  const autonomous = provenance.kind === "goal-continuation"
  const claimed = ctx.host.claimGoalAttempt?.({
    threadId: state.sessionId,
    objectiveId: provenance.objectiveId,
    startedRevision: provenance.objectiveRevision,
    attemptId: provenance.attemptId,
    provenance: autonomous ? "autonomous-continuation" : "user-requested-goal-work",
    executionMode: autonomous ? "background" : "foreground",
  })
  if (claimed !== true) throw new SessionProtocolValidationError("goal_attempt_claim_refused")
  return () => ctx.host.releaseGoalAttempt?.()
}

/** Run the HOST-side effect a command carries, if it carries one, and say
 *  whether the kernel state must then be re-read from the host.
 *
 *  One unit because "which host method does this command drive" is one
 *  question with one answer per arm, and because every arm shares the same
 *  typed-negative contract: a rejected projection THROWS here, BEFORE the
 *  caller appends any success echo — a stale/policy-rejected mutation must
 *  never surface as a silent `session.state.updated`.
 *
 *  `"reconcile"` vs `"none"` is the real axis: identity / tool-profile /
 *  posture mutate KERNEL-mirrored state, so the caller must re-project from
 *  `host.describe()`. The objective and skill domains are HOST-owned — the
 *  reducer's session revision echo is already the whole story, so a reconcile
 *  there would be a no-op re-read. */
const runHostProjection = async (
  ctx: KernelDispatchContext,
  command: SessionCommand,
): Promise<"reconcile" | "none"> => {
  switch (command.type) {
    case "session.identity.set":
      await ctx.host.setIdentityMode?.(command.mode)
      return "reconcile"
    case "session.tool_profile.set":
      await ctx.host.setToolProfile?.(command.profile)
      return "reconcile"
    case "session.permission.set":
    case "session.posture.set":
      // RFC-05 E4 — route the posture front door + the permission.set adapter
      // through the single host projection; a negative outcome THROWS a typed
      // error BEFORE any success echo is appended (never a silent success).
      await applyPostureCommand(ctx, command)
      return "reconcile"
    case "session.objective.mutate":
      // RFC-03 C3/M7 — apply the objective mutation to the host authority (actor
      // `user`, CAS on `expectedRevision`) through the single projection; a
      // stale/policy-rejected outcome THROWS a typed conflict BEFORE any success
      // echo is appended (never a silent success). The objective domain is
      // host-owned, so on `ok` there is no kernel-state reconcile — the reducer
      // already emitted the session revision echo.
      await applyObjectiveCommand(ctx, command)
      return "none"
    case "session.skill.set_enabled":
      await applySkillCommand(ctx, command) // RFC-06 F5 — CAS via host; typed-throw on negative
      return "none"
    default:
      return "none"
  }
}

/** The host projection PLUS its state/echo consequence. Separate from
 *  {@link runHostProjection} because the reconcile tail was spelled three
 *  times — once per reconciling arm — and three copies of "re-describe, then
 *  rewrite every state echo at the new revision" is exactly the kind of
 *  duplication where one copy silently drifts. */
const applyHostProjection = async (
  ctx: KernelDispatchContext,
  command: SessionCommand,
  state: KernelSessionState,
  events: readonly SessionEvent[],
): Promise<{ readonly state: KernelSessionState; readonly events: SessionEvent[] }> => {
  const effect = await runHostProjection(ctx, command)
  if (effect === "none") return { state, events: [...events] }
  const reconciled = reconcileSessionPostureState(state, ctx.host.describe())
  return {
    state: reconciled,
    events: events.map((event) => rewriteStateUpdatedEvent(event, reconciled)),
  }
}

/** Persist + notify, and on failure UN-register the turn controller this
 *  dispatch pre-registered.
 *
 *  A unit because the compensation is the whole point: the controller is
 *  registered BEFORE this await (Audit R2 H1 — so a `turn.cancel` dispatched
 *  during the persistence window reaches a LIVE target via the lease-free
 *  fast-path instead of contending on the lease this dispatch holds), which
 *  means a persistence failure would otherwise leak a stale registry entry.
 *  The identity check (`get(...) === controller`) is load-bearing: if some
 *  other dispatch has since replaced the entry, this one must NOT delete it. */
const commitOrDropController = async (
  ctx: KernelDispatchContext,
  sessionId: string,
  state: KernelSessionState,
  events: readonly SessionEvent[],
  controller: AbortController | undefined,
): Promise<void> => {
  try {
    await appendEvents(ctx.eventLog, events)
    await notifyCommitted(ctx, { state, events })
  } catch (e) {
    // Persistence failed before runTurn could adopt the controller — drop it
    // so the pre-registration doesn't leak a stale entry.
    if (controller !== undefined && activeTurnControllers.get(sessionId) === controller) {
      activeTurnControllers.delete(sessionId)
    }
    throw e
  }
}

/** Per-command-type routing of the ALREADY-committed dispatch: what each
 *  command hands back once its events are durable. A unit because it is the
 *  one part of dispatch that runs AFTER the commit point — everything above it
 *  may still throw and un-commit, nothing here may. */
const routeDispatchResult = async (args: {
  readonly state: KernelSessionState
  readonly command: SessionCommand
  readonly ctx: KernelDispatchContext
  readonly reduced: ReturnType<typeof reduceSessionCommand>
  readonly events: SessionEvent[]
  readonly turnController: AbortController | undefined
}): Promise<KernelDispatchResult> => {
  const { state, command, ctx, reduced, events, turnController } = args
  switch (command.type) {
    case "session.identity.set":
    case "session.tool_profile.set":
    case "session.permission.set":
    case "session.posture.set":
    case "session.skill.set_enabled":
      return { state, events }
    case "session.transcript.replace":
      return {
        state,
        events,
        transcriptMessages: [...command.messages],
      }
    case "approval.respond":
      await ctx.host.resolveApproval?.({
        approvalId: command.approvalId,
        decision: command.decision,
        // ADR-0512 P3 — forward the escalation's once/session scope + steer so
        // the host lease carries the operator's rich decision. Both absent on a
        // normal approval ⇒ byte-identical grant.
        ...(command.scope !== undefined ? { scope: command.scope } : {}),
        ...(command.steer !== undefined ? { steer: command.steer } : {}),
        // T05 — forward the web/SDK operator's per-hunk choice so the host can
        // apply only the accepted subset. Absent ⇒ whole-call, byte-identical.
        ...(command.selectedHunks !== undefined ? { selectedHunks: command.selectedHunks } : {}),
      })
      return { state, events }
    case "turn.run":
    case "turn.submit":
      return await runTurn({
        state,
        command,
        ctx,
        reduced,
        events,
        ...(turnController !== undefined ? { turnController } : {}),
      })
    default:
      return { state, events }
  }
}

export const dispatchSessionCommand = async (
  state: KernelSessionState,
  command: SessionCommand,
  ctx: KernelDispatchContext,
): Promise<KernelDispatchResult> => {
  // T03 (audit L5 C-1) — EXECUTE the cancel decision BEFORE acquiring the
  // single-writer lease. The lease is held for the entire duration of an
  // in-flight `turn.run`, so a `turn.cancel` that waited on the lease could
  // never reach the running turn. Aborting the registered turn-owned controller
  // is a synchronous side-effect on the shared controller object the running
  // turn already observes through its composed signal — cancellation propagates
  // immediately.
  //
  // When there IS a live turn we return right here, WITHOUT contending on the
  // lease: the running turn is the authoritative owner of the terminal state
  // transition and settles itself as `aborted` (see `onTurnAborted`). Acquiring
  // the lease here would deadlock/throw against the holder. When there is no
  // live turn, fall through to the lease-guarded block so an idle `turn.cancel`
  // is still a clean, deterministic no-op echo.
  if (command.type === "turn.cancel") {
    const live = activeTurnControllers.get(state.sessionId)
    if (live !== undefined) {
      live.abort()
      // ALBB-04 (P2 doc): the empty `events: []` echo is DELIBERATE — the live
      // turn is the authoritative owner of the terminal transition and emits it
      // itself (settling `aborted` via `onTurnAborted` ⇒ the dedicated
      // `turn.aborted` event). A terminal echo here would double-emit.
      return { state, events: [] }
    }
  }
  return await state.lease.runWith(command.commandId, async () => {
    const emittedAt = ctx.clock.now().toISOString()
    // T03 (audit L5 H-8) — dispatch-level abort gate. `signal.aborted` is now
    // checked at the dispatch boundary, so a `turn.run` never starts host work
    // on an already-dead signal (previously the signal was merely forwarded to
    // the host with no dispatch-level guard). We classify it as an aborted turn
    // and reuse the reducer's `turn.cancel` transition rather than throwing past
    // the reducer; the running-turn catch path uses the shared `isAbort`
    // primitive for the symmetric mid-flight case.
    if (command.type === "turn.run" && ctx.signal?.aborted === true) {
      return await settlePreAbortedTurnRun({ state, command, ctx, emittedAt })
    }
    const reduced = reduceSessionCommand(state, command, emittedAt)
    validateTurnSubmitProvenance(command, ctx)
    const releaseGoalClaim = claimGoalAttemptForTurn(state, command, ctx)
    try {
      // `reduced.events` is read BEFORE `reduced.state`: an unrecognised command
      // type makes the reducer return nothing, and the resulting TypeError names
      // the field the original read first.
      const immediateEvents = [...reduced.events]
      const projected = await applyHostProjection(
        ctx,
        command,
        { ...reduced.state, seq: state.seq + immediateEvents.length },
        immediateEvents,
      )
      // Audit R2 H1: register the turn-owned cancel controller BEFORE the awaited
      // event-log persistence so a turn.cancel dispatched during that window —
      // which cannot acquire the held single-writer lease — reaches a LIVE target
      // via the fast-path instead of contending on the lease (which throws
      // lease-held while the turn proceeds uncancelled).
      let preRegisteredController: AbortController | undefined
      if (command.type === "turn.run" || command.type === "turn.submit") {
        preRegisteredController = new AbortController()
        activeTurnControllers.set(state.sessionId, preRegisteredController)
      }
      await commitOrDropController(
        ctx,
        state.sessionId,
        projected.state,
        projected.events,
        preRegisteredController,
      )
      return await routeDispatchResult({
        state: projected.state,
        command,
        ctx,
        reduced,
        events: projected.events,
        turnController: preRegisteredController,
      })
    } catch (error) {
      // A claim the turn never consumed (commit / host failure before the
      // runner took it) must not leak into the next attributed turn. After a
      // take the slot is already empty ⇒ no-op; a fail-stop is preserved.
      releaseGoalClaim?.()
      throw error
    }
  })
}
