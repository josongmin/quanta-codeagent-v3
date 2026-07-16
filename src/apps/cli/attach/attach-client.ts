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
  createSessionTransportClient,
  type SessionTransport,
  type SessionTransportMessage,
  wrapWebSocketLikeAsSessionTransport,
} from "@/ipc/session"
import {
  type ApprovalRespondCommand,
  buildApprovalRespond,
  buildTurnCancel,
  buildTurnRun,
  type CommandBuildDeps,
  type SessionCommand,
  type SessionEvent,
} from "@/protocol/session"
import { buildApprovalRespondCommand, buildLineCommands } from "./commands"
import {
  type AttachHandshake,
  createAttachHandshake,
  HANDSHAKE_DISCOVERY_SESSION_ID,
} from "./handshake"
import { renderSessionEvent } from "./render"

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

/** UUX-1-19 (jul-10 W4) — the attach prompter's RICH decision, mirroring what
 *  the wire (`ApprovalRespondCommand`) actually carries: the kernel scheduler
 *  forwards `scope` + `steer` verbatim to `host.resolveApproval`, so the
 *  attach surface can offer [a]lways-session and deny+s[t]eer as first-class
 *  verbs instead of collapsing everything onto y/N. A plain string answer is
 *  the LEGACY shape (y/yes ⇒ approve, else deny) and stays accepted. */
export interface AttachApprovalAnswer {
  readonly decision: "approve" | "deny"
  /** Only meaningful on `approve` (the wire's standing-grant scopes). */
  readonly scope?: "once" | "session" | "session_prefix"
  /** Only meaningful on `deny` (the wire's corrective steer). */
  readonly steer?: string
}

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

/** UUX-1-19 — map the prompter's answer onto the wire. A STRING answer keeps
 *  the legacy y/N mapping (`buildApprovalRespondCommand`, byte-identical); a
 *  rich {@link AttachApprovalAnswer} carries `scope`/`steer` verbatim — the
 *  kernel scheduler forwards both to `host.resolveApproval`. A steer is only
 *  attached to a DENY and never as an empty string (the normalizer SSOT's
 *  no-phantom-steer rule, mirrored at the wire boundary) — that policy stays
 *  HERE; the hoisted `buildApprovalRespond` owns only the wire assembly. */
const buildRespondForAnswer = (args: {
  readonly sessionId: string
  readonly approvalId: string
  readonly answer: string | AttachApprovalAnswer
  readonly commandId: string
  readonly issuedAt: string
}): ApprovalRespondCommand => {
  const { sessionId, approvalId, answer, commandId, issuedAt } = args
  if (typeof answer === "string") {
    return buildApprovalRespondCommand({ sessionId, approvalId, answer, commandId, issuedAt })
  }
  return buildApprovalRespond({ sessionId, clock: ATTACH_CLOCK }, approvalId, answer.decision, {
    commandId,
    issuedAt,
    ...(answer.decision === "approve" && answer.scope !== undefined ? { scope: answer.scope } : {}),
    ...(answer.decision === "deny" && answer.steer !== undefined && answer.steer.trim().length > 0
      ? { steer: answer.steer }
      : {}),
  })
}

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

