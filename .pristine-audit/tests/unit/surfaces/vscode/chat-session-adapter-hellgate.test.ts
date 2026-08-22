/**
 * T07 HELLGATE — VS Code `chatSessions` editor extension adapter.
 *
 * These tests drive a REAL session.v1 round-trip (the same `@/ipc/session`
 * bridge + client + `@/protocol/session` envelopes the CLI/web surfaces use)
 * through the PURE adapter that maps session.v1 ↔ VS Code `ChatSessionItem`.
 * No `vscode` symbol is imported here OR in the adapter under test — the editor
 * glue lives in `surfaces/vscode/src/provider.ts` (the thin shell), and the
 * core-decoupling invariant is proved by `core-no-vscode-leak-ratchet.test.ts`.
 *
 * UC1 — quanta thread shows as a `ChatSessionItem` (id / label / status).
 * UC2 — status transitions in-progress↔idle, derived from turn lifecycle.
 * UC3 — editor creates a new session → a new quanta thread starts.
 *
 * The adapter consumes the protocol; it does NOT optimistically flip status —
 * the server's turn lifecycle is the single source of truth (no UI-lie).
 */
import { describe, expect, test } from "bun:test"
import { ChatSessionRegistry, type SessionPort } from "@surfaces/vscode/chat-session-adapter"
import { CHAT_SESSION_STATUS } from "@surfaces/vscode/status"
import {
  bindSessionTransportServer,
  createSessionTransportBridge,
  createSessionTransportClient,
  type SessionTransport,
  type SessionTransportHandler,
  type SessionTransportMessage,
} from "@/ipc/session"
import type { SessionCommand, SessionEvent, SessionSnapshotLite } from "@/protocol/session"
import { capabilitiesFor, makeSnapshotLite } from "../../../support/session-fixtures"

const CAPABILITIES = capabilitiesFor({ approvals: "operator", tools: true, transport: "stdio" })

const makeSnapshot = (sessionId: string): SessionSnapshotLite =>
  makeSnapshotLite({ sessionId, capabilities: CAPABILITIES })

/** A linked in-memory transport pair: whatever side A sends arrives at side B's
 *  handlers, and vice-versa — the real `SessionTransport` contract. */
const makeInMemoryPair = (): { server: SessionTransport; client: SessionTransport } => {
  const aHandlers = new Set<SessionTransportHandler>()
  const bHandlers = new Set<SessionTransportHandler>()
  const deliver = async (handlers: Set<SessionTransportHandler>, m: SessionTransportMessage) => {
    for (const h of [...handlers]) await h(m)
  }
  const server: SessionTransport = {
    send: (m) => deliver(bHandlers, m),
    onMessage: (h) => {
      aHandlers.add(h)
      return () => aHandlers.delete(h)
    },
    close: async () => {},
  }
  const client: SessionTransport = {
    send: (m) => deliver(aHandlers, m),
    onMessage: (h) => {
      bHandlers.add(h)
      return () => bHandlers.delete(h)
    },
    close: async () => {},
  }
  return { server, client }
}

/**
 * A minimal simulated runtime sitting behind the bridge: it interprets a
 * `turn.run` by publishing the turn lifecycle that a real agent loop would.
 * `emitStateUpdated` toggles whether it also publishes the coarse
 * `session.state.updated` view (the web/daemon path) so the adapter's status
 * derivation is exercised on BOTH the turn.* path and the state.updated path.
 */
