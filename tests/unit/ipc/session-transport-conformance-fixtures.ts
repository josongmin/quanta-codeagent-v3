import { z } from "zod"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import {
  type CreateSessionTransportClientOpts,
  createSessionHandle,
  createSessionStdioClient,
  createSessionStdioServer,
  createSessionTransportBridge,
  createSessionTransportClient,
  createSessionWebSocketClient,
  createSessionWebSocketServer,
  runSessionHandshake,
  type SessionHandle,
  type SessionTransport,
  type SessionTransportBridge,
  type SessionTransportClient,
  type SessionTransportMessage,
  type SessionTransportServer,
  type SessionTurnEndEvent,
} from "@/ipc/session"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext, ToolAction } from "@/permission"
import type {
  CommandReceipt,
  SessionCommand,
  SessionEvent,
  SessionSnapshotLite,
} from "@/protocol/session"
import { createRuntimeFromAgentConfigBase, type RuntimeSession } from "@/sdk/runtime"
import { toSessionHandle } from "@/sdk/runtime/handle-adapter"
import { StdoutStream } from "@/stream"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"
import { capabilitiesFor, makeSnapshotLite } from "../../support/session-fixtures"

export type TransportKind = "stdio" | "websocket"

/** The transport-conformance manifest — the historical shape of this suite
 *  (operator approvals + tools + artifacts). SSOT-derived via the shared
 *  fixture; only the transport varies per column. */
const conformanceCapabilities = (transport: TransportKind) =>
  capabilitiesFor({ approvals: "operator", tools: true, artifacts: true, transport })

export const makeSnapshot = (
  transport: TransportKind,
  overrides: Partial<SessionSnapshotLite> = {},
): SessionSnapshotLite =>
  makeSnapshotLite({
    ...overrides,
    capabilities: { ...conformanceCapabilities(transport), ...(overrides.capabilities ?? {}) },
  })

export const makeStateUpdatedEvent = (
  overrides: Partial<Extract<SessionEvent, { type: "session.state.updated" }>> = {},
): Extract<SessionEvent, { type: "session.state.updated" }> => ({
  eventId: "event-1",
  seq: 2,
  revision: 2,
  emittedAt: "2026-05-26T00:00:00.000Z",
  type: "session.state.updated",
  state: {
    status: "idle",
    draftInput: "",
    permissionMode: "default",
    messageCount: 0,
  },
  ...overrides,
})

export const makeCommand = (
  overrides: Partial<Extract<SessionCommand, { type: "turn.run" }>> = {},
): Extract<SessionCommand, { type: "turn.run" }> => ({
  sessionId: "session-1",
  commandId: "command-1",
  issuedAt: "2026-05-26T00:00:00.000Z",
  type: "turn.run",
  ...overrides,
})

const createStdioEndpoint = (
  setReaderHandler: (handler: ((chunk: Buffer | string) => void) | undefined) => void,
  readHandler: () => ((chunk: Buffer | string) => void) | undefined,
) => ({
  reader: {
    on(event: "data", handler: (chunk: Buffer | string) => void) {
      if (event === "data") {
        setReaderHandler(handler)
      }
    },
    off(event: "data", handler: (chunk: Buffer | string) => void) {
      if (event === "data" && readHandler() === handler) {
        setReaderHandler(undefined)
      }
    },
  },
  writer: {
    write(chunk: string) {
      readHandler()?.(chunk)
      return true
    },
  },
})

const createStdioDuplexPair = () => {
  let clientReaderHandler: ((chunk: Buffer | string) => void) | undefined
  let serverReaderHandler: ((chunk: Buffer | string) => void) | undefined
  return {
    client: createStdioEndpoint(
      (handler) => {
        clientReaderHandler = handler
      },
      () => serverReaderHandler,
    ),
    server: createStdioEndpoint(
      (handler) => {
        serverReaderHandler = handler
      },
      () => clientReaderHandler,
    ),
  }
}

type MessageListener = (event: { data: unknown }) => void

