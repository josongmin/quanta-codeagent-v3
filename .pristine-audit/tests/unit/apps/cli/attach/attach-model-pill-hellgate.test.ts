/**
 * AUDIT-γ H2 (observability) — wire attach must surface WHICH model it is
 * attached to.
 *
 * BUG. The `[session · <model>]` pill was rendered ONLY from the wire
 * `session.created` event (render.ts). The engine stopped fanning
 * `session.created` to the transport bridge ("snapshot is the source of truth"
 * — the B-fix), so a wire attach (`quanta attach`, or a bot's `connect()`) that
 * settles its handshake purely on the SNAPSHOT frame NEVER sees the model — the
 * pill is dead. The snapshot DOES carry it as `snapshot.state.modelSlug`.
 *
 * CONTRACT. After the handshake settles on a snapshot carrying a modelSlug, the
 * attach client writes the `[session · <model>]` pill — with ZERO
 * `session.created` events on the wire.
 *
 * RED (pre-fix). The snapshot's modelSlug is retained nowhere and rendered
 * nowhere ⇒ the pill never appears.
 * RED-ON-INJECTION (post-fix). Remove the snapshot-driven pill render in
 * attach-client.ts (or the modelSlug retention in the handshake) ⇒ the pill is
 * absent again.
 */

import { describe, expect, test } from "bun:test"
import { type AttachSocket, type AttachSocketCtor, attachToDaemon } from "@/apps/cli/attach"
import {
  encodeSessionTransportMessage,
  type SessionTransportMessage,
  tryDecodeSessionTransportMessage,
} from "@/ipc/session"
import { capabilitiesFor } from "../../../../support/session-fixtures"

type Listeners = {
  message: Array<(event: { data: unknown }) => void>
  open: Array<() => void>
  close: Array<() => void>
  error: Array<() => void>
}

interface FakeSocket extends AttachSocket {
  readonly sent: SessionTransportMessage[]
  deliver(message: SessionTransportMessage): void
  fireOpen(): void
}

const makeFakeSocket = (): FakeSocket => {
  const listeners: Listeners = { message: [], open: [], close: [], error: [] }
  const sent: SessionTransportMessage[] = []
  let readyState = 0
  const socket: FakeSocket = {
    get readyState() {
      return readyState
    },
    send(data: string) {
      const msg = tryDecodeSessionTransportMessage(data)
      if (msg !== undefined) sent.push(msg)
    },
    close() {
      readyState = 3
    },
    addEventListener(type: "message" | "open" | "close" | "error", handler: never) {
      listeners[type].push(handler as never)
    },
    removeEventListener() {},
    sent,
    deliver(message: SessionTransportMessage) {
      const data = encodeSessionTransportMessage(message)
      for (const h of listeners.message) h({ data })
    },
    fireOpen() {
      readyState = 1
      for (const h of listeners.open) h()
    },
  }
  return socket
}

/** A snapshot that settles the handshake AND carries a known modelSlug. */
const snapshotWithModel = (sid: string, modelSlug: string): SessionTransportMessage => ({
  kind: "snapshot",
  snapshot: {
    sessionId: sid,
    revision: 1,
    seq: 1,
    state: {
      status: "idle",
      draftInput: "",
      permissionMode: "default",
      messageCount: 0,
      modelSlug,
    },
    capabilities: capabilitiesFor({ transport: "websocket" }),
    pendingApproval: null,
    openArtifacts: [],
  },
})

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

describe("AUDIT-γ H2 — wire attach renders the model pill from the snapshot", () => {
  test("handshake snapshot carrying modelSlug ⇒ [session · <model>] pill, no session.created on the wire", async () => {
    const socket = makeFakeSocket()
    const ctor = function (this: unknown, _url: string) {
      return socket
    } as unknown as AttachSocketCtor
    const rendered: string[] = []
    // A parked stdin so the read loop does not exit the client early.
    const parkedStdin = (async function* () {
      await new Promise<void>(() => undefined)
    })()

    const session = await attachToDaemon({
      url: "ws://127.0.0.1:0/",
      stdin: parkedStdin,
      write: (chunk) => rendered.push(chunk),
      promptApproval: async () => "n",
      webSocketCtor: ctor,
    })
    socket.fireOpen()
    // ONLY a snapshot — no session.created event is ever delivered.
    socket.deliver(snapshotWithModel("wire-1", "claude-opus-4-8"))
    await flush()

    const all = rendered.join("")
    expect(all).toContain("claude-opus-4-8")
    expect(all).toContain("[session · claude-opus-4-8]")

    await session.close()
  })
})
