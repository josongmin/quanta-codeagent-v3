/**
 * HEADLINE e2e for SDK ticket 01 (S2c) — `connect()` + SessionHandle over a
 * REAL agent loop (jul-15 real-loop harness pattern: ScriptedLLM +
 * `buildWebRuntime` + the live kernel dispatch path), through the PUBLIC ws
 * transport door (`transports.ws` with an injected WebSocket ctor bridging an
 * in-memory duplex pair — the same seam `quanta attach` e2e uses, so every
 * frame really rides the string codec).
 *
 * Written RED-FIRST: `connect`/`transports` did not exist when this file was
 * added (hellgate discipline) — the suite failed on the missing exports.
 *
 * What it seals (ticket 01 §1/§3):
 *  - handshake: discovery sentinel → rejected(canonical id) → re-connect →
 *    snapshot (the attach flow, hoisted) — connect() resolves a live handle
 *    with the canonical sessionId + snapshot cache + non-lagging lastSeq().
 *  - verbs return `{commandId, submitted: true}` receipts (§3.1).
 *  - approval round-trip: approval.requested → onApproval (ApprovalDecision-
 *    Result SSOT) → approval.respond on the wire → and BOTH continuation
 *    regimes complete the SAME awaitTurnEnd():
 *      · marker ON (`serverAutoContinues`): the DAEMON re-issues; the client
 *        must NOT re-issue (asserted on the server-side frame tap) and the
 *        handle adopts the daemon-minted continuation (§3.2 succession).
 *      · gate OFF: the hoisted attach-flow re-issues client-side and REPORTS
 *        the new commandId into the handle's succession chain (§3.2).
 *  - awaitTurnEnd resolves the turn's terminal event; the approved tool ran
 *    exactly once (real ToolRegistry dispatch, not a stub).
 *
 * Hermetic + offline (ScriptedLLM). Synchronised on events — the only timing
 * is a bounded diagnostic race so a regression fails loud instead of hanging.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import type { ConfirmDecision } from "@/agent/confirm-decision"
import { buildInteractiveTurnAssembler } from "@/apps/web-daemon/runtime-factory"
import { setupApprovalContinuation } from "@/apps/web-daemon/server/approval-continuation"
import {
  decodeSessionTransportMessage,
  encodeSessionTransportMessage,
  type SessionHandle,
  type SessionTransport,
  type SessionTransportMessage,
} from "@/ipc/session"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext, ToolAction } from "@/permission"
import type { SessionCommand } from "@/protocol/session"
import { type ConnectWebSocketCtor, connect, transports } from "@/sdk"
import { createRuntimeFromAgentConfigBase, type RuntimeSession } from "@/sdk/runtime"
import { StdoutStream } from "@/stream"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"

/* ------------------------------------------------------------------------- */
/* Real-loop harness (the W1-B pattern from                                    */
/* tests/integration/approval-respond-mid-turn-web-daemon-e2e.test.ts)         */
/* ------------------------------------------------------------------------- */

class ScriptedLLM implements LLMPort {
  readonly model = "stub-sdk-connect"
  private readonly scripts: StreamEvent[][]
  constructor(scripts: StreamEvent[][]) {
    this.scripts = scripts
  }
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    for (const ev of this.scripts.shift() ?? [{ type: "message_stop", stop_reason: "end_turn" }])
      yield ev
  }
}

const callTool = (id: string, name = "danger"): StreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input: {} },
  { type: "message_stop", stop_reason: "tool_use" },
]
const endText: StreamEvent[] = [
  { type: "text_delta", delta: "done" },
  { type: "message_stop", stop_reason: "end_turn" },
]