const createSocketEndpoint = (
  listeners: Set<MessageListener>,
  remoteListeners: Set<MessageListener>,
) => {
  let closed = false
  return {
    send(data: string) {
      if (closed) return
      for (const handler of [...remoteListeners]) {
        handler({ data })
      }
    },
    close() {
      closed = true
    },
    addEventListener(type: "message", handler: MessageListener) {
      if (type === "message" && !closed) {
        listeners.add(handler)
      }
    },
    removeEventListener(type: "message", handler: MessageListener) {
      if (type === "message") {
        listeners.delete(handler)
      }
    },
  }
}

const createWebSocketPair = () => {
  const clientListeners = new Set<MessageListener>()
  const serverListeners = new Set<MessageListener>()
  return {
    client: createSocketEndpoint(clientListeners, serverListeners),
    server: createSocketEndpoint(serverListeners, clientListeners),
  }
}

export const createHarness = async (args: {
  readonly kind: TransportKind
  readonly bridge: SessionTransportBridge
  readonly sessionId?: string
  readonly resumeFromSeq?: number
  /** S5 — typed `rejected` surfacing (additive; absent ⇒ prior behavior). */
  readonly onRejected?: CreateSessionTransportClientOpts["onRejected"]
}): Promise<{
  readonly client: SessionTransportClient
  readonly server: SessionTransportServer
  readonly close: () => Promise<void>
}> => {
  if (args.kind === "stdio") {
    const pair = createStdioDuplexPair()
    const client = createSessionStdioClient({
      reader: pair.client.reader,
      writer: pair.client.writer,
      sessionId: args.sessionId ?? "session-1",
      ...(args.resumeFromSeq !== undefined ? { resumeFromSeq: args.resumeFromSeq } : {}),
      ...(args.onRejected !== undefined ? { onRejected: args.onRejected } : {}),
    })
    const server = await createSessionStdioServer({
      reader: pair.server.reader,
      writer: pair.server.writer,
      bridge: args.bridge,
    })
    return {
      client,
      server,
      close: async () => {
        await client.close()
        await server.close()
      },
    }
  }

  const pair = createWebSocketPair()
  const client = createSessionWebSocketClient({
    socket: pair.client,
    sessionId: args.sessionId ?? "session-1",
    ...(args.resumeFromSeq !== undefined ? { resumeFromSeq: args.resumeFromSeq } : {}),
    ...(args.onRejected !== undefined ? { onRejected: args.onRejected } : {}),
  })
  const server = await createSessionWebSocketServer({
    socket: pair.server,
    bridge: args.bridge,
  })
  return {
    client,
    server,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

export const runConformanceTranscript = async (kind: TransportKind) => {
  const accepted: string[] = []
  const snapshot = makeSnapshot(kind, { revision: 5, seq: 10 })
  const bridge = createSessionTransportBridge({
    snapshot,
    onCommand: async (command) => {
      accepted.push(command.commandId)
    },
  })
  const harness = await createHarness({ kind, bridge })
  const seen: SessionTransportMessage[] = []
  harness.client.onMessage((message) => {
    seen.push(message)
  })
  await harness.client.connect()

  const command = makeCommand({
    commandId: `${kind}-command`,
    expectedRevision: 5,
  })
  await harness.client.sendCommand(command)

  const event11 = makeStateUpdatedEvent({
    eventId: `${kind}-event-11`,
    seq: 11,
    revision: 6,
    causedByCommandId: command.commandId,
    state: {
      status: "running",
      draftInput: "hello",
      permissionMode: "default",
      messageCount: 1,
    },
  })
  const event12 = makeStateUpdatedEvent({
    eventId: `${kind}-event-12`,
    seq: 12,
    revision: 6,
    causedByCommandId: command.commandId,
    state: {
      status: "idle",
      draftInput: "",
      permissionMode: "default",
      messageCount: 2,
    },
  })
  await bridge.publishEvents([event11, event12])

  return {
    accepted,
    bridge,
    command,
    snapshot,
    seen,
    harness,
    events: [event11, event12] as const,
  }
}

export const runRevisionConflictFlow = async (kind: TransportKind) => {
  const snapshot = makeSnapshot(kind, { revision: 5, seq: 10 })
  const bridge = createSessionTransportBridge({ snapshot })
  const harness = await createHarness({ kind, bridge })
  const seen: SessionTransportMessage[] = []
  harness.client.onMessage((message) => {
    seen.push(message)
  })
  await harness.client.connect()
  seen.length = 0

  const liveTailEvent = makeStateUpdatedEvent({
    eventId: `${kind}-live-tail`,
    seq: 11,
    revision: 6,
    causedByCommandId: "other-command",
  })
  await bridge.publishEvents([liveTailEvent])
  seen.length = 0

  await harness.client.sendCommand(
    makeCommand({
      commandId: `${kind}-stale-command`,
      expectedRevision: 5,
    }),
  )

  return {
    bridge,
    harness,
    liveTailEvent,
    seen,
    snapshot,
  }
}

export const runReconnectFlow = async (kind: TransportKind) => {
  const snapshot = makeSnapshot(kind, { revision: 5, seq: 10 })
  const bridge = createSessionTransportBridge({
    snapshot,
    tailLimit: 4,
  })

  const first = await createHarness({ kind, bridge })
  const firstSeen: SessionTransportMessage[] = []
  first.client.onMessage((message) => {
    firstSeen.push(message)
  })
  await first.client.connect()

  const event11 = makeStateUpdatedEvent({
    eventId: `${kind}-event-11`,
    seq: 11,
    revision: 6,
  })
  const event12 = makeStateUpdatedEvent({
    eventId: `${kind}-event-12`,
    seq: 12,
    revision: 6,
  })
  await bridge.publishEvents([event11, event12])
  const resumeFromSeq = first.client.currentResumeFromSeq()
  await first.close()

  const event13 = makeStateUpdatedEvent({
    eventId: `${kind}-event-13`,
    seq: 13,
    revision: 7,
  })
  await bridge.publishEvents([event13])

  const second = await createHarness({
    kind,
    bridge,
    ...(resumeFromSeq !== undefined ? { resumeFromSeq } : {}),
  })
  const secondSeen: SessionTransportMessage[] = []
  second.client.onMessage((message) => {
    secondSeen.push(message)
  })
  await second.client.connect()

  return {
    bridge,
    firstSeen,
    second,
    secondSeen,
    events: [event11, event12, event13] as const,
    resumeFromSeq,
    snapshot,
  }
}

export const runDuplicateCommandFlow = async (kind: TransportKind) => {
  const accepted: string[] = []
  const bridge = createSessionTransportBridge({
    snapshot: makeSnapshot(kind, { revision: 5, seq: 10 }),
    onCommand: async (command) => {
      accepted.push(command.commandId)
    },
  })
  const harness = await createHarness({ kind, bridge })
  const seen: SessionTransportMessage[] = []
  harness.client.onMessage((message) => {
    seen.push(message)
  })
  await harness.client.connect()
  seen.length = 0

  const command = makeCommand({
    commandId: `${kind}-dup-command`,
    expectedRevision: 5,
  })
  await harness.client.sendCommand(command)

  const appliedEvent = makeStateUpdatedEvent({
    eventId: `${kind}-dup-event`,
    seq: 11,
    revision: 6,
    causedByCommandId: command.commandId,
  })
  await bridge.publishEvents([appliedEvent])
  seen.length = 0

  await harness.client.sendCommand(command)

  return {
    accepted,
    appliedEvent,
    bridge,
    command,
    harness,
    seen,
  }
}

/* ------------------------------------------------------------------------- */
/* S6 (jul-16 SDK ticket 01) — HANDLE-LEVEL conformance columns               */
/*                                                                            */
/* Same command script, two doors, one oracle:                                */
/*   · ORACLE column — `toSessionHandle(realRuntimeSession)` (in-process       */
/*     adapter, internal-only) over a REAL runtime (ScriptedLLM + live         */
/*     kernel dispatch);                                                       */
/*   · WIRE column — the SAME runtime published through                        */
/*     `attachSessionTransport` + in-memory duplex pair, consumed through the  */
/*     PRODUCTION connect internals (runSessionHandshake → transport client    */
/*     → createSessionHandle).                                                 */
/* The event streams each handle observes must be EQUAL under the sealed       */
/* normalization contract below.                                               */
/* ------------------------------------------------------------------------- */

/**
 * ── SEALED NORMALIZATION CONTRACT (closed — read before touching) ──────────
 *
 * Exactly THREE classes of server-minted non-determinism are normalized, and
 * the concrete field list is CLOSED (designed up front with the contract, not
 * discovered by chasing green):
 *
 *   1. minted identifiers  — `eventId` (uuid per event), `approvalId`
 *      (uuid per approval; remapped to a STABLE ordinal token so the
 *      requested/resolved JOIN is still asserted);
 *   2. clock stamps        — `emittedAt`, `approval.requestedAt`, and
 *      `tool.completed.durationMs` (a wall-clock STOPWATCH — the same clock
 *      class; asserting equality of a stopwatch asserts flakiness);
 *   3. seq                 — remapped to the per-stream ordinal AFTER a
 *      strict-monotonicity guard (ordering itself stays load-bearing).
 *
 * EVERYTHING ELSE — event types, their ORDER, `revision`,
 * `causedByCommandId` (the script pins commandIds), prompts, state views,
 * outcome reasons, decisions, tool names/previews — must be BYTE-EQUAL.
 *
 * Snapshot frames are NOT events and are asserted as a "다름이 정답"
 * (difference-is-correct) item: the wire door receives ≥1 snapshot frame
 * (the handshake's state carrier), the in-process oracle receives ZERO
 * (its `snapshot()` is a live read). Same for `session.created`: an
 * in-process synthetic that never rides the wire — NEITHER stream may
 * contain it here (the oracle column performs no transport attach).
 *
 * ⛔ Adding a field to this list to make a failing diff pass is a RED
 * finding, not a fix (MASTER §3.4 "conformance vacuity") — investigate the
 * divergence instead.
 */
export interface NormalizedHandleEvent {
  readonly [key: string]: unknown
}

export const normalizeHandleEvents = (events: readonly SessionEvent[]): NormalizedHandleEvent[] => {
  // Guard FIRST: seq must be strictly increasing before it may be remapped.
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1]
    const curr = events[i]
    if (prev !== undefined && curr !== undefined && !(curr.seq > prev.seq)) {
      throw new Error(
        `handle conformance: non-monotonic seq at index ${i} (${prev.seq} → ${curr.seq})`,
      )
    }
  }
  const approvalTokens = new Map<string, string>()
  const approvalToken = (approvalId: string): string => {
    const prior = approvalTokens.get(approvalId)
    if (prior !== undefined) return prior
    const token = `approval#${approvalTokens.size + 1}`
    approvalTokens.set(approvalId, token)
    return token
  }
  return events.map((event, index) => {
    const clone = JSON.parse(JSON.stringify(event)) as Record<string, unknown>
    clone.eventId = `event#${index + 1}`
    clone.emittedAt = "<clock>"
    clone.seq = index + 1
    if (event.type === "approval.requested") {
      const approval = clone.approval as Record<string, unknown>
      approval.approvalId = approvalToken(event.approval.approvalId)
      approval.requestedAt = "<clock>"
    }
    if (event.type === "approval.resolved") {
      clone.approvalId = approvalToken(event.approvalId)
    }
    if (event.type === "tool.completed" && "durationMs" in clone) {
      // L-1 (jul-16 audit): REPLACE, never delete — deletion would also mask
      // an existence mismatch (one door stamping the stopwatch, the other
      // not). The placeholder keeps presence-parity load-bearing while
      // normalizing the wall-clock VALUE (class 2 of the sealed contract).
      clone.durationMs = "<clock>"
    }
    return clone as NormalizedHandleEvent
  })
}

