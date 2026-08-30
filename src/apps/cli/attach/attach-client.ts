/**
 * `attachToDaemon` — the CLI "join a running daemon's shared session" client.
 *
 * This is the #1 multi-surface unlock: the legacy CLI builds an IN-PROCESS
 * session, so it can never see what a running daemon is doing. This module
 * opens a WebSocket to the daemon's session.v1 endpoint, performs the
 * discovery→adopt handshake (`./handshake`), renders inbound SessionEvents to
 * the terminal (`./render`), reads stdin line-by-line into `input.append` +
 * `turn.run` (`./commands`), and prompts y/N on `approval.requested`.
 *
 * It REUSES the shared transport infra (`@/ipc/session`) — `createSession
 * TransportClient` over `wrapWebSocketLikeAsSessionTransport` — and never
 * re-implements the codec. The discovery→adopt loop that the browser
 * `SessionClient` owns is reproduced here in the pure `./handshake` driver,
 * because the transport client deliberately stays transport-only.
 *
 * v1 scope: this is a SINGLE-CONNECTION client — there is NO reconnect/resume
 * path. A daemon-initiated socket close/error (or a `session.closed` event)
 * tears the client down cleanly (resolve `done`, stop the read loop, print a
 * one-line banner) rather than silently re-dialing; the handshake therefore
 * carries no resume cursor.
 *
 * Default-OFF: nothing here runs unless the `attach` subcommand is invoked, so
 * the in-process REPL path is byte-identical when not attaching.
 */

import {
  type SessionApprovalAnswer as AttachApprovalAnswer,
  createSessionApprovalFlow,
  createSessionTransportClient,
  type SessionApprovalFlow,
  type SessionTransport,
  type SessionTransportMessage,
  wrapWebSocketLikeAsSessionTransport,
} from "@/ipc/session"
import {
  buildTurnCancel,
  type CommandBuildDeps,
  type SessionCommand,
  type SessionEvent,
} from "@/protocol/session"
import { buildLineCommands } from "./commands"
import {
  type AttachHandshake,
  createAttachHandshake,
  HANDSHAKE_DISCOVERY_SESSION_ID,
} from "./handshake"
import { renderAttachModelPill, renderSessionEvent } from "./render"

/** UUX-1-19 — the prompter's RICH decision. MOVED (S3, jul-16 SDK ticket 01)
 *  to the hoisted attach flow (`@/ipc/session/attach-flow`) as
 *  `SessionApprovalAnswer`; re-exported under the attach slice's historical
 *  name so every import site stays unmodified. */
export type { SessionApprovalAnswer as AttachApprovalAnswer } from "@/ipc/session"

/** Subset of the WHATWG/Bun `WebSocket` the attach client needs — also the
 *  shape `wrapWebSocketLikeAsSessionTransport` consumes. The global Bun
 *  `WebSocket` satisfies it; tests inject a fake. */
export interface AttachSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void
  addEventListener(type: "open", handler: () => void): void
  addEventListener(type: "close", handler: () => void): void
  addEventListener(type: "error", handler: () => void): void
  removeEventListener?(type: "message", handler: (event: { data: unknown }) => void): void
}

export type AttachSocketCtor = new (
  url: string,
  protocols?: string | readonly string[],
) => AttachSocket

export interface AttachToDaemonOptions {
  /** WS URL of the daemon session endpoint, e.g. `ws://127.0.0.1:4096/`. */
  readonly url: string
  /** Bearer token — appended as `?token=…` (daemon accepts either header or query). */
  readonly token?: string
  /** Line source — defaults to a real stdin reader in `attach-cmd`. */
  readonly stdin: AsyncIterable<string>
  /** Terminal sink — defaults to `process.stdout.write`. */
  readonly write: (chunk: string) => void
  /** Approval prompt — resolves either the operator's raw answer string
   *  (LEGACY: `"y"`/`"n"`/…) or the rich {@link AttachApprovalAnswer} carrying
   *  the wire's scope/steer (UUX-1-19). */
  readonly promptApproval: (reason: string) => Promise<string | AttachApprovalAnswer>
  /** WS-B (jul-10, UUX-3-02) — the pending-approval line claim. The attach
   *  surface has ONE stdin owner (the `stdin` iterator feeding the read loop);
   *  while an approval prompt is awaiting its answer, the NEXT line belongs to
   *  it — the read loop consults this BEFORE turning the line into session
   *  commands. Absent ⇒ legacy behavior (the prompt owns its own read — only
   *  safe when `promptApproval` does not touch the same stdin). */
  readonly claimApprovalLine?: (line: string) => boolean
  /** Override the WebSocket ctor (defaults to global `WebSocket`). */
  readonly webSocketCtor?: AttachSocketCtor
  /** Fresh unique command id — defaults to `crypto.randomUUID`. */
  readonly newCommandId?: () => string
  /** ISO timestamp source — defaults to `() => new Date().toISOString()`. */
  readonly issuedAt?: () => string
}