const makeHarness = (
  sessionId: string,
  opts: { readonly emitStateUpdated: boolean; readonly fail?: boolean } = {
    emitStateUpdated: true,
  },
) => {
  let seq = 1
  let revision = 1
  let lastUserText = ""
  const snapshot = makeSnapshot(sessionId)

  const bridge = createSessionTransportBridge({
    snapshot,
    onCommand: async (command: SessionCommand) => {
      if (command.type === "input.append") {
        lastUserText = command.text
        return
      }
      if (command.type === "turn.run") {
        const started: SessionEvent = {
          eventId: `e${++seq}`,
          seq,
          revision: ++revision,
          emittedAt: "2026-06-13T00:00:01.000Z",
          type: "turn.started",
          prompt: lastUserText,
        }
        await bridge.publishEvents([started])
        if (opts.emitStateUpdated) {
          await bridge.publishEvents([
            {
              eventId: `e${++seq}`,
              seq,
              revision: ++revision,
              emittedAt: "2026-06-13T00:00:01.500Z",
              type: "session.state.updated",
              state: {
                status: "running",
                draftInput: "",
                permissionMode: "default",
                messageCount: 1,
                lastUserText,
              },
            },
          ])
        }
        if (opts.fail) {
          await bridge.publishEvents([
            {
              eventId: `e${++seq}`,
              seq,
              revision: ++revision,
              emittedAt: "2026-06-13T00:00:02.000Z",
              type: "turn.failed",
              message: "boom",
            },
          ])
          return
        }
        const completed: SessionEvent = {
          eventId: `e${++seq}`,
          seq,
          revision: ++revision,
          emittedAt: "2026-06-13T00:00:02.000Z",
          type: "turn.completed",
          outcomeReason: "completed",
          assistantText: "done",
        }
        await bridge.publishEvents([completed])
        if (opts.emitStateUpdated) {
          await bridge.publishEvents([
            {
              eventId: `e${++seq}`,
              seq,
              revision: ++revision,
              emittedAt: "2026-06-13T00:00:02.500Z",
              type: "session.state.updated",
              state: {
                status: "idle",
                draftInput: "",
                permissionMode: "default",
                messageCount: 2,
                lastUserText,
                lastAssistantText: "done",
              },
            },
          ])
        }
      }
    },
  })

  return { bridge }
}

/** Stand up a connected client `SessionPort` over the real bridge/transport. */
const connectPort = async (
  sessionId: string,
  opts?: { readonly emitStateUpdated: boolean; readonly fail?: boolean },
): Promise<{ port: SessionPort; dispose: () => Promise<void> }> => {
  const { bridge } = makeHarness(sessionId, opts ?? { emitStateUpdated: true })
  const { server, client: clientTransport } = makeInMemoryPair()
  const server2 = await bindSessionTransportServer({ bridge, transport: server })
  const client = createSessionTransportClient({ transport: clientTransport, sessionId })
  await client.connect()
  return {
    port: client,
    dispose: async () => {
      await client.close()
      await server2.close()
      await bridge.close()
    },
  }
}

