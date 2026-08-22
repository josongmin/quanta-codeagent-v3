import type { SessionHost } from "@/kernel/session"
import {
  createKernelSessionState,
  isDurableSessionEventLog,
  type KernelDispatchContext,
  toSessionSnapshotLite,
} from "@/kernel/session"
import type { Message } from "@/llm"
import {
  buildApprovalRespond,
  buildIdentitySet,
  buildInputAppend,
  buildPermissionSet,
  buildToolProfileSet,
  buildTranscriptReplace,
  buildTurnCancel,
  buildTurnRun,
  type CommandBuildDeps,
  SessionClosedError,
} from "@/protocol/session"
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
  /** RFC01-4 A1 — cold-start rehydrate INJECTION. When the runtime resumes a
   *  durable session (`runtime.ts` `createSession` sees `durableLog.tip() > 0`),
   *  it loads the lossless `SavedSession` snapshot via `loadSessionById`,
   *  validates it fail-closed (`./session/rehydrate`), and passes the full
   *  transcript here. `createdState` is then seeded with these messages instead
   *  of the empty-transcript default — the resumed conversation is restored.
   *  ABSENT (in-memory log / no durable tip) ⇒ undefined ⇒ the empty-transcript
   *  cold start, byte-identical to the pre-feature runtime. This owner NEVER
   *  folds `SessionEvent`s (the confirmed-correction DROP); the SavedSession is
   *  the SOLE durable transcript authority. */
  readonly rehydratedMessages?: readonly Message[]
}

export const createRuntimeSession = (args: CreateRuntimeSessionArgs): RuntimeSession => {
  const hostDescription = args.hostSession.describe()
  const subscriptions = new SessionSubscriptionHub()
  // W4-b seq-continuity seam (ADR-0540 W2 item 0). A DURABLE event log exposes
  // `tip()` — the max seq already persisted for this session. Resume issuance
  // FROM that tip (the kernel mints every event as `state.seq + n`), so
  // post-restart events extend the log monotonically instead of re-issuing
  // from 0 — without this, wire `connect({resume})` semantics are undefined
  // (a client's resumeFromSeq high-water mark would forever sit "ahead" of the
  // fresh kernel; see planSessionReplay's ahead-of-tip guard in
  // `@/ipc/session/bridge`). The in-memory log exposes no tip ⇒ the created
  // state passes through UNTOUCHED (historical seq:0 — default-OFF
  // byte-identical). `revision` deliberately does NOT resume here: revision
  // continuity is the W4-a / ticket-05 rehydrate decision, not the log's.
  const durableLog = isDurableSessionEventLog(args.kernel.eventLog)
    ? args.kernel.eventLog
    : undefined
  // RFC01-4 A1 — when the caller injected a rehydrated transcript (durable
  // resume; validated fail-closed upstream in `runtime.ts`), seed the created
  // state with it as the AUTHORITATIVE transcript. Absent ⇒ the host
  // description's transcript (usually empty), preserving the pre-feature
  // empty-transcript cold start byte-identically.
  const createdState =
    args.rehydratedMessages !== undefined
      ? createKernelSessionState({ ...hostDescription, messages: args.rehydratedMessages })
      : createKernelSessionState(hostDescription)
  const durableTip = durableLog?.tip() ?? 0
  const initialState = durableTip > 0 ? { ...createdState, seq: durableTip } : createdState
  const sessionId = initialState.sessionId

  // Mutable session state, boxed so the engine helpers (see ./session/engine.ts)
  // can mutate it in place by reference — preserving the original closure-over-
  // `let` semantics of the inline body.
  const box: SessionRuntimeState = {
    closed: false,
    state: initialState,
    transportBridge: undefined,
    transportDispatchQueue: Promise.resolve(),
    activeDispatch: Promise.resolve(),
  }
  const engine: SessionEngineDeps = {
    box,
    sessionId,
    subscriptions,
    hostSession: args.hostSession,
    kernel: args.kernel,
  }

  // Pure command-builders (protocol-slice SSOT, `@/protocol/session/builders`)
  // depend only on the immutable session identity + clock, so bind once and
  // delegate. The kernel clock satisfies the protocol's structural clock type.
  const commandDeps: CommandBuildDeps = { sessionId, clock: args.kernel.clock }

  return {
    sessionId,
    dispatch: (command, options) => dispatch(engine, command, options),
    subscribe: (listener) => subscriptions.subscribe(listener),
    snapshot: async () => toSessionSnapshotLite(box.state),
    attachSessionTransport: (transport, options) =>
      attachSessionTransport(engine, transport, options),
    close: async () => {
      // Terminal `session.closed` is appended by closeSession FIRST; only then
      // release the durable log's fd + single-writer lock (W4-b lifecycle —
      // the runtime session owns its injected log). `finally` so a throwing
      // host close can never leak the lock. No-op for the in-memory log
      // (`durableLog` undefined ⇒ identical to the historical close path).
      try {
        await closeSession(engine)
      } finally {
        durableLog?.close()
      }
    },
    input: {
      append: async (text, meta, options) =>
        dispatch(engine, buildInputAppend(commandDeps, text, meta), options),
    },
    turn: {
      run: async (meta, options) => dispatch(engine, buildTurnRun(commandDeps, meta), options),
      // S1 (jul-16 ticket 01, S0-2 ruling) — the ONE sanctioned RuntimeSession
      // surface addition: `turn.cancel` existed in the protocol's command union
      // (and the kernel reducer/scheduler) all along, but had no typed verb —
      // pure dispatch delegation, exactly like its siblings.
      cancel: async (meta, options) =>
        dispatch(engine, buildTurnCancel(commandDeps, meta), options),
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
      // P1 Phase 0 — lossless read symmetric to `replace` (see types.ts).
      messages: () => [...box.state.messages],
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