export interface AttachedSession {
  /** Canonical session id once the handshake settles, else `undefined`. */
  readonly sessionId: string | undefined
  /** Resolves once the read loop drains and the socket is closed. */
  readonly done: Promise<void>
  /** Send `turn.cancel` (best-effort) then close the socket + read loop. */
  close(): Promise<void>
}

const withAuthQuery = (url: string, token: string | undefined): string => {
  if (token === undefined || token.length === 0) return url
  const sep = url.includes("?") ? "&" : "?"
  return `${url}${sep}token=${encodeURIComponent(token)}`
}

/** S1 (jul-16 ticket 01) — attach commands ride the hoisted protocol builder
 *  SSOT; `issuedAt`/`commandId` are always given via meta, so the clock
 *  fallback is dormant by construction. */
const ATTACH_CLOCK: CommandBuildDeps["clock"] = { now: () => new Date() }

const resolveCtor = (override: AttachSocketCtor | undefined): AttachSocketCtor => {
  if (override !== undefined) return override
  const g = globalThis as { WebSocket?: AttachSocketCtor }
  if (g.WebSocket === undefined) {
    throw new Error(
      "attachToDaemon: no WebSocket constructor available — pass `webSocketCtor` explicitly.",
    )
  }
  return g.WebSocket
}

/** The socket, the framed transport over it, and the handshake result. */
const attachTransport = (opts: AttachToDaemonOptions) => {
  /** The factory's MUTABLE state. `let` bindings cannot cross a function
   *  boundary by value, so they live here and every link mutates in place —
   *  observationally identical to the closure they replace. */
  const mut = {
    closed: false,
    sendBroken: false,
    resolveDone: undefined as (() => void) | undefined,
    disconnectBannerPrinted: false,
  }
  const Ctor = resolveCtor(opts.webSocketCtor)
  const newCommandId = opts.newCommandId ?? (() => crypto.randomUUID())
  const issuedAt = opts.issuedAt ?? (() => new Date().toISOString())

  const socket = new Ctor(withAuthQuery(opts.url, opts.token))
  const transport: SessionTransport = wrapWebSocketLikeAsSessionTransport(socket)
  const handshake: AttachHandshake = createAttachHandshake()
  // We seed the transport client's sessionId with the discovery sentinel and
  // send commands straight through the transport carrying the adopted canonical
  // id (the client only validates command.sessionId against its own seed, so we
  // bypass that by sending directly). No reconnect/resume cursor in v1 — see the
  // module doc; a daemon-initiated close exits cleanly instead of re-dialing.
  const client = createSessionTransportClient({
    transport,
    sessionId: HANDSHAKE_DISCOVERY_SESSION_ID,
  })
  const done = new Promise<void>((resolve) => {
    mut.resolveDone = resolve
  })
  return { opts, Ctor, newCommandId, issuedAt, socket, transport, handshake, client, done, mut }
}

/** Outbound protocol: send a command, wait for ready, run the approval flow,
 *  and issue the initial connect. */