const mutatingTool = (counts: { n: number }): Tool => ({
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

const liveProxy = (mode: PermissionContext["mode"] = "default"): PermissionContext => {
  let m = mode
  return {
    get mode() {
      return m
    },
    set mode(next) {
      m = next
    },
  }
}

const buildWebRuntime = async (args: {
  readonly llm: LLMPort
  readonly registry: ToolRegistry
  readonly permission: PermissionContext
  readonly serverAutoContinues?: true
}) => {
  const abort = new AbortController()
  // The `_action` parameter is part of the slot's contract: the approval
  // protocol REPLACES `current` with its arity-1 handler inside
  // `runWithProtocol`, and the `onConfirm` below passes the action through.
  const confirmSlot = {
    current: async (_action: ToolAction): Promise<boolean | ConfirmDecision> => {
      throw new Error("surface onConfirm must not be reached under the approval protocol")
    },
  }
  const base = {
    llm: args.llm,
    registry: args.registry,
    stream: new StdoutStream(),
    permission: args.permission,
    messages: [],
    system: "system",
    cwd: "/tmp/quanta-sdk-connect-e2e",
    maxTurns: 6,
    signal: abort.signal,
    hitl: { enabled: true },
    onConfirm: async (action: ToolAction) => confirmSlot.current(action),
    approvalProtocol: { confirmSlot },
    ...(args.serverAutoContinues === true ? { serverAutoContinues: true } : {}),
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

/** In-memory duplex SessionTransport pair — `send` AWAITS remote handlers so
 *  command sends observe the full bridge dispatch (deterministic, no sleeps). */
const createTransportPair = (): { client: SessionTransport; server: SessionTransport } => {
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

/**
 * The PUBLIC-door bridge: a WebSocket-shaped fake whose string frames ride the
 * REAL session.v1 codec both ways, backed by the in-memory pair's client side.
 * `transports.ws({ webSocketCtor })` consumes exactly this seam — so the e2e
 * exercises the full encode → wire → decode path, not a typed-message shortcut.
 */
type MessageListener = (event: { data: unknown }) => void
const makeFakeSocketCtor = (clientSide: SessionTransport) => {
  const sockets: Array<{ url: string }> = []
  const ctor = function (this: unknown, url: string) {
    const listeners = {
      message: [] as MessageListener[],
      open: [] as Array<() => void>,
      close: [] as Array<() => void>,
      error: [] as Array<() => void>,
    }
    let closed = false
    clientSide.onMessage((message) => {
      if (closed) return
      const data = encodeSessionTransportMessage(message)
      for (const h of [...listeners.message]) h({ data })
    })
    const socket = {
      url,
      get readyState() {
        return closed ? 3 : 1
      },
      send(data: string) {
        if (closed) return
        void clientSide.send(decodeSessionTransportMessage(data))
      },
      close() {
        closed = true
        for (const h of [...listeners.close]) h()
      },
      addEventListener(type: keyof typeof listeners, handler: never) {
        ;(listeners[type] as unknown[]).push(handler)
      },
      removeEventListener(type: keyof typeof listeners, handler: never) {
        const bucket = listeners[type] as unknown[]
        const idx = bucket.indexOf(handler)
        if (idx >= 0) bucket.splice(idx, 1)
      },
    }
    sockets.push(socket)
    return socket
  }
  // Same seam+cast the attach suites use for their fake socket ctor: a plain
  // function returning the instance object IS a constructor at runtime; the
  // structural cast is what `webSocketCtor` injection exists for.
  return { ctor: ctor as unknown as ConnectWebSocketCtor, sockets }
}

/** Bounded diagnostic race — a regression FAILS (with a label) instead of
 *  hanging the suite. Not a timing assertion: the happy path is event-driven. */
const bounded = async <T>(p: Promise<T>, label: string, ms = 10_000): Promise<T> =>
  await Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms),
    ),
  ])

/** F6 (jul-16 audit) — deterministic quiescence probe, ported from the W1-B
 *  harness (approval-respond-mid-turn e2e): a benign command CHAINS BEHIND
 *  anything the daemon (or a buggy client flow) may have enqueued on the same
 *  serial dispatch tail — once its state echo arrives, every earlier
 *  continuation has already started+settled. Run it BEFORE any negative
 *  "exactly N client frames" assertion, or queue-order races make the
 *  assertion flaky-green. (Subscribe BEFORE the send: the in-memory duplex
 *  delivers the echo inside the send await.) */
const probeQuiescent = async (handle: SessionHandle, label: string): Promise<void> => {
  const probeId = crypto.randomUUID()
  const echo = new Promise<void>((resolve) => {
    const unsub = handle.subscribe((event) => {
      if (event.type === "session.state.updated" && event.causedByCommandId === probeId) {
        unsub()
        resolve()
      }
    })
  })
  await handle.permission.set("default", { commandId: probeId })
  await bounded(echo, `quiescence probe state echo (${label})`)
}

const bootHarness = async (args: {
  readonly counts: { n: number }
  readonly env: Record<string, string | undefined>
  readonly serverAutoContinues?: true
}) => {
  const runtime = await buildWebRuntime({
    llm: new ScriptedLLM([callTool("t1"), callTool("t1b"), endText]),
    registry: new ToolRegistry([mutatingTool(args.counts)]),
    permission: liveProxy("default"),
    ...(args.serverAutoContinues === true ? { serverAutoContinues: true as const } : {}),
  })
  const session: RuntimeSession = await runtime.createSession({
    cwd: "/tmp/quanta-sdk-connect-e2e",
    permissionMode: "default",
  })
  const continuation = setupApprovalContinuation(session, args.env)
  const pair = createTransportPair()
  // Server-side frame tap: every command the CLIENT sent (for the re-issue
  // ownership assertions). Subscribed BEFORE the bridge attach so it sees all.
  const clientSentCommands: SessionCommand[] = []
  pair.server.onMessage((m) => {
    if (m.kind === "command") clientSentCommands.push(m.command)
  })
  await session.attachSessionTransport(pair.server)
  const { ctor } = makeFakeSocketCtor(pair.client)
  const teardown = async (): Promise<void> => {
    continuation.unsub?.()
    await session.close()
    await runtime.close()
  }
  return { runtime, session, pair, ctor, clientSentCommands, teardown }
}

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

/* ------------------------------------------------------------------------- */
/* The headline flows                                                          */
/* ------------------------------------------------------------------------- */

describe("connect() + SessionHandle over the real loop (SDK ticket 01 headline e2e)", () => {
  test("marker ON: connect → append → turn.run → onApproval approve → awaitTurnEnd completes via the DAEMON continuation (no client re-issue)", async () => {
    const counts = { n: 0 }
    const harness = await bootHarness({
      counts,
      env: { QUANTA_INLINE_APPROVAL_RESOLVER: "1" },
      serverAutoContinues: true,
    })

    const approvalsSeen: string[] = []
    const handle = await bounded(
      connect({
        transport: transports.ws({
          url: "ws://127.0.0.1:0/",
          webSocketCtor: harness.ctor,
        }),
        onApproval: async (approval) => {
          approvalsSeen.push(approval.approvalId)
          return "approve"
        },
      }),
      "connect() handshake",
    )
    cleanup = async () => {
      await handle.close()
      await harness.teardown()
    }

    // Handshake adopted the canonical (server-minted) id + cached the snapshot.
    expect(handle.sessionId).toBe(harness.session.sessionId)
    const snap = await handle.snapshot()
    expect(snap?.snapshot.sessionId).toBe(harness.session.sessionId)
    expect(snap?.snapshot.capabilities.serverAutoContinues).toBe(true)
    // Cursor handover is atomic — lastSeq() starts at the handshake snapshot's
    // seq (no handshake-window lag).
    expect(handle.lastSeq()).toBe(snap?.snapshot.seq)

    // Receipts are SUBMITTED receipts (§3.1): commandId + submitted:true.
    const appendReceipt = await handle.input.append("do the dangerous thing")
    expect(appendReceipt.submitted).toBe(true)
    expect(typeof appendReceipt.commandId).toBe("string")
    const runReceipt = await handle.turn.run()
    expect(runReceipt.submitted).toBe(true)

    // The approval flowed: requested → onApproval → respond → daemon re-issue
    // → terminal. awaitTurnEnd() correlates ACROSS the daemon-minted
    // continuation commandId (§3.2 succession — the marker-ON adoption arm).
    const end = await bounded(handle.awaitTurnEnd(), "awaitTurnEnd (marker ON)")
    expect(end.type).toBe("turn.completed")
    if (end.type !== "turn.completed") throw new Error("narrow")
    expect(end.outcomeReason).toBe("completed")
    expect(counts.n).toBe(1)
    expect(approvalsSeen.length).toBe(1)

    // F6 (jul-16 audit): determinize the serial dispatch queue BEFORE the
    // negative frame-count assertion below — an erroneous client re-issue
    // still in flight would otherwise be invisible to it.
    await probeQuiescent(handle, "marker ON")

    // Marker-aware client: EXACTLY ONE client-sent turn.run (the original).
    // The continuation was daemon-minted — a second client turn.run frame here
    // is the double-dispatch the marker exists to remove.
    const clientTurnRuns = harness.clientSentCommands.filter((c) => c.type === "turn.run")
    expect(clientTurnRuns.length).toBe(1)
    expect(clientTurnRuns[0]?.commandId).toBe(runReceipt.commandId)
    // And the respond rode the wire with the approval's id.
    const responds = harness.clientSentCommands.filter((c) => c.type === "approval.respond")
    expect(responds.length).toBe(1)
    if (responds[0]?.type !== "approval.respond") throw new Error("narrow")
    expect(responds[0].approvalId).toBe(approvalsSeen[0] ?? "<no approval seen>")

    // The terminal event was daemon-caused, not client-caused (ownership pin).
    expect(end.causedByCommandId).toBeDefined()
    expect(end.causedByCommandId).not.toBe(runReceipt.commandId)

    // lastSeq advanced with the live tail (manual-reconnect cursor is live).
    const lastSeq = handle.lastSeq()
    expect(lastSeq).toBeDefined()
    expect(lastSeq ?? 0).toBeGreaterThan(snap?.snapshot.seq ?? Number.MAX_SAFE_INTEGER)
  })

  test("gate OFF: the hoisted attach-flow re-issues turn.run client-side and awaitTurnEnd completes through the REPORTED succession", async () => {
    const counts = { n: 0 }
    const harness = await bootHarness({ counts, env: {} })

    const handle = await bounded(
      connect({
        transport: transports.ws({
          url: "ws://127.0.0.1:0/",
          webSocketCtor: harness.ctor,
        }),
        onApproval: async () => ({ decision: "approve" as const }),
      }),
      "connect() handshake (gate OFF)",
    )
    cleanup = async () => {
      await handle.close()
      await harness.teardown()
    }

    expect((await handle.snapshot())?.snapshot.capabilities.serverAutoContinues).toBe(false)

    await handle.input.append("do the dangerous thing")
    const runReceipt = await handle.turn.run()

    const end = await bounded(handle.awaitTurnEnd(), "awaitTurnEnd (gate OFF)")
    expect(end.type).toBe("turn.completed")
    expect(counts.n).toBe(1)

    // F6 (jul-16 audit): same queue determinization before the exact-count pin.
    await probeQuiescent(handle, "gate OFF")

    // Legacy-daemon regime: the CLIENT (the hoisted flow) re-issued — exactly
    // TWO client-sent turn.runs, and the terminal is caused by the SECOND
    // (the reported succession id), never the first.
    const clientTurnRuns = harness.clientSentCommands.filter((c) => c.type === "turn.run")
    expect(clientTurnRuns.length).toBe(2)
    expect(clientTurnRuns[0]?.commandId).toBe(runReceipt.commandId)
    expect(end.causedByCommandId).toBe(clientTurnRuns[1]?.commandId)
  })

  test("HIGH-1 (jul-16 audit): a PARKED approval + turn.cancel — the kernel discards the approval silently; awaitTurnEnd rejects typed approval_voided (was: permanent hang)", async () => {
    const counts = { n: 0 }
    const harness = await bootHarness({ counts, env: {} })

    // NO onApproval — the approval PARKS awaiting a peer (§3.4 by-design).
    const handle = await bounded(
      connect({
        transport: transports.ws({
          url: "ws://127.0.0.1:0/",
          webSocketCtor: harness.ctor,
        }),
      }),
      "connect() handshake (voided)",
    )
    cleanup = async () => {
      await handle.close()
      await harness.teardown()
    }

    await handle.input.append("do the dangerous thing")
    await handle.turn.run()
    // The duplex send awaits the full dispatch: the turn is parked NOW
    // (approval.requested + awaiting_approval state echo already delivered).
    expect((await handle.snapshot())?.snapshot.sessionId).toBe(harness.session.sessionId)

    const wait = handle.awaitTurnEnd()
    await handle.turn.cancel()

    // KERNEL FACT (reducer.ts turn.cancel on awaiting_approval): the ONLY
    // emission is a session.state.updated leaving awaiting_approval — no
    // approval.resolved, no turn terminal. The typed void is the only
    // non-hang outcome.
    const err = await bounded(
      wait.then(
        () => undefined,
        (e: unknown) => e,
      ),
      "awaitTurnEnd typed rejection (approval_voided)",
    )
    expect(err).toBeDefined()
    expect((err as Error).name).toBe("SessionTurnCorrelationLostError")
    expect((err as { reason?: string }).reason).toBe("approval_voided")
    expect(counts.n).toBe(0) // the gated tool never ran
  })

  test("deny: awaitTurnEnd fails TYPED (no terminal event will ever come — hang-guard §3.2), tool never runs", async () => {
    const counts = { n: 0 }
    const harness = await bootHarness({ counts, env: {} })

    const handle = await bounded(
      connect({
        transport: transports.ws({
          url: "ws://127.0.0.1:0/",
          webSocketCtor: harness.ctor,
        }),
        onApproval: async () => "deny",
      }),
      "connect() handshake (deny)",
    )
    cleanup = async () => {
      await handle.close()
      await harness.teardown()
    }

    await handle.input.append("do the dangerous thing")
    await handle.turn.run()

    // A denied approval clears the draft and settles idle WITHOUT any
    // turn.completed/failed/aborted — the correlation target is structurally
    // gone. The handle must fail TYPED instead of hanging forever.
    const err = await bounded(
      handle.awaitTurnEnd().then(
        () => undefined,
        (e: unknown) => e,
      ),
      "awaitTurnEnd typed rejection (deny)",
    )
    expect(err).toBeDefined()
    expect((err as Error).name).toBe("SessionTurnCorrelationLostError")
    expect(String((err as Error).message)).toContain("denied")
    expect(counts.n).toBe(0)
  })
})