/** Wait one macrotask so async publishes drain to the client. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0))

describe("T07 chatSessions adapter — hellgate (real session.v1)", () => {
  test("UC1: a connected quanta thread shows as one ChatSessionItem (id/label/status)", async () => {
    const { port, dispose } = await connectPort("thread-uc1")
    const registry = new ChatSessionRegistry({})
    registry.track(port)
    await settle()

    const items = registry.items()
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe("thread-uc1")
    expect(items[0]?.status).toBe(CHAT_SESSION_STATUS.Idle)
    // An untouched thread (no lastUserText) carries the stable default label —
    // never undefined/empty, and never the literal sessionId.
    expect(items[0]?.label).toBe("quanta thread")

    await dispose()
  })

  test("UC2 (turn.* path): status goes Idle→InProgress→Idle as the turn runs", async () => {
    const { port, dispose } = await connectPort("thread-uc2a", { emitStateUpdated: false })
    const registry = new ChatSessionRegistry({})
    const projection = registry.track(port)
    await settle()
    expect(projection.current().status).toBe(CHAT_SESSION_STATUS.Idle)

    const seen: number[] = []
    registry.onDidChangeItems(() => seen.push(projection.current().status))

    await projection.submitMessage("hello world")
    await settle()

    // The terminal state is Idle, and we must have PASSED THROUGH InProgress
    // (proving the editor would have shown a running spinner — not a silent flip).
    expect(projection.current().status).toBe(CHAT_SESSION_STATUS.Idle)
    expect(seen).toContain(CHAT_SESSION_STATUS.InProgress)
    expect(projection.current().label).toContain("hello world")
    // Timing populated from the turn lifecycle (start before end).
    const timing = projection.current().timing
    expect(timing?.startTime).toBeGreaterThan(0)
    expect((timing?.endTime ?? 0) >= (timing?.startTime ?? 0)).toBe(true)

    await dispose()
  })

  test("UC2 (state.updated path): coarse session.state.updated also drives status", async () => {
    const { port, dispose } = await connectPort("thread-uc2b", { emitStateUpdated: true })
    const registry = new ChatSessionRegistry({})
    const projection = registry.track(port)
    await settle()

    const seen: number[] = []
    registry.onDidChangeItems(() => seen.push(projection.current().status))
    await projection.submitMessage("via state view")
    await settle()

    expect(seen).toContain(CHAT_SESSION_STATUS.InProgress)
    expect(projection.current().status).toBe(CHAT_SESSION_STATUS.Idle)

    await dispose()
  })

  test("UC2 (failure): a failed turn maps to Failed status", async () => {
    const { port, dispose } = await connectPort("thread-fail", {
      emitStateUpdated: false,
      fail: true,
    })
    const registry = new ChatSessionRegistry({})
    const projection = registry.track(port)
    await settle()

    await projection.submitMessage("trigger failure")
    await settle()

    expect(projection.current().status).toBe(CHAT_SESSION_STATUS.Failed)

    await dispose()
  })

  test("UC3: creating a new session via the editor starts a new quanta thread", async () => {
    let n = 0
    const registry = new ChatSessionRegistry({
      createSession: async () => {
        n += 1
        const { port } = await connectPort(`new-thread-${n}`)
        return port
      },
    })
    expect(registry.items()).toHaveLength(0)

    const projection = await registry.createNew()
    await settle()

    expect(registry.items()).toHaveLength(1)
    expect(projection.current().id).toBe("new-thread-1")
    expect(registry.get("new-thread-1")).toBe(projection)
  })

  test("registry change event fires on membership and on per-item status change", async () => {
    const registry = new ChatSessionRegistry({
      createSession: async () => (await connectPort("evt-thread")).port,
    })
    let changes = 0
    registry.onDidChangeItems(() => {
      changes += 1
    })
    const projection = await registry.createNew()
    await settle()
    const afterAdd = changes
    expect(afterAdd).toBeGreaterThan(0)

    await projection.submitMessage("ping")
    await settle()
    expect(changes).toBeGreaterThan(afterAdd)
  })

  test("wiring-proof: submitMessage emits input.append{text} then turn.run, both bound to the session", async () => {
    // A recording SessionPort: proves the editor action reaches the PROTOCOL
    // with the right command shape + ORDER + sessionId (not merely that some
    // turn eventually ran). Uses the structural SessionPort so it stays decoupled.
    const sent: SessionCommand[] = []
    const port: SessionPort = {
      sessionId: "wire-1",
      onMessage: () => () => {},
      sendCommand: async (c) => {
        sent.push(c)
      },
    }
    const projection = new ChatSessionRegistry({}).track(port)

    await projection.submitMessage("do the thing")

    expect(sent.map((c) => c.type)).toEqual(["input.append", "turn.run"])
    const append = sent[0] as Extract<SessionCommand, { type: "input.append" }>
    expect(append.text).toBe("do the thing")
    expect(sent.every((c) => c.sessionId === "wire-1")).toBe(true)
    // Command ids are distinct (a duplicate would be rejected by the bridge dedup).
    expect(new Set(sent.map((c) => c.commandId)).size).toBe(sent.length)
  })

  test("wiring-proof: cancel emits a session-bound turn.cancel", async () => {
    const sent: SessionCommand[] = []
    const port: SessionPort = {
      sessionId: "wire-2",
      onMessage: () => () => {},
      sendCommand: async (c) => {
        sent.push(c)
      },
    }
    const projection = new ChatSessionRegistry({}).track(port)

    await projection.cancel()

    expect(sent.map((c) => c.type)).toEqual(["turn.cancel"])
    expect(sent[0]?.sessionId).toBe("wire-2")
  })
})
