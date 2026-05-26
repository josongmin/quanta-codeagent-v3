import type { SessionHost } from "@/kernel/session"
import {
  createKernelSessionState,
  dispatchSessionCommand,
  type KernelDispatchContext,
  type KernelSessionState,
  toSessionSnapshotLite,
} from "@/kernel/session"
import type { ImageBlock } from "@/llm"
import type {
  ApprovalRespondCommand,
  InputAppendCommand,
  SessionCommand,
  SessionEvent,
  SessionIdentitySetCommand,
  SessionToolProfileSetCommand,
  TurnRunCommand,
} from "@/protocol/session"
import { SessionClosedError } from "@/protocol/session"
import { SessionSubscriptionHub } from "./subscription"
import type { RuntimeSession, SessionDispatchOptions, SessionDispatchResult } from "./types"

interface CreateRuntimeSessionArgs {
  readonly hostSession: SessionHost
  readonly kernel: Pick<KernelDispatchContext, "clock" | "eventLog">
}

export const createRuntimeSession = (args: CreateRuntimeSessionArgs): RuntimeSession => {
  let closed = false
  let state: KernelSessionState = createKernelSessionState(args.hostSession.describe())
  const subscriptions = new SessionSubscriptionHub()
  const sessionId = state.sessionId

  const publishEvents = (events: readonly SessionEvent[]): void => {
    for (const event of events) subscriptions.publish(event)
  }

  const dispatch = async (
    command: SessionCommand,
    options: SessionDispatchOptions = {},
  ): Promise<SessionDispatchResult> => {
    if (closed) throw new SessionClosedError(sessionId)
    const result = await dispatchSessionCommand(state, command, {
      ...args.kernel,
      host: args.hostSession,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    state = result.state
    publishEvents(result.events)
    return {
      revision: state.revision,
      seq: state.seq,
      events: result.events,
    }
  }

  const commandMeta = <
    T extends { commandId: string; issuedAt: string; expectedRevision?: number },
  >(
    meta: Partial<T> | undefined,
  ): T =>
    ({
      commandId: meta?.commandId ?? crypto.randomUUID(),
      issuedAt: meta?.issuedAt ?? args.kernel.clock.now().toISOString(),
      ...(meta?.expectedRevision !== undefined ? { expectedRevision: meta.expectedRevision } : {}),
    }) as T

  const buildInputAppend = (
    text: string,
    meta:
      | (Partial<Omit<InputAppendCommand, "sessionId" | "type" | "text" | "images">> & {
          readonly images?: readonly ImageBlock[]
        })
      | undefined,
  ): InputAppendCommand => ({
    sessionId,
    type: "input.append",
    text,
    ...commandMeta(meta),
    ...(meta?.images !== undefined && meta.images.length > 0 ? { images: meta.images } : {}),
  })

  const buildTurnRun = (
    meta: Partial<Omit<TurnRunCommand, "sessionId" | "type">> | undefined,
  ): TurnRunCommand => ({
    sessionId,
    type: "turn.run",
    ...commandMeta(meta),
  })

  const buildIdentitySet = (
    mode: string,
    meta: Partial<Omit<SessionIdentitySetCommand, "sessionId" | "type" | "mode">> | undefined,
  ): SessionIdentitySetCommand => ({
    sessionId,
    type: "session.identity.set",
    mode,
    ...commandMeta(meta),
  })

  const buildToolProfileSet = (
    profile: string,
    meta: Partial<Omit<SessionToolProfileSetCommand, "sessionId" | "type" | "profile">> | undefined,
  ): SessionToolProfileSetCommand => ({
    sessionId,
    type: "session.tool_profile.set",
    profile,
    ...commandMeta(meta),
  })

  const buildApprovalRespond = (
    approvalId: string,
    decision: "approve" | "deny",
    meta:
      | Partial<Omit<ApprovalRespondCommand, "sessionId" | "type" | "approvalId" | "decision">>
      | undefined,
  ): ApprovalRespondCommand => ({
    sessionId,
    type: "approval.respond",
    approvalId,
    decision,
    ...commandMeta(meta),
  })

  return {
    sessionId,
    dispatch,
    subscribe: (listener) => subscriptions.subscribe(listener),
    snapshot: async () => toSessionSnapshotLite(state),
    close: async () => {
      if (closed) return
      closed = true
      await args.hostSession.close()
      const event: SessionEvent = {
        eventId: crypto.randomUUID(),
        seq: state.seq + 1,
        revision: state.revision,
        emittedAt: args.kernel.clock.now().toISOString(),
        type: "session.closed",
      }
      await args.kernel.eventLog.append(event)
      publishEvents([event])
    },
    input: {
      append: async (text, meta, options) => dispatch(buildInputAppend(text, meta), options),
    },
    turn: {
      run: async (meta, options) => dispatch(buildTurnRun(meta), options),
    },
    identity: {
      set: async (mode, meta, options) => dispatch(buildIdentitySet(mode, meta), options),
    },
    toolProfile: {
      set: async (profile, meta, options) => dispatch(buildToolProfileSet(profile, meta), options),
    },
    approval: {
      respond: async (approvalId, decision, meta, options) =>
        dispatch(buildApprovalRespond(approvalId, decision, meta), options),
    },
  }
}