/** Scripted LLM (shared by both columns — same class ⇒ same modelSlug). */
class ConformanceScriptedLLM implements LLMPort {
  readonly model = "stub-handle-conformance"
  private readonly scripts: StreamEvent[][]
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    for (const ev of this.scripts.shift() ?? [{ type: "message_stop", stop_reason: "end_turn" }])
      yield ev
  }
}

export const conformanceEndTextScript: StreamEvent[] = [
  { type: "text_delta", delta: "done" },
  { type: "message_stop", stop_reason: "end_turn" },
]

export const conformanceCallToolScript = (id: string): StreamEvent[] => [
  { type: "tool_use_start", id, name: "danger" },
  { type: "tool_use_end", id, input: {} },
  { type: "message_stop", stop_reason: "tool_use" },
]

const conformanceMutatingTool = (counts: { n: number }): Tool => ({
  name: "danger",
  description: "danger",
  inputSchema: z.object({}).passthrough(),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  hitlTier: () => "pre-approval-ok",
  async *execute(): AsyncIterable<ToolEvent> {
    counts.n += 1
    yield { type: "result", result: { ok: true, output: "ran" } }
  },
})

const conformanceLiveProxy = (): PermissionContext => {
  let m: PermissionContext["mode"] = "default"
  return {
    get mode() {
      return m
    },
    set mode(next) {
      m = next
    },
  }
}

