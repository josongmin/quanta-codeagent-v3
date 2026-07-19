/**
 * Test fixture — minimal `RuntimeFacade` that returns a stub `RuntimeSession`.
 *
 * Goals:
 *   - Boot fast (no agent loop, no LLM, no filesystem).
 *   - Round-trip a `SessionTransportMessage` through the daemon: a `connect`
 *     command should trigger a snapshot frame back to the client.
 *   - Exercise the same `attachSessionTransport()` path the real runtime
 *     owns so web-daemon tests cover command ordering / event replay.
 *   - Track close to assert teardown drives runtime.close().
 */

import {
  type ConnectedSessionTransport,
  createSessionTransportBridge,
  type SessionTransport,
} from "@/ipc/session"
import type { ImageBlock } from "@/llm"
import {
  type PendingApprovalView,
  type SessionCommand,
  type SessionEvent,
  SessionProtocolValidationError,
  type SessionSnapshotLite,
} from "@/protocol/session"
import type {
  RuntimeFacade,
  RuntimeSession,
  SessionDispatchOptions,
  SessionDispatchResult,
} from "@/sdk/runtime"
import { capabilitiesFor, makeSnapshotLite } from "../../../support/session-fixtures"

const STUB_CAPS = capabilitiesFor({ transport: "websocket" })

interface StubBag {
  sessionsCreated: number
  sessionsClosed: number
  runtimeClosed: boolean
  lastSession: RuntimeSession | undefined
  attachTransportCalls: number
  /** `replayWindow` the daemon passed on the most recent attach (or undefined). */
  lastAttachReplayWindow: number | undefined
}

interface StubRuntimeFactoryOptions {
  /** When a turn's exact draft matches this text, park it on a real pending
   *  approval instead of completing. The subsequent exact `approval.respond`
   *  command clears the pending state and emits `approval.resolved`. */
  readonly approvalOnPrompt?: string
}

type InputAppendCommand = Extract<SessionCommand, { type: "input.append" }>
type TurnRunCommand = Extract<SessionCommand, { type: "turn.run" }>
type ApprovalRespondCommand = Extract<SessionCommand, { type: "approval.respond" }>

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

const appendDraft = (draft: string, next: string): string =>
  draft.length === 0 ? next : `${draft}\n${next}`

const emitEvent = (
  listeners: ReadonlySet<(event: SessionEvent) => void>,
  event: SessionEvent,
): void => {
  for (const listener of [...listeners]) listener(event)
}

