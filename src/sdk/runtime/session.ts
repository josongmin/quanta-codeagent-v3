import {
  type ConnectedSessionTransport,
  createSessionTransportBridge,
  type SessionTransport,
} from "@/ipc/session"
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
  SessionTranscriptReplaceCommand,
  TurnRunCommand,
} from "@/protocol/session"
import { SessionClosedError } from "@/protocol/session"
import { errMessage, logger } from "@/shared"
import { SessionSubscriptionHub } from "./subscription"
import type { RuntimeSession, SessionDispatchOptions, SessionDispatchResult } from "./types"

interface CreateRuntimeSessionArgs {
  readonly hostSession: SessionHost
  readonly kernel: Pick<KernelDispatchContext, "clock" | "eventLog">
}

export const createRuntimeSession = (args: CreateRuntimeSessionArgs): RuntimeSession => {
  let closed = false
  const hostDescription = args.hostSession.describe()
  let state: KernelSessionState = createKernelSessionState(hostDescription)
  const subscriptions = new SessionSubscriptionHub()
  const sessionId = state.sessionId
  let transportDispatchQueue: Promise<void> = Promise.resolve()
  let transportBridge: ReturnType<typeof createSessionTransportBridge> | undefined

  const ensureTransportBridge = (
    replayWindow?: number,
  ): ReturnType<typeof createSessionTransportBridge> => {
    if (transportBridge !== undefined) return transportBridge
    transportBridge = createSessionTransportBridge({
      snapshot: toSessionSnapshotLite(state),
      ...(replayWindow !== undefined ? { tailLimit: replayWindow } : {}),
      onCommand: async (command) => {
        // Sequence transport-issued commands on a single tail so they apply in
        // order. The tail MUST NOT stay rejected after one dispatch throws:
        // append a `.catch` BEFORE storing it back so a poisoned promise can
        // never wedge every subsequent command (L5 H-3). The caller still sees
        // the failure for THIS command (we re-await the un-caught run below).
        const run = transportDispatchQueue.then(async () => {
          await dispatch(command)
        })
        transportDispatchQueue = run.catch(() => undefined)
        await run
      },
      // L5 H-3: transport errors and rejected commands were silently dropped —
      // the bridge fired these callbacks but `session.ts` never supplied them,
      // so a failed transport / rejected command vanished with no diagnostic.
      onBridgeError: ({ error }) => {
        logger.error(`session transport bridge error (session=${sessionId}): ${errMessage(error)}`)
      },
      onCommandRejected: ({ command, error }) => {
        logger.warn(
          `session transport command rejected (session=${sessionId}, type=${command.type}): ${errMessage(error)}`,
        )
      },
    })
    return transportBridge
  }

  const publishEvents = (events: readonly SessionEvent[]): void => {
    for (const event of events) subscriptions.publish(event)
  }

  const publishCommittedEvents = async (
    committedState: KernelSessionState,
    events: readonly SessionEvent[],
  ): Promise<number> => {
    if (events.length === 0) return 0
    state = committedState
    publishEvents(events)
    await transportBridge?.publishEvents(events)
    transportBridge?.updateSnapshot(toSessionSnapshotLite(state))
    return events.length
  }

  const publishPendingEvents = async (
    events: readonly SessionEvent[],
    committedEventCount: number,
  ): Promise<void> => {
    const pendingEvents = committedEventCount === 0 ? events : events.slice(committedEventCount)
    if (pendingEvents.length > 0) {
      publishEvents(pendingEvents)
      await transportBridge?.publishEvents(pendingEvents)
    }
    if (committedEventCount === 0 || pendingEvents.length > 0) {
      transportBridge?.updateSnapshot(toSessionSnapshotLite(state))
    }
  }

  const toDispatchResult = (result: Awaited<ReturnType<typeof dispatchSessionCommand>>) => ({
    revision: state.revision,
    seq: state.seq,
    events: result.events,
    ...(result.transcriptMessages !== undefined
      ? { transcript: { messages: [...result.transcriptMessages] } }
      : {}),
    ...(result.turnResult !== undefined
      ? {
          turn: {
            outcome: result.turnResult.outcome,
            messages: [...result.turnResult.messages],
            ...(result.turnResult.artifacts !== undefined
              ? { artifacts: [...result.turnResult.artifacts] }
              : {}),
            ...(result.turnResult.approvalRequest !== undefined
              ? { approvalRequest: result.turnResult.approvalRequest }
              : {}),
          },
        }
      : {}),
  })

  const dispatch = async (
    command: SessionCommand,
    options: SessionDispatchOptions = {},
  ): Promise<SessionDispatchResult> => {
    if (closed) throw new SessionClosedError(sessionId)
    let committedEventCount = 0
    const result = await dispatchSessionCommand(state, command, {
      ...args.kernel,
      host: args.hostSession,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      onCommitted: async ({ state: committedState, events }) => {
        committedEventCount += await publishCommittedEvents(committedState, events)
      },
    })
    state = result.state
    await publishPendingEvents(result.events, committedEventCount)
    return toDispatchResult(result)
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

  const buildTranscriptReplace = (
    messages: readonly import("@/llm").Message[],
    meta:
      | Partial<Omit<SessionTranscriptReplaceCommand, "sessionId" | "type" | "messages">>
      | undefined,
  ): SessionTranscriptReplaceCommand => ({
    sessionId,
    type: "session.transcript.replace",
    messages: [...messages],
    ...commandMeta(meta),
  })

  return {
    sessionId,
    dispatch,
    subscribe: (listener) => subscriptions.subscribe(listener),
    snapshot: async () => toSessionSnapshotLite(state),
    attachSessionTransport: async (
      transport: SessionTransport,
      options: { readonly replayWindow?: number } = {},
    ): Promise<ConnectedSessionTransport> => {
      if (closed) throw new SessionClosedError(sessionId)
      const connected = await ensureTransportBridge(options.replayWindow).connect(transport)
      // Synthesise a `session.created` event for the freshly-attached client
      // so it can render the model pill + capability manifest without an
      // out-of-band lookup. This is intentionally per-attach (not
      // per-session-life) so a reconnecting client sees the same shape.
      const createdEvent: SessionEvent = {
        type: "session.created",
        eventId: crypto.randomUUID(),
        seq: state.seq,
        revision: state.revision,
        emittedAt: args.kernel.clock.now().toISOString(),
        capabilityManifest: state.capabilityManifest,
        ...(state.modelSlug !== undefined ? { model: state.modelSlug } : {}),
      }
      // Publish to in-proc subscribers AND the just-connected transport.
      publishEvents([createdEvent])
      await transportBridge?.publishEvents([createdEvent])
      return connected
    },
    close: async () => {
      if (closed) return
      closed = true
      await args.hostSession.close()
      state = { ...state, status: "closed", seq: state.seq + 1 }
      const event: SessionEvent = {
        eventId: crypto.randomUUID(),
        seq: state.seq,
        revision: state.revision,
        emittedAt: args.kernel.clock.now().toISOString(),
        type: "session.closed",
      }
      await args.kernel.eventLog.append(event)
      await transportBridge?.publishEvents([event])
      transportBridge?.updateSnapshot(toSessionSnapshotLite(state))
      publishEvents([event])
      await transportBridge?.close()
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
    transcript: {
      replace: async (messages, meta, options) =>
        dispatch(buildTranscriptReplace(messages, meta), options),
    },
    side: {
      start: async (sideArgs, _options) => {
        if (closed) throw new SessionClosedError(sessionId)
        if (args.hostSession.startSideConversation === undefined) {
          throw new Error("side conversation is not supported by this runtime session host")
        }
        return await args.hostSession.startSideConversation({
          ...sideArgs,
          messages: [...state.messages],
        })
      },
    },
  }
}