const attachProtocol = async (ctx: ReturnType<typeof attachTransport>) => {
  const { opts, newCommandId, issuedAt, socket, transport, handshake, mut } = ctx

  const sendCommand = async (command: SessionCommand): Promise<void> => {
    // Send straight through the transport (bypassing the client's seed-id
    // validation) so the command carries the CANONICAL id the daemon expects.
    await transport.send({ kind: "command", command })
  }

  // Handshake-readiness gate shared by the read loop AND the approval flow
  // (bounded — a handshake that never settles fails visibly, not silently).
  const waitForReady = async (): Promise<boolean> => {
    const start = Date.now()
    while (!handshake.ready && !mut.closed) {
      if (Date.now() - start > 10_000) return false
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return handshake.ready && !mut.closed
  }

  // S3 (jul-16 SDK ticket 01) — the approval round-trip (serialized prompts →
  // respond → ADR-0540 marker-gated turn.run re-issue) is the HOISTED shared
  // flow; this surface supplies only its own seams: the TTY prompter, the
  // pre-handshake banner, and the loud mut.sendBroken latch on a dead socket.
  // Continuation reporting stays unwired here (attach has no awaitTurnEnd).
  const approvalFlow: SessionApprovalFlow = createSessionApprovalFlow({
    waitForReady,
    sessionId: () => handshake.sessionId,
    serverAutoContinues: () => handshake.capabilities?.serverAutoContinues === true,
    promptApproval: (reason) => opts.promptApproval(reason),
    sendCommand,
    newCommandId,
    issuedAt,
    onUnanswerable: (reason) => {
      opts.write(
        `\n[approval "${reason}" arrived before the handshake completed — cannot respond; it stays unanswered/denied on the daemon side]\n`,
      )
    },
    onRespondSendFailed: () => {
      mut.sendBroken = true
      opts.write("\n[disconnected from daemon (approval response not delivered)]\n")
    },
  })

  // Kick the handshake: send the discovery connect once the socket is open.
  // Bun's client WS may already be CONNECTING; the `open` listener fires the
  // first frame. If the socket opens before we attach (unlikely), the readyState
  // guard sends immediately.
  const sendInitialConnect = (): void => {
    void transport.send(handshake.initialConnect()).catch(() => undefined)
  }
  if (socket.readyState === 1 /* OPEN */) {
    sendInitialConnect()
  } else {
    socket.addEventListener("open", sendInitialConnect)
  }
  return { sendCommand, waitForReady, approvalFlow, sendInitialConnect }
}

/** Inbound dispatch and teardown. These are one link because the event
 *  handlers and `disconnect` reference each other — splitting them would turn
 *  a legal closure-level forward reference into a compile error. */
const attachDispatch = async (
  ctx: ReturnType<typeof attachTransport> & Awaited<ReturnType<typeof attachProtocol>>,
) => {
  const {
    opts,
    newCommandId,
    issuedAt,
    socket,
    transport,
    handshake,
    client,
    mut,
    sendCommand,
    approvalFlow,
  } = ctx

  const handleEvent = (event: SessionEvent): void => {
    const chunk = renderSessionEvent(event)
    if (chunk.length > 0) opts.write(chunk)
    // The daemon told us the shared session is gone — the render already
    // printed the "[session mut.closed by daemon]" banner; now actually tear the
    // client down (stop the read loop, close the socket, resolve `done`) rather
    // than leaving the CLI attached to a dead session. (audit finding #2)
    if (event.type === "session.closed") {
      void disconnect()
      return
    }
    if (event.type === "approval.requested") {
      approvalFlow.handleApprovalRequested(event.approval)
    }
  }

  const onMessage = (message: SessionTransportMessage): void => {
    const wasReady = handshake.ready
    const reaction = handshake.onMessage(message)
    if (reaction !== undefined) {
      // Re-handshake with the adopted canonical id.
      void transport.send(reaction).catch(() => undefined)
    }
    // AUDIT-γ H2 — the `[session · <model>]` pill on the FIRST settle. The engine
    // no longer fans `session.created` to the transport bridge, so a wire attach
    // never sees that event; the model comes from the handshake SNAPSHOT
    // (`snapshot.state.modelSlug`) instead. Render exactly once, on the
    // not-ready → ready edge.
    if (!wasReady && handshake.ready) {
      opts.write(renderAttachModelPill(handshake.modelSlug))
    }
    if (message.kind === "event") handleEvent(message.event)
  }

  const unsubscribe = client.onMessage(onMessage)

  const close = async (): Promise<void> => {
    if (mut.closed) return
    mut.closed = true
    const sid = handshake.sessionId
    // Skip the best-effort `turn.cancel` when the socket is already broken/
    // closing — a send on a dead socket only throws (it's swallowed anyway).
    if (sid !== undefined && !mut.sendBroken && socket.readyState !== 3 /* CLOSED */) {
      await sendCommand(
        buildTurnCancel(
          { sessionId: sid, clock: ATTACH_CLOCK },
          { commandId: newCommandId(), issuedAt: issuedAt() },
        ),
      ).catch(() => undefined)
    }
    unsubscribe()
    await client.close().catch(() => undefined)
    mut.resolveDone?.()
  }
  const disconnect = (banner?: string): Promise<void> => {
    if (mut.closed) return Promise.resolve()
    if (banner !== undefined && !mut.disconnectBannerPrinted) {
      mut.disconnectBannerPrinted = true
      opts.write(banner)
    }
    return close()
  }

  // Daemon-initiated socket close / error MUST end the read loop and resolve
  // `done`; without these listeners the CLI hangs forever waiting on a dead
  // socket. `wrapWebSocketLikeAsSessionTransport` only listens for "message",
  // so we own the close/error wiring here. (audit finding #1)
  socket.addEventListener("close", () => {
    void disconnect("\n[disconnected from daemon]\n")
  })
  socket.addEventListener("error", () => {
    void disconnect("\n[disconnected from daemon (connection error)]\n")
  })
  return { handleEvent, onMessage, unsubscribe, close, disconnect }
}

type AttachReadLoopContext = ReturnType<typeof attachTransport> &
  Awaited<ReturnType<typeof attachProtocol>> &
  Awaited<ReturnType<typeof attachDispatch>>

type AttachLineOutcome = "continue" | "stop"

/** A readiness timeout is terminal for the pending typed line: report it
 * explicitly instead of silently dropping the input while detaching. */
const handleAttachReadinessFailure = (ctx: AttachReadLoopContext): AttachLineOutcome => {
  if (!ctx.mut.closed) {
    ctx.opts.write("\n[handshake with the daemon never completed — input not sent; detaching]\n")
  }
  return "stop"
}

/** Send the input.append/turn.run batch as one outcome. A send can race socket
 * lifecycle events, so this is the single place that latches the broken state
 * and emits the user-visible loss-of-input receipt. */
const sendAttachLineCommands = async (
  ctx: AttachReadLoopContext,
  sessionId: string,
  line: string,
): Promise<AttachLineOutcome> => {
  const commands = buildLineCommands({
    sessionId,
    line,
    newCommandId: ctx.newCommandId,
    issuedAt: ctx.issuedAt,
  })
  try {
    for (const command of commands) await ctx.sendCommand(command)
    return "continue"
  } catch {
    ctx.mut.sendBroken = true
    ctx.opts.write("\n[disconnected from daemon (send failed)]\n")
    return "stop"
  }
}

/** Claim approval input before session input, wait for the canonical handshake
 * id, then dispatch the ordered command batch. */
const processAttachInputLine = async (
  ctx: AttachReadLoopContext,
  line: string,
): Promise<AttachLineOutcome> => {
  if (ctx.mut.closed || ctx.mut.sendBroken) return "stop"
  if (ctx.opts.claimApprovalLine?.(line) === true) return "continue"

  const ready = await ctx.waitForReady()
  if (!ready) return handleAttachReadinessFailure(ctx)

  const sessionId = ctx.handshake.sessionId
  if (sessionId === undefined) return "continue"
  return sendAttachLineCommands(ctx, sessionId, line)
}

const consumeAttachInput = async (ctx: AttachReadLoopContext): Promise<void> => {
  for await (const line of ctx.opts.stdin) {
    if ((await processAttachInputLine(ctx, line)) === "stop") return
  }
}

/** The read loop that feeds the dispatch above. */
const attachReadLoop = async (ctx: AttachReadLoopContext) => {
  const { close } = ctx

  // stdin read loop — each line becomes input.append + turn.run, but only once
  // the handshake is READY (so commands carry the canonical id the daemon
  // accepts; the shared `waitForReady` gate is declared above the approval
  // flow). Lines typed before readiness are still consumed in order; we wait
  // for readiness per line.
  const readLoop = async (): Promise<void> => {
    try {
      await consumeAttachInput(ctx)
    } finally {
      await close()
    }
  }

  void readLoop()

  return { readLoop }
}

/** Assemble the chained builders. */
export const attachToDaemon = async (opts: AttachToDaemonOptions): Promise<AttachedSession> => {
  const p0 = attachTransport(opts)
  const p1 = await attachProtocol({ ...p0 })
  const p2 = await attachDispatch({ ...p0, ...p1 })
  const p3 = await attachReadLoop({ ...p0, ...p1, ...p2 })
  const { handshake, done, close } = { ...p0, ...p1, ...p2, ...p3 }
  return {
    get sessionId() {
      return handshake.sessionId
    },
    done,
    close,
  }
}