const buildConformanceRuntime = async (args: {
  readonly scripts: StreamEvent[][]
  readonly counts: { n: number }
}) => {
  const abort = new AbortController()
  // The surface confirm slot the approval protocol DISPLACES inside
  // `runWithProtocol` (the web/CLI comp-root rail) — the throwing default
  // exposes any accidental inline-confirm path. The `action` passthrough is
  // LOAD-BEARING: the protocol's installed handler reads the action.
  const confirmSlot = {
    current: async (_action: ToolAction): Promise<boolean> => {
      throw new Error("surface onConfirm must not be reached under the approval protocol")
    },
  }
  const base = {
    llm: new ConformanceScriptedLLM(args.scripts),
    registry: new ToolRegistry([conformanceMutatingTool(args.counts)]),
    stream: new StdoutStream(),
    permission: conformanceLiveProxy(),
    messages: [],
    system: "system",
    cwd: "/tmp/quanta-handle-conformance",
    maxTurns: 6,
    signal: abort.signal,
    hitl: { enabled: true },
    onConfirm: async (action: ToolAction) => confirmSlot.current(action),
    approvalProtocol: { confirmSlot },
  }
  const { runtime } = await createRuntimeFromAgentConfigBase({
    base: base as Parameters<typeof createRuntimeFromAgentConfigBase>[0]["base"],
    turnAssembler: buildInteractiveTurnAssembler(),
    history: [],
    state: undefined,
    idMeta: undefined,
    shutdown: async () => undefined,
  })
  return runtime
}

