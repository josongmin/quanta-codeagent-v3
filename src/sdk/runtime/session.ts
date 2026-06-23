import type { SessionHost } from "@/kernel/session"
import {
  createKernelSessionState,
  type KernelDispatchContext,
  toSessionSnapshotLite,
} from "@/kernel/session"
import { SessionClosedError } from "@/protocol/session"
import {
  buildApprovalRespond,
  buildIdentitySet,
  buildInputAppend,
  buildPermissionSet,
  buildToolProfileSet,
  buildTranscriptReplace,
  buildTurnRun,
  type CommandBuildDeps,
} from "./session/commands"
import {
  attachSessionTransport,
  closeSession,
  dispatch,
  type SessionEngineDeps,
  type SessionRuntimeState,
} from "./session/engine"
import { SessionSubscriptionHub } from "./subscription"
import type { RuntimeSession } from "./types"

interface CreateRuntimeSessionArgs {
  readonly hostSession: SessionHost
  readonly kernel: Pick<KernelDispatchContext, "clock" | "eventLog">
}

export const createRuntimeSession = (args: CreateRuntimeSessionArgs): RuntimeSession => {
  const hostDescription = args.hostSession.describe()
  const subscriptions = new SessionSubscriptionHub()
  const initialState = createKernelSessionState(hostDescription)
  const sessionId = initialState.sessionId

  // Mutable session state, boxed so the engine helpers (see ./session/engine.ts)
  // can mutate it in place by reference — preserving the original closure-over-
  // `let` semantics of the inline body.
  const box: SessionRuntimeState = {
    closed: false,
    state: initialState,
    transportBridge: undefined,
    transportDispatchQueue: Promise.resolve(),
  }
  const engine: SessionEngineDeps = {
    box,
    sessionId,
    subscriptions,
    hostSession: args.hostSession,
    kernel: args.kernel,
  }

  // Pure command-builders (see ./session/commands.ts) depend only on the
  // immutable session identity + clock, so bind those once and delegate.
  const commandDeps: CommandBuildDeps = { sessionId, clock: args.kernel.clock }

  return {
    sessionId,
    dispatch: (command, options) => dispatch(engine, command, options),
    subscribe: (listener) => subscriptions.subscribe(listener),
    snapshot: async () => toSessionSnapshotLite(box.state),
    attachSessionTransport: (transport, options) =>
      attachSessionTransport(engine, transport, options),
    close: () => closeSession(engine),
    input: {
      append: async (text, meta, options) =>
        dispatch(engine, buildInputAppend(commandDeps, text, meta), options),
    },
    turn: {
      run: async (meta, options) => dispatch(engine, buildTurnRun(commandDeps, meta), options),
    },
    identity: {
      set: async (mode, meta, options) =>
        dispatch(engine, buildIdentitySet(commandDeps, mode, meta), options),
    },
    permission: {
      set: async (mode, meta, options) =>
        dispatch(engine, buildPermissionSet(commandDeps, mode, meta), options),
    },
    toolProfile: {
      set: async (profile, meta, options) =>
        dispatch(engine, buildToolProfileSet(commandDeps, profile, meta), options),
    },
    approval: {
      respond: async (approvalId, decision, meta, options) =>
        dispatch(engine, buildApprovalRespond(commandDeps, approvalId, decision, meta), options),
    },
    transcript: {
      replace: async (messages, meta, options) =>
        dispatch(engine, buildTranscriptReplace(commandDeps, messages, meta), options),
    },
    side: {
      start: async (sideArgs, _options) => {
        if (box.closed) throw new SessionClosedError(sessionId)
        if (args.hostSession.startSideConversation === undefined) {
          throw new Error("side conversation is not supported by this runtime session host")
        }
        return await args.hostSession.startSideConversation({
          ...sideArgs,
          messages: [...box.state.messages],
        })
      },
    },
  }
}
