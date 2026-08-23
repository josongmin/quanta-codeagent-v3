import type { SessionCommand, SessionEvent } from "@/protocol/session"
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
    let immediateEvents = [...reduced.events]
    let nextState: KernelSessionState = {
      ...reduced.state,
      seq: state.seq + immediateEvents.length,
    }
    if (command.type === "session.identity.set") {
      await ctx.host.setIdentityMode?.(command.mode)
      nextState = reconcileSessionPostureState(nextState, ctx.host.describe())
      immediateEvents = immediateEvents.map((event) => rewriteStateUpdatedEvent(event, nextState))
    } else if (command.type === "session.tool_profile.set") {
      await ctx.host.setToolProfile?.(command.profile)
      nextState = reconcileSessionPostureState(nextState, ctx.host.describe())
      immediateEvents = immediateEvents.map((event) => rewriteStateUpdatedEvent(event, nextState))
    } else if (
      command.type === "session.permission.set" ||
      command.type === "session.posture.set"
    ) {
      // RFC-05 E4 — route the posture front door + the permission.set adapter
      // through the single host projection; a negative outcome THROWS a typed
      // error BEFORE any success echo is appended (never a silent success).
      await applyPostureCommand(ctx, command)
      nextState = reconcileSessionPostureState(nextState, ctx.host.describe())
      immediateEvents = immediateEvents.map((event) => rewriteStateUpdatedEvent(event, nextState))
    } else if (command.type === "session.objective.mutate") {
      // RFC-03 C3/M7 — apply the objective mutation to the host authority (actor
      // `user`, CAS on `expectedRevision`) through the single projection; a
      // stale/policy-rejected outcome THROWS a typed conflict BEFORE any success
      // echo is appended (never a silent success). The objective domain is
      // host-owned, so on `ok` there is no kernel-state reconcile — the reducer
      // already emitted the session revision echo.
      await applyObjectiveCommand(ctx, command)
    } else if (command.type === "session.skill.set_enabled") {
      await applySkillCommand(ctx, command) // RFC-06 F5 — CAS via host; typed-throw on negative
    }
    // Audit R2 H1: register the turn-owned cancel controller BEFORE the awaited
    // event-log persistence so a turn.cancel dispatched during that window —
    // which cannot acquire the held single-writer lease — reaches a LIVE target
    // via the fast-path instead of contending on the lease (which throws
    // lease-held while the turn proceeds uncancelled).
    let preRegisteredController: AbortController | undefined
    if (command.type === "turn.run") {
      preRegisteredController = new AbortController()
      activeTurnControllers.set(state.sessionId, preRegisteredController)
    }
    try {
      await appendEvents(ctx.eventLog, immediateEvents)
      await notifyCommitted(ctx, { state: nextState, events: immediateEvents })
    } catch (e) {
      // Persistence failed before runTurn could adopt the controller — drop it
      // so the pre-registration doesn't leak a stale entry.
      if (
        preRegisteredController !== undefined &&
        activeTurnControllers.get(state.sessionId) === preRegisteredController
      ) {
        activeTurnControllers.delete(state.sessionId)
      }
      throw e
    }
    switch (command.type) {
      case "session.identity.set":
      case "session.tool_profile.set":
      case "session.permission.set":
      case "session.posture.set":
      case "session.skill.set_enabled":
        return { state: nextState, events: immediateEvents }
      case "session.transcript.replace":
        return {
          state: nextState,
          events: immediateEvents,
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
        return { state: nextState, events: immediateEvents }
      case "turn.run":
        return await runTurn({
          state: nextState,
          command,
          ctx,
          reduced,
          events: immediateEvents,
          ...(preRegisteredController !== undefined
            ? { turnController: preRegisteredController }
            : {}),
        })
      default:
        return { state: nextState, events: immediateEvents }
    }
  })
}