export interface HandleConformanceColumn {
  readonly handle: SessionHandle
  readonly session: RuntimeSession
  readonly events: SessionEvent[]
  /** Wire door: snapshot FRAMES received (oracle: always 0 — see contract). */
  readonly snapshotFrames: SessionSnapshotLite[]
  teardown(): Promise<void>
}

/** ORACLE column — the in-process adapter over a real RuntimeSession. */
export const createOracleHandleColumn = async (args: {
  readonly scripts: StreamEvent[][]
  readonly counts: { n: number }
}): Promise<HandleConformanceColumn> => {
  const runtime = await buildConformanceRuntime(args)
  const session = await runtime.createSession({
    cwd: "/tmp/quanta-handle-conformance",
    permissionMode: "default",
  })
  const handle = toSessionHandle(session)
  const events: SessionEvent[] = []
  handle.subscribe((event) => {
    events.push(event)
  })
  return {
    handle,
    session,
    events,
    snapshotFrames: [],
    async teardown() {
      await handle.close()
      await session.close()
      await runtime.close()
    },
  }
}

/** In-memory duplex transport pair — `send` AWAITS the remote handlers, so a
 *  command send observes the full bridge dispatch (deterministic sequencing). */
export const createDuplexTransportPair = (): {
  client: SessionTransport
  server: SessionTransport
} => {
  const clientHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const serverHandlers = new Set<(m: SessionTransportMessage) => void | Promise<void>>()
  const build = (
    local: Set<(m: SessionTransportMessage) => void | Promise<void>>,
    remote: Set<(m: SessionTransportMessage) => void | Promise<void>>,
  ): SessionTransport => ({
    async send(message) {
      for (const handler of [...remote]) await handler(message)
    },
    onMessage(handler) {
      local.add(handler)
      return () => {
        local.delete(handler)
      }
    },
    async close() {
      local.clear()
    },
  })
  return {
    client: build(clientHandlers, serverHandlers),
    server: build(serverHandlers, clientHandlers),
  }
}

/** WIRE column — the SAME runtime shape published over the transport bridge,
 *  consumed through the production connect() internals (handshake → client →
 *  handle). */