export const attachToDaemon = async (opts: AttachToDaemonOptions): Promise<AttachedSession> => {
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

  let closed = false
  // Latched true once any send is observed to fail (dead socket) so the read
  // loop stops accepting further input instead of silently dropping lines.
  let sendBroken = false
  let resolveDone: (() => void) | undefined
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  // Serialize approval prompts so two near-simultaneous requests don't garble
  // the terminal; each awaits the prior.
  let approvalChain: Promise<void> = Promise.resolve()

  const sendCommand = async (command: SessionCommand): Promise<void> => {
    // Send straight through the transport (bypassing the client's seed-id
    // validation) so the command carries the CANONICAL id the daemon expects.
    await transport.send({ kind: "command", command })
  }

  const handleEvent = (event: SessionEvent): void => {
    const chunk = renderSessionEvent(event)
    if (chunk.length > 0) opts.write(chunk)
    // The daemon told us the shared session is gone — the render already
    // printed the "[session closed by daemon]" banner; now actually tear the
    // client down (stop the read loop, close the socket, resolve `done`) rather
    // than leaving the CLI attached to a dead session. (audit finding #2)
    if (event.type === "session.closed") {
      void disconnect()
      return
    }
    if (event.type === "approval.requested") {
      const approvalId = event.approval.approvalId
      const reason = event.approval.reason
      approvalChain = approvalChain.then(async () => {
        // WS-B (jul-10, UUX-3-03) — a PRE-HANDSHAKE approval is no longer
        // silently dropped: the serialized chain WAITS for the handshake
        // (bounded, same 10s the read loop uses) and resolves the canonical
        // session id then. Only when the handshake never completes do we fail
        // CLOSED with a VISIBLE banner (we structurally cannot respond without
        // a session id — the daemon's own lease keeps the ask fail-closed).
        const ready = await waitForReady()
        const sid = handshake.sessionId
        if (!ready || sid === undefined) {
          opts.write(
            `\n[approval "${reason}" arrived before the handshake completed — cannot respond; it stays unanswered/denied on the daemon side]\n`,
          )
          return
        }
        // A throwing/garbage prompter fail-safes to a literal "n" so the
        // approval is DENIED, never approved and never left hanging. (#5)
        const answer = await opts.promptApproval(reason).catch(() => "n")
        // UUX-1-19 — string answers keep the legacy y/N mapping; a rich answer
        // rides the wire's scope/steer (see {@link buildRespondForAnswer}).
        const respond = buildRespondForAnswer({
          sessionId: sid,
          approvalId,
          answer,
          commandId: newCommandId(),
          issuedAt: issuedAt(),
        })
        // Audit R3 MED-2 — a respond send failure must be LOUD and terminal
        // (parity with the line-input path): latch sendBroken, banner, and
        // never fire the follow-up turn.run against a dead socket.
        try {
          await sendCommand(respond)
        } catch {
          sendBroken = true
          opts.write("\n[disconnected from daemon (approval response not delivered)]\n")
          return
        }
        // ADR-0512 P3 — the kernel does NOT auto-continue a resolved approval: a
        // fresh `turn.run` is what claims the grant and re-dispatches the
        // approved tool. So on APPROVE, re-run the suspended turn (a bare
        // `turn.run`, no `input.append`). A deny aborts ⇒ no continuation.
        // ADR-0540 W1-B — UNLESS the daemon declared the `serverAutoContinues`
        // capability marker (handshake snapshot): then the DAEMON re-issues the
        // continuation and this client must not (defensive `!== true` read ⇒ a
        // legacy daemon without the field keeps the client-owned re-issue,
        // byte-identical).
        if (
          respond.decision === "approve" &&
          handshake.capabilities?.serverAutoContinues !== true
        ) {
          await sendCommand(
            buildTurnRun(
              { sessionId: sid, clock: ATTACH_CLOCK },
              { commandId: newCommandId(), issuedAt: issuedAt() },
            ),
          ).catch(() => undefined)
        }
      })
    }
  }

  const onMessage = (message: SessionTransportMessage): void => {
    const reaction = handshake.onMessage(message)
    if (reaction !== undefined) {
      // Re-handshake with the adopted canonical id.
      void transport.send(reaction).catch(() => undefined)
    }
    if (message.kind === "event") handleEvent(message.event)
  }

  const unsubscribe = client.onMessage(onMessage)

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

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    const sid = handshake.sessionId
    // Skip the best-effort `turn.cancel` when the socket is already broken/
    // closing — a send on a dead socket only throws (it's swallowed anyway).
    if (sid !== undefined && !sendBroken && socket.readyState !== 3 /* CLOSED */) {
      await sendCommand(
        buildTurnCancel(
          { sessionId: sid, clock: ATTACH_CLOCK },
          { commandId: newCommandId(), issuedAt: issuedAt() },
        ),
      ).catch(() => undefined)
    }
    unsubscribe()
    await client.close().catch(() => undefined)
    resolveDone?.()
  }

  // Single teardown path for an INVOLUNTARY end of the session (daemon dropped
  // the socket, fired an error, or sent `session.closed`). Prints a one-line
  // banner so the operator isn't left staring at a silently-dead prompt, then
  // routes through `close()` (idempotent) to stop the read loop + resolve
  // `done`. (audit findings #1, #2)
  let disconnectBannerPrinted = false
  const disconnect = (banner?: string): Promise<void> => {
    if (closed) return Promise.resolve()
    if (banner !== undefined && !disconnectBannerPrinted) {
      disconnectBannerPrinted = true
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

  // stdin read loop — each line becomes input.append + turn.run, but only once
  // the handshake is READY (so commands carry the canonical id the daemon
  // accepts). Lines typed before readiness are still consumed in order; we wait
  // for readiness per line.
  const waitForReady = async (): Promise<boolean> => {
    const start = Date.now()
    while (!handshake.ready && !closed) {
      if (Date.now() - start > 10_000) return false
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return handshake.ready && !closed
  }

  const readLoop = async (): Promise<void> => {
    try {
      for await (const line of opts.stdin) {
        if (closed || sendBroken) break
        // WS-B (UUX-3-02) — a pending approval claims the next line as its
        // answer BEFORE the line becomes session input (previously a second
        // readline raced this loop for the same stdin and the "y" could be
        // swallowed as a prompt line).
        if (opts.claimApprovalLine?.(line) === true) continue
        const ready = await waitForReady()
        if (!ready) {
          // UUX-3-14 — a handshake that never settles must not eat the typed
          // line and exit SILENTLY: say why the input went nowhere.
          if (!closed) {
            opts.write(
              "\n[handshake with the daemon never completed — input not sent; detaching]\n",
            )
          }
          break
        }
        const sid = handshake.sessionId
        if (sid === undefined) continue
        const cmds = buildLineCommands({
          sessionId: sid,
          line,
          newCommandId,
          issuedAt,
        })
        let failed = false
        for (const cmd of cmds) {
          try {
            await sendCommand(cmd)
          } catch {
            // Defense-in-depth (audit finding #3): a send that THROWS after the
            // socket died must not vanish silently — the user typed a line and
            // it went nowhere. Surface it + stop accepting further input (the
            // close/error listeners normally fire too, but a send can race
            // ahead of them). Latch `sendBroken` so the loop drains and exits.
            sendBroken = true
            failed = true
            opts.write("\n[disconnected from daemon (send failed)]\n")
            break
          }
        }
        if (failed) break
      }
    } finally {
      await close()
    }
  }

  void readLoop()

  return {
    get sessionId() {
      return handshake.sessionId
    },
    done,
    close,
  }
}
