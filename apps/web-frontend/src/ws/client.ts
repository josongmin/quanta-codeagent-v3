/**
 * SessionClient — thin WebSocket wrapper over the session wire envelope.
 *
 * Responsibilities (and only these):
 *   - manage a single WS connection lifecycle (connect / reconnect / close)
 *   - encode outbound commands via `encodeCommandFrame`
 *   - decode inbound event frames via `decodeEventFrame` and dispatch to
 *     handler subscribers by event-type tag
 *   - surface connection-state transitions to subscribers (connecting /
 *     connected / disconnected with retry hint / closed)
 *
 * Non-responsibilities:
 *   - command id generation (caller passes `commandId`)
 *   - approval policy (UI hook decides)
 *   - auth token storage (passed into `connect()`)
 *
 * Auth shape: the daemon (Worker B) accepts a bearer token via an
 * `Authorization: Bearer <token>` header at the handshake. Browsers do NOT
 * allow setting arbitrary headers on `new WebSocket()`, so we fall back to
 * a query-string token `?token=<…>` — the daemon should accept either. This
 * is the same pattern Codex uses for its inproc devtools bridge.
 *
 * Note on `new WebSocket(url, protocols)`: the browser API does take an
 * array of subprotocols as the second positional argument. Some servers use
 * subprotocols for token transport (`["bearer", token]`) — we expose both
 * the query-string and the subprotocol arm via the `auth` shape.
 */

import { computeRetryDelayMs } from "./reconnect"
import {
  decodeEventFrame,
  encodeCommandFrame,
  peekEnvelopeKind,
} from "./envelope"
import type {
  ConnectionState,
  SessionCommand,
  SessionEvent,
  SessionEventType,
} from "../types/protocol"

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export interface AuthCredential {
  /** Bearer token; sent as `?token=…` query param at handshake. */
  readonly token?: string
  /**
   * Optional WS subprotocol — some daemons use `["bearer", token]` as the
   * subprotocol pair. We pass this through verbatim if provided.
   */
  readonly subprotocols?: readonly string[]
}

export interface ConnectOptions {
  readonly url: string
  readonly auth?: AuthCredential
}

export type EventHandler<TType extends SessionEventType = SessionEventType> = (
  event: Extract<SessionEvent, { type: TType }>,
) => void

export type ConnectionHandler = (state: ConnectionState) => void

/**
 * Minimal interface SessionClient depends on — the global `WebSocket` ctor
 * in the browser satisfies this, and tests can pass a stub. Avoids `any`
 * on the WebSocket boundary while staying compatible with both `lib.dom`
 * and node's `undici` ws shim if anyone ever runs the client server-side.
 */
export type WebSocketCtor = new (
  url: string,
  protocols?: string | readonly string[],
) => WebSocketLike

export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: Event) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  onerror: ((ev: Event) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}

export interface SessionClientOptions {
  /** Override the WebSocket ctor (defaults to global `WebSocket`). */
  readonly webSocketCtor?: WebSocketCtor
  /** Override the timer for scheduled reconnects (defaults to `setTimeout`). */
  readonly setTimer?: (cb: () => void, ms: number) => unknown
  /** Override the timer canceller (defaults to `clearTimeout`). */
  readonly clearTimer?: (handle: unknown) => void
  /** Optional logger — defaults to `console.warn`. */
  readonly log?: (level: "info" | "warn", msg: string) => void
}

/* ------------------------------------------------------------------ */
/* Constants — readyState mirrors the WHATWG WebSocket spec.            */
/* ------------------------------------------------------------------ */

const READYSTATE_OPEN = 1

/* ------------------------------------------------------------------ */
/* SessionClient                                                       */
/* ------------------------------------------------------------------ */

export class SessionClient {
  readonly #eventHandlers = new Map<
    SessionEventType,
    Set<EventHandler<SessionEventType>>
  >()
  readonly #wildcardEventHandlers = new Set<(event: SessionEvent) => void>()
  readonly #connectionHandlers = new Set<ConnectionHandler>()
  readonly #wsCtor: WebSocketCtor
  readonly #setTimer: (cb: () => void, ms: number) => unknown
  readonly #clearTimer: (handle: unknown) => void
  readonly #log: (level: "info" | "warn", msg: string) => void

  #ws: WebSocketLike | null = null
  #currentConnect: ConnectOptions | null = null
  #attempt = 0
  #intentionallyClosed = false
  #reconnectHandle: unknown = null
  #state: ConnectionState = { kind: "closed" }

  constructor(options: SessionClientOptions = {}) {
    const ctor =
      options.webSocketCtor ??
      (typeof globalThis !== "undefined" &&
      "WebSocket" in (globalThis as Record<string, unknown>)
        ? ((globalThis as { WebSocket?: WebSocketCtor }).WebSocket as
            | WebSocketCtor
            | undefined)
        : undefined)
    if (ctor === undefined) {
      throw new Error(
        "SessionClient: no WebSocket constructor available — pass `webSocketCtor` explicitly when running outside a browser.",
      )
    }
    this.#wsCtor = ctor
    this.#setTimer =
      options.setTimer ??
      ((cb, ms) => setTimeout(cb, ms) as unknown as number)
    this.#clearTimer =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.#log = options.log ?? ((level, msg) => console[level](msg))
  }

  /* ---------------- Lifecycle ----------------------------------- */

  connect(opts: ConnectOptions): void {
    this.#intentionallyClosed = false
    this.#currentConnect = opts
    this.#openSocket()
  }