export const createWireHandleColumn = async (args: {
  readonly scripts: StreamEvent[][]
  readonly counts: { n: number }
}): Promise<HandleConformanceColumn> => {
  const runtime = await buildConformanceRuntime(args)
  const session = await runtime.createSession({
    cwd: "/tmp/quanta-handle-conformance",
    permissionMode: "default",
  })
  const pair = createDuplexTransportPair()
  await session.attachSessionTransport(pair.server)

  const handshake = runSessionHandshake({ transport: pair.client })
  await handshake.ready
  const handover = handshake.handoff()
  const client = createSessionTransportClient({
    transport: pair.client,
    sessionId: handover.sessionId,
    resumeFromSeq: handover.lastSeq,
  })
  const handle = createSessionHandle(client, {
    initialSnapshot: handover.snapshot,
    replayEvents: handover.events,
  })

  const events: SessionEvent[] = []
  handle.subscribe((event) => {
    events.push(event)
  })
  const snapshotFrames: SessionSnapshotLite[] = [handover.snapshot]
  client.onMessage((message) => {
    if (message.kind === "snapshot") snapshotFrames.push(message.snapshot)
  })
  return {
    handle,
    session,
    events,
    snapshotFrames,
    async teardown() {
      await handle.close()
      await session.close()
      await runtime.close()
    },
  }
}

export interface HandleScenarioRun {
  readonly receipts: CommandReceipt[]
  readonly turnEnd: SessionTurnEndEvent
  readonly events: SessionEvent[]
  readonly snapshotFrames: SessionSnapshotLite[]
}

/** Scenario 1 — plain turn: posture verbs + append + run, no tools. The
 *  commandIds/issuedAt are PINNED so `causedByCommandId` is comparable
 *  cross-column without widening the normalization contract. */
export const runPlainTurnHandleScenario = async (
  column: HandleConformanceColumn,
): Promise<HandleScenarioRun> => {
  const at = "2026-07-16T00:00:00.000Z"
  const receipts: CommandReceipt[] = []
  receipts.push(
    await column.handle.identity.set("focused", { commandId: "cmd-identity", issuedAt: at }),
  )
  receipts.push(
    await column.handle.permission.set("acceptEdits", {
      commandId: "cmd-permission",
      issuedAt: at,
    }),
  )
  receipts.push(
    await column.handle.input.append("hello world", { commandId: "cmd-append", issuedAt: at }),
  )
  receipts.push(await column.handle.turn.run({ commandId: "cmd-run", issuedAt: at }))
  const turnEnd = await column.handle.awaitTurnEnd()
  return {
    receipts,
    turnEnd,
    events: [...column.events],
    snapshotFrames: [...column.snapshotFrames],
  }
}

/** Scenario 2 — approval succession (§3.2): a gated mutating tool suspends
 *  the turn; the script responds APPROVE and explicitly re-runs (the
 *  client-owned continuation with a PINNED commandId), then awaits the end. */
export const runApprovalTurnHandleScenario = async (
  column: HandleConformanceColumn,
): Promise<HandleScenarioRun> => {
  const at = "2026-07-16T00:00:00.000Z"
  const receipts: CommandReceipt[] = []
  receipts.push(
    await column.handle.input.append("do the dangerous thing", {
      commandId: "cmd-append",
      issuedAt: at,
    }),
  )
  receipts.push(await column.handle.turn.run({ commandId: "cmd-run-1", issuedAt: at }))
  // Both doors have fully observed the suspension once turn.run settled (the
  // in-proc dispatch resolves at suspension; the duplex send awaits the full
  // server dispatch) — the approval id is in the captured stream.
  const requested = column.events.find(
    (e): e is Extract<SessionEvent, { type: "approval.requested" }> =>
      e.type === "approval.requested",
  )
  if (requested === undefined) throw new Error("scenario: approval.requested never observed")
  receipts.push(
    await column.handle.approval.respond(requested.approval.approvalId, "approve", {
      commandId: "cmd-respond",
      issuedAt: at,
    }),
  )
  receipts.push(await column.handle.turn.run({ commandId: "cmd-run-2", issuedAt: at }))
  const turnEnd = await column.handle.awaitTurnEnd()
  return {
    receipts,
    turnEnd,
    events: [...column.events],
    snapshotFrames: [...column.snapshotFrames],
  }
}