export const createStubRuntimeFactory = (
  options: StubRuntimeFactoryOptions = {},
): {
  factory: () => Promise<RuntimeFacade>
  bag: StubBag
  emit: (event: SessionEvent) => void
} => {
  const bag: StubBag = {
    sessionsCreated: 0,
    sessionsClosed: 0,
    runtimeClosed: false,
    lastSession: undefined,
    attachTransportCalls: 0,
    lastAttachReplayWindow: undefined,
  }
  let externalEmit = (_event: SessionEvent): void => undefined
  const factory = async (): Promise<RuntimeFacade> => ({
    createSession: async (): Promise<RuntimeSession> => {
      bag.sessionsCreated += 1
      const sessionId = `stub-session-${bag.sessionsCreated}`
      const listeners = new Set<(event: SessionEvent) => void>()
      let snapshot: SessionSnapshotLite = makeSnapshotLite({
        sessionId,
        revision: 1,
        seq: 0,
        capabilities: STUB_CAPS,
      })
      let draftImages: readonly ImageBlock[] = []
      let transportBridge: ReturnType<typeof createSessionTransportBridge> | undefined
      let transportDispatchQueue: Promise<void> = Promise.resolve()
      let sessionClosed = false

      const publish = async (events: readonly SessionEvent[]): Promise<void> => {
        for (const event of events) emitEvent(listeners, event)
        await transportBridge?.publishEvents(events)
        transportBridge?.updateSnapshot(snapshot)
      }

      const handleInputAppend = async (
        command: InputAppendCommand,
      ): Promise<SessionDispatchResult> => {
        // Delay append a little so a server that dispatches commands
        // concurrently will race `turn.run` against the stale draft.
        await sleep(20)
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          seq: snapshot.seq + 1,
          state: {
            ...snapshot.state,
            draftInput: appendDraft(snapshot.state.draftInput, command.text),
          },
        }
        draftImages = [...draftImages, ...(command.images ?? [])]
        const event: Extract<SessionEvent, { type: "session.state.updated" }> = {
          eventId: crypto.randomUUID(),
          seq: snapshot.seq,
          revision: snapshot.revision,
          emittedAt: new Date().toISOString(),
          causedByCommandId: command.commandId,
          type: "session.state.updated",
          state: snapshot.state,
        }
        await publish([event])
        return { revision: snapshot.revision, seq: snapshot.seq, events: [event] }
      }

      const handleApprovalTurn = async (
        command: TurnRunCommand,
        prompt: string,
      ): Promise<SessionDispatchResult> => {
        const approval: PendingApprovalView = {
          approvalId: `stub-approval-${crypto.randomUUID()}`,
          reason: `operator approval required for: ${prompt}`,
          requestedAt: new Date().toISOString(),
        }
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          seq: snapshot.seq + 3,
          state: {
            ...snapshot.state,
            status: "awaiting_approval",
            messageCount: snapshot.state.messageCount + 1,
            lastUserText: prompt,
          },
          pendingApproval: approval,
        }
        const started: Extract<SessionEvent, { type: "turn.started" }> = {
          eventId: crypto.randomUUID(),
          seq: snapshot.seq - 2,
          revision: snapshot.revision,
          emittedAt: new Date().toISOString(),
          causedByCommandId: command.commandId,
          type: "turn.started",
          prompt,
        }
        const requested: Extract<SessionEvent, { type: "approval.requested" }> = {
          eventId: crypto.randomUUID(),
          seq: snapshot.seq - 1,
          revision: snapshot.revision,
          emittedAt: new Date().toISOString(),
          causedByCommandId: command.commandId,
          type: "approval.requested",
          approval,
        }
        const updated: Extract<SessionEvent, { type: "session.state.updated" }> = {
          eventId: crypto.randomUUID(),
          seq: snapshot.seq,
          revision: snapshot.revision,
          emittedAt: new Date().toISOString(),
          causedByCommandId: command.commandId,
          type: "session.state.updated",
          state: snapshot.state,
        }
        await publish([started, requested, updated])
        return {
          revision: snapshot.revision,
          seq: snapshot.seq,
          events: [started, requested, updated],
          approvalRequest: approval,
        }
      }

      const handleCompletedTurn = async (
        command: TurnRunCommand,
        prompt: string,
      ): Promise<SessionDispatchResult> => {
        const assistantText = `stub: ${prompt}`
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          seq: snapshot.seq + 2,
          state: {
            ...snapshot.state,
            status: "running",
            messageCount: snapshot.state.messageCount + 1,
            lastUserText: prompt,
          },
        }
        const started: Extract<SessionEvent, { type: "turn.started" }> = {
          eventId: crypto.randomUUID(),
          seq: snapshot.seq - 1,
          revision: snapshot.revision,
          emittedAt: new Date().toISOString(),
          causedByCommandId: command.commandId,
          type: "turn.started",
          prompt: snapshot.state.draftInput,
          ...(draftImages.length > 0 ? { images: draftImages } : {}),
        }
        const updated: Extract<SessionEvent, { type: "session.state.updated" }> = {
          eventId: crypto.randomUUID(),
          seq: snapshot.seq,
          revision: snapshot.revision,
          emittedAt: new Date().toISOString(),
          causedByCommandId: command.commandId,
          type: "session.state.updated",
          state: snapshot.state,
        }
        await publish([started, updated])
        for (const delta of ["stub: ", prompt]) {
          snapshot = {
            ...snapshot,
            revision: snapshot.revision + 1,
            seq: snapshot.seq + 1,
            state: {
              ...snapshot.state,
              streamingAssistantText: `${snapshot.state.streamingAssistantText ?? ""}${delta}`,
            },
          }
          const deltaEvent: Extract<SessionEvent, { type: "turn.output.delta" }> = {
            eventId: crypto.randomUUID(),
            seq: snapshot.seq,
            revision: snapshot.revision,
            emittedAt: new Date().toISOString(),
            causedByCommandId: command.commandId,
            type: "turn.output.delta",
            delta,
          }
          await publish([deltaEvent])
        }
        const { streamingAssistantText: _streamingAssistantText, ...runningState } = snapshot.state
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          seq: snapshot.seq + 2,
          state: {
            ...runningState,
            status: "idle",
            draftInput: "",
            messageCount: snapshot.state.messageCount + 1,
            lastAssistantText: assistantText,
            lastOutcomeReason: "completed",
          },
        }
        draftImages = []
        const completed: Extract<SessionEvent, { type: "turn.completed" }> = {
          eventId: crypto.randomUUID(),
          seq: snapshot.seq - 1,
          revision: snapshot.revision,
          emittedAt: new Date().toISOString(),
          causedByCommandId: command.commandId,
          type: "turn.completed",
          outcomeReason: "completed",
          assistantText,
        }
        const completedState: Extract<SessionEvent, { type: "session.state.updated" }> = {
          eventId: crypto.randomUUID(),
          seq: snapshot.seq,
          revision: snapshot.revision,
          emittedAt: new Date().toISOString(),
          causedByCommandId: command.commandId,
          type: "session.state.updated",
          state: snapshot.state,
        }
        await publish([completed, completedState])
        return {
          revision: snapshot.revision,
          seq: snapshot.seq,
          events: [started, updated, completed, completedState],
        }
      }

      const handleTurnRun = async (command: TurnRunCommand): Promise<SessionDispatchResult> => {
        if (snapshot.state.draftInput.trim().length === 0 && draftImages.length === 0) {
          throw new SessionProtocolValidationError("empty_turn_input")
        }
        const prompt = snapshot.state.draftInput
        return options.approvalOnPrompt === prompt
          ? await handleApprovalTurn(command, prompt)
          : await handleCompletedTurn(command, prompt)
      }

      const handleApprovalRespond = async (
        command: ApprovalRespondCommand,
      ): Promise<SessionDispatchResult> => {
        const pending = snapshot.pendingApproval
        // Unknown/stale responses are intentionally absorbed by this
        // shared-session fixture: no event, no state mutation, wire stays live.
        if (pending === null || pending.approvalId !== command.approvalId) {
          return { revision: snapshot.revision, seq: snapshot.seq, events: [] }
        }
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          seq: snapshot.seq + 2,
          state: {
            ...snapshot.state,
            status: "idle",
            draftInput: "",
          },
          pendingApproval: null,
        }
        const resolved: Extract<SessionEvent, { type: "approval.resolved" }> = {
          eventId: crypto.randomUUID(),
          seq: snapshot.seq - 1,
          revision: snapshot.revision,
          emittedAt: new Date().toISOString(),
          causedByCommandId: command.commandId,
          type: "approval.resolved",
          approvalId: command.approvalId,
          decision: command.decision,
        }
        const updated: Extract<SessionEvent, { type: "session.state.updated" }> = {
          eventId: crypto.randomUUID(),
          seq: snapshot.seq,
          revision: snapshot.revision,
          emittedAt: new Date().toISOString(),
          causedByCommandId: command.commandId,
          type: "session.state.updated",
          state: snapshot.state,
        }
        await publish([resolved, updated])
        return {
          revision: snapshot.revision,
          seq: snapshot.seq,
          events: [resolved, updated],
        }
      }

      const dispatch = async (
        command: SessionCommand,
        _options?: SessionDispatchOptions,
      ): Promise<SessionDispatchResult> => {
        switch (command.type) {
          case "input.append":
            return await handleInputAppend(command)
          case "turn.run":
            return await handleTurnRun(command)
          case "approval.respond":
            return await handleApprovalRespond(command)
          default:
            return { revision: snapshot.revision, seq: snapshot.seq, events: [] }
        }
      }

      const ensureTransportBridge = (
        replayWindow?: number,
      ): ReturnType<typeof createSessionTransportBridge> => {
        if (transportBridge !== undefined) return transportBridge
        transportBridge = createSessionTransportBridge({
          snapshot,
          ...(replayWindow !== undefined ? { tailLimit: replayWindow } : {}),
          onCommand: async (command) => {
            transportDispatchQueue = transportDispatchQueue.then(async () => {
              await dispatch(command)
            })
            await transportDispatchQueue
          },
        })
        return transportBridge
      }

      const session: RuntimeSession = {
        sessionId,
        dispatch,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        snapshot: async () => snapshot,
        attachSessionTransport: async (
          transport: SessionTransport,
          options: { readonly replayWindow?: number } = {},
        ): Promise<ConnectedSessionTransport> => {
          bag.attachTransportCalls += 1
          bag.lastAttachReplayWindow = options.replayWindow
          return await ensureTransportBridge(options.replayWindow).connect(transport)
        },
        close: async () => {
          if (sessionClosed) return
          sessionClosed = true
          bag.sessionsClosed += 1
          listeners.clear()
          await transportBridge?.close()
        },
        input: {
          append: async (text, meta, options) =>
            await dispatch(
              {
                sessionId,
                type: "input.append",
                text,
                commandId: meta?.commandId ?? crypto.randomUUID(),
                issuedAt: meta?.issuedAt ?? new Date().toISOString(),
                ...(meta?.expectedRevision !== undefined
                  ? { expectedRevision: meta.expectedRevision }
                  : {}),
                ...(meta?.images !== undefined && meta.images.length > 0
                  ? { images: meta.images }
                  : {}),
              },
              options,
            ),
        },
        turn: {
          run: async (meta, options) =>
            await dispatch(
              {
                sessionId,
                type: "turn.run",
                commandId: meta?.commandId ?? crypto.randomUUID(),
                issuedAt: meta?.issuedAt ?? new Date().toISOString(),
                ...(meta?.expectedRevision !== undefined
                  ? { expectedRevision: meta.expectedRevision }
                  : {}),
              },
              options,
            ),
          // S1 (jul-16 ticket 01) — RuntimeSession gained the `turn.cancel`
          // verb (the one sanctioned additive surface change); the fake mirrors
          // the same dispatch delegation shape.
          cancel: async (meta, options) =>
            await dispatch(
              {
                sessionId,
                type: "turn.cancel",
                commandId: meta?.commandId ?? crypto.randomUUID(),
                issuedAt: meta?.issuedAt ?? new Date().toISOString(),
                ...(meta?.expectedRevision !== undefined
                  ? { expectedRevision: meta.expectedRevision }
                  : {}),
              },
              options,
            ),
        },
        identity: {
          set: async () => ({ revision: snapshot.revision, seq: snapshot.seq, events: [] }),
        },
        toolProfile: {
          set: async () => ({ revision: snapshot.revision, seq: snapshot.seq, events: [] }),
        },
        permission: {
          set: async () => ({ revision: snapshot.revision, seq: snapshot.seq, events: [] }),
        },
        approval: {
          respond: async (approvalId, decision, meta, options) =>
            await dispatch(
              {
                ...meta,
                sessionId,
                type: "approval.respond",
                approvalId,
                decision,
                commandId: meta?.commandId ?? crypto.randomUUID(),
                issuedAt: meta?.issuedAt ?? new Date().toISOString(),
              },
              options,
            ),
        },
        transcript: {
          replace: async () => ({ revision: snapshot.revision, seq: snapshot.seq, events: [] }),
          // Pre-existing CI-only tsc red (bun test does not typecheck): the fake
          // never grew the P1 Phase-0 `messages()` read — inert empty read here.
          messages: () => [],
        },
        side: {
          start: async () => ({
            outcome: {
              messages: [],
              reason: "stop",
              turns: 0,
              tokens: { input: 0, output: 0 },
            } as unknown as Awaited<ReturnType<RuntimeSession["side"]["start"]>>["outcome"],
            answerText: "",
            inputTokens: 0,
            outputTokens: 0,
            toolsAvailable: 0,
          }),
        },
      }
      externalEmit = (event: SessionEvent): void => {
        emitEvent(listeners, event)
        void transportBridge?.publishEvents([event])
      }
      bag.lastSession = session
      return session
    },
    close: async () => {
      bag.runtimeClosed = true
      await bag.lastSession?.close()
    },
  })
  const emit = (event: SessionEvent): void => externalEmit(event)
  return { factory, bag, emit }
}