  disconnect(): void {
    this.#intentionallyClosed = true
    if (this.#reconnectHandle !== null) {
      this.#clearTimer(this.#reconnectHandle)
      this.#reconnectHandle = null
    }
    if (this.#ws !== null) {
      try {
        this.#ws.close(1000, "client_disconnect")
      } catch {
        // ignore — close on a never-opened socket throws in some engines
      }
    }
    this.#ws = null
    this.#setState({ kind: "closed" })
  }

  send(command: SessionCommand): void {
    if (this.#ws === null || this.#ws.readyState !== READYSTATE_OPEN) {
      this.#log(
        "warn",
        `[SessionClient] dropping command type=${command.type} — socket not open`,
      )
      return
    }
    this.#ws.send(encodeCommandFrame(command))
  }

  /* ---------------- Subscriptions ------------------------------- */

  on<TType extends SessionEventType>(
    type: TType,
    handler: EventHandler<TType>,
  ): () => void {
    let set = this.#eventHandlers.get(type)
    if (set === undefined) {
      set = new Set()
      this.#eventHandlers.set(type, set)
    }
    set.add(handler as unknown as EventHandler<SessionEventType>)
    return () => {
      const target = this.#eventHandlers.get(type)
      if (target === undefined) return
      target.delete(handler as unknown as EventHandler<SessionEventType>)
      if (target.size === 0) this.#eventHandlers.delete(type)
    }
  }

  onAny(handler: (event: SessionEvent) => void): () => void {
    this.#wildcardEventHandlers.add(handler)
    return () => {
      this.#wildcardEventHandlers.delete(handler)
    }
  }

  onConnectionChange(handler: ConnectionHandler): () => void {
    this.#connectionHandlers.add(handler)
    // Replay current state so the subscriber renders immediately without
    // waiting for the next transition.
    handler(this.#state)
    return () => {
      this.#connectionHandlers.delete(handler)
    }
  }

  get state(): ConnectionState {
    return this.#state
  }

  /* ---------------- Internals ----------------------------------- */

  #openSocket(): void {
    if (this.#currentConnect === null) return
    const { url, auth } = this.#currentConnect
    const finalUrl = this.#withAuthQuery(url, auth?.token)
    this.#setState({ kind: "connecting", attempt: this.#attempt })

    let ws: WebSocketLike
    try {
      ws = new this.#wsCtor(
        finalUrl,
        auth?.subprotocols !== undefined && auth.subprotocols.length > 0
          ? auth.subprotocols
          : undefined,
      )
    } catch (err) {
      this.#log(
        "warn",
        `[SessionClient] WebSocket ctor threw — scheduling reconnect: ${String(
          err,
        )}`,
      )
      this.#scheduleReconnect("ctor_threw")
      return
    }
    this.#ws = ws

    ws.onopen = () => {
      this.#attempt = 0
      this.#setState({ kind: "connected" })
    }
    ws.onclose = (ev) => {
      this.#ws = null
      if (this.#intentionallyClosed) {
        this.#setState({ kind: "closed" })
        return
      }
      this.#scheduleReconnect(ev.reason || `close_${ev.code}`)
    }
    ws.onerror = () => {
      // We don't surface the error directly — the subsequent `onclose` will
      // schedule a reconnect with the close reason. Keeping this branch
      // empty matches Codex's WS adapter (errors are noisy in browsers).
    }
    ws.onmessage = (ev) => {
      this.#handleMessage(ev.data)
    }
  }

  #handleMessage(raw: unknown): void {
    const data = typeof raw === "string" ? raw : null
    if (data === null) {
      this.#log(
        "warn",
        "[SessionClient] dropping binary frame — only JSON text frames are supported",
      )
      return
    }
    const event = decodeEventFrame(data)
    if (event === null) {
      const kind = peekEnvelopeKind(data)
      if (kind !== "snapshot" && kind !== "rejected") {
        this.#log(
          "warn",
          `[SessionClient] dropping unrecognised frame (kind=${String(kind)})`,
        )
      }
      return
    }
    const typed = this.#eventHandlers.get(event.type)
    if (typed !== undefined) {
      for (const handler of [...typed]) {
        try {
          handler(event)
        } catch (err) {
          this.#log(
            "warn",
            `[SessionClient] event handler threw for type=${event.type}: ${String(
              err,
            )}`,
          )
        }
      }
    }
    for (const handler of [...this.#wildcardEventHandlers]) {
      try {
        handler(event)
      } catch (err) {
        this.#log(
          "warn",
          `[SessionClient] wildcard handler threw: ${String(err)}`,
        )
      }
    }
  }

  #scheduleReconnect(reason: string): void {
    this.#attempt += 1
    const retryInMs = computeRetryDelayMs(this.#attempt)
    this.#setState({
      kind: "disconnected",
      attempt: this.#attempt,
      retryInMs,
      reason,
    })
    if (this.#reconnectHandle !== null) {
      this.#clearTimer(this.#reconnectHandle)
    }
    this.#reconnectHandle = this.#setTimer(() => {
      this.#reconnectHandle = null
      if (this.#intentionallyClosed) return
      this.#openSocket()
    }, retryInMs)
  }

  #setState(next: ConnectionState): void {
    this.#state = next
    for (const handler of [...this.#connectionHandlers]) {
      try {
        handler(next)
      } catch (err) {
        this.#log(
          "warn",
          `[SessionClient] connection handler threw: ${String(err)}`,
        )
      }
    }
  }

  #withAuthQuery(url: string, token: string | undefined): string {
    if (token === undefined || token.length === 0) return url
    const sep = url.includes("?") ? "&" : "?"
    return `${url}${sep}token=${encodeURIComponent(token)}`
  }
}
