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

import type {
  AgentStateMessage,
  CanvasMessage,
  ConnectionState,
  ObservabilityMessage,
  SessionCommand,
  SessionEvent,
  SessionEventType,
  SessionRejectedFrame,
  SessionSnapshotLite,
} from "../types/protocol"
import {
  decodeAgentStateFrame,
  decodeCanvasFrame,
  decodeEventFrame,
  decodeObservabilityFrame,
  decodeRejectedFrame,
  decodeSnapshotFrame,
  encodeCommandFrame,
  encodeConnectFrame,
  peekEnvelopeKind,
  SESSION_PROTOCOL_VERSION,
} from "./envelope"
import { computeRetryDelayMs } from "./reconnect"

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
export type SnapshotHandler = (snapshot: SessionSnapshotLite) => void
export type ObservabilityHandler = (message: ObservabilityMessage) => void
export type CanvasHandler = (message: CanvasMessage) => void
export type AgentStateHandler = (message: AgentStateMessage) => void

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
const HANDSHAKE_DISCOVERY_SESSION_ID = "ui-session"

/* ------------------------------------------------------------------ */
/* Heartbeat / keepalive (comms hardening).                            */
/*                                                                     */
/* An idle WS path carries no frames, so a reverse proxy / load        */
/* balancer can silently drop the socket past its idle timeout without */
/* either side noticing. We send an app-level `heartbeat` ping on a    */
/* timer to keep the path warm; ANY inbound frame (the daemon's pong   */
/* OR a normal event) proves the socket is alive and resets a liveness */
/* deadline. If the deadline elapses with no frame, the socket is      */
/* declared dead and we fall through to the existing reconnect path.   */
/* ------------------------------------------------------------------ */

/** How often the client puts a keepalive ping on the wire. 25s sits */
/*  comfortably under the common 30–60s proxy idle timeout. */
export const HEARTBEAT_INTERVAL_MS = 25_000

/** After a ping, how long we wait for ANY frame before declaring the */
/*  socket dead. Generous (10s) so a slow round-trip never false-trips. */
export const HEARTBEAT_TIMEOUT_MS = 10_000

/** Pre-encoded keepalive ping frame — the SAME flat control envelope the */
/*  daemon answers with a `pong` (mirrors `encodeControlEnvelope` upstream */
/*  for `kind:"heartbeat"`). */
const HEARTBEAT_PING_FRAME = JSON.stringify({
  version: SESSION_PROTOCOL_VERSION,
  kind: "heartbeat",
  phase: "ping",
})

/** Best-effort: return a heartbeat frame's `phase`, or null if `raw` is not a
 *  heartbeat frame. NO-THROW — used to consume keepalive frames off the
 *  receive path before the per-kind decoders run. */
const peekHeartbeatPhase = (raw: string): "ping" | "pong" | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object") return null
  const rec = parsed as Record<string, unknown>
  if (rec.kind !== "heartbeat") return null
  return rec.phase === "ping" || rec.phase === "pong" ? rec.phase : null
}

/* ------------------------------------------------------------------ */
/* SessionClient                                                       */
/* ------------------------------------------------------------------ */

export class SessionClient {
  readonly #eventHandlers = new Map<SessionEventType, Set<EventHandler<SessionEventType>>>()
  readonly #wildcardEventHandlers = new Set<(event: SessionEvent) => void>()
  readonly #rejectedHandlers = new Set<(frame: SessionRejectedFrame) => void>()
  readonly #connectionHandlers = new Set<ConnectionHandler>()
  readonly #snapshotHandlers = new Set<SnapshotHandler>()
  readonly #observabilityHandlers = new Set<ObservabilityHandler>()
  readonly #canvasHandlers = new Set<CanvasHandler>()
  readonly #agentStateHandlers = new Set<AgentStateHandler>()
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
  /** Server-minted session id learned via connect-reject discovery or snapshot. */
  #sessionId: string | null = null
  /**
   * Highest `seq` observed across received events + snapshots — the resume
   * cursor. `null` until the first seq-bearing frame arrives. On RECONNECT the
   * handshake carries `resumeFromSeq = #lastSeq` so the daemon replays only the
   * events the socket missed. It survives reconnects (never reset on close) so
   * the gap can be computed; the daemon dedups by `eventId` on the client side.
   */
  #lastSeq: number | null = null
  /**
   * True between a RESUME handshake (a reconnect that carries `resumeFromSeq`)
   * and the first inbound frame that proves the handshake settled. On a resume
   * the daemon may reply with REPLAYED EVENTS ONLY (no snapshot) when the
   * resume cursor is still inside its replay window — and only a snapshot flips
   * us to `connected`. Without this flag an events-only resume would leave the
   * client stuck in `connecting`: the composer frozen, every command dropped by
   * `send()`'s `state.kind !== "connected"` guard. When set, the first resumed
   * event (or a snapshot, whichever lands first) promotes us to `connected`.
   * The FIRST connect (snapshot-driven, no `resumeFromSeq`) never sets it, so
   * that path stays byte-identical.
   */
  #resuming = false
  #lastSnapshot: SessionSnapshotLite | null = null
  #lastObservability: ObservabilityMessage | null = null
  /** Last canvas message, replayed to late `onCanvas` subscribers. */
  #lastCanvas: CanvasMessage | null = null
  /** Last agent-state message, replayed to late `onAgentState` subscribers. */
  #lastAgentState: AgentStateMessage | null = null
  /** Heartbeat timers (injectable seam). `#pingHandle` schedules the next */
  /*  keepalive ping; `#livenessHandle` is the deadline armed after a ping. */
  #pingHandle: unknown = null
  #livenessHandle: unknown = null
  readonly #sessionIdHandlers = new Set<(id: string) => void>()

  constructor(options: SessionClientOptions = {}) {
    const ctor =
      options.webSocketCtor ??
      (typeof globalThis !== "undefined" && "WebSocket" in (globalThis as Record<string, unknown>)
        ? ((globalThis as { WebSocket?: WebSocketCtor }).WebSocket as WebSocketCtor | undefined)
        : undefined)
    if (ctor === undefined) {
      throw new Error(
        "SessionClient: no WebSocket constructor available — pass `webSocketCtor` explicitly when running outside a browser.",
      )
    }
    this.#wsCtor = ctor
    this.#setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms) as unknown as number)
    this.#clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
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
      this.#log("warn", `[SessionClient] dropping command type=${command.type} — socket not open`)
      return
    }
    if (this.#state.kind !== "connected") {
      this.#log(
        "warn",
        `[SessionClient] dropping command type=${command.type} — handshake not ready`,
      )
      return
    }
    this.#ws.send(encodeCommandFrame(command))
  }

  /**
   * QUANTA_WEB_AGENT_STATE — answer (or cancel) a paused agent's
   * `request_user_input` prompt over the OUT-OF-BAND INBOUND channel (the mirror
   * of the agent-state OUTBOUND frames). This is NOT a `SessionCommand` — it
   * rides a raw JSON frame the daemon peeks BEFORE the session bridge, so the
   * kernel reducer never sees it. No-op if the socket is not open (the agent
   * will be cancelled by the daemon's `cancelAll()` on the eventual close).
   */
  sendPlanInputAnswer(
    promptId: string,
    outcome: { decision: "answer"; text: string } | { decision: "cancelled" },
  ): void {
    if (this.#ws === null || this.#ws.readyState !== READYSTATE_OPEN) {
      this.#log(
        "warn",
        `[SessionClient] dropping planInputAnswer promptId=${promptId} — socket not open`,
      )
      return
    }
    const frame =
      outcome.decision === "answer"
        ? { kind: "planInputAnswer", promptId, decision: "answer", text: outcome.text }
        : { kind: "planInputAnswer", promptId, decision: "cancelled" }
    try {
      this.#ws.send(JSON.stringify(frame))
    } catch (err) {
      this.#log("warn", `[SessionClient] planInputAnswer send failed: ${String(err)}`)
    }
  }

  /** Last server-minted session id, or `null` until the handshake settles. */
  get sessionId(): string | null {
    return this.#sessionId
  }

  /**
   * Highest `seq` observed (events + snapshots), or `null` if nothing seq-bearing
   * has arrived yet. This is the resume cursor sent on reconnect.
   */
  get lastSeq(): number | null {
    return this.#lastSeq
  }

  /** Subscribe to sessionId discovery — fires once per learned id. */
  onSessionId(handler: (id: string) => void): () => void {
    this.#sessionIdHandlers.add(handler)
    if (this.#sessionId !== null) {
      try {
        handler(this.#sessionId)
      } catch {
        // swallow — surface to console via #log instead
      }
    }
    return () => {
      this.#sessionIdHandlers.delete(handler)
    }
  }

  /* ---------------- Subscriptions ------------------------------- */

  on<TType extends SessionEventType>(type: TType, handler: EventHandler<TType>): () => void {
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

  /**
   * Inject historical events into the same fanout path as live WS frames.
   * Used by transcript hydration after a page reload: the daemon's SQLite
   * thread store replies with the past `SessionEvent[]` and we replay them
   * through every typed + wildcard handler so the transcript reducer rebuilds
   * exactly as if the events had just arrived. Deduplication against any live
   * frames that overlap is the reducer's job (it tracks `eventId`).
   */
  replayEvents(events: readonly SessionEvent[]): void {
    for (const event of events) {
      this.#fanoutEvent(event)
    }
  }

  onRejected(handler: (frame: SessionRejectedFrame) => void): () => void {
    this.#rejectedHandlers.add(handler)
    return () => {
      this.#rejectedHandlers.delete(handler)
    }
  }

  onSnapshot(handler: SnapshotHandler): () => void {
    this.#snapshotHandlers.add(handler)
    if (this.#lastSnapshot !== null) {
      try {
        handler(this.#lastSnapshot)
      } catch {
        // swallow — surface to console via #log instead
      }
    }
    return () => {
      this.#snapshotHandlers.delete(handler)
    }
  }

  onObservability(handler: ObservabilityHandler): () => void {
    this.#observabilityHandlers.add(handler)
    if (this.#lastObservability !== null) {
      try {
        handler(this.#lastObservability)
      } catch {
        // swallow — surface to console via #log instead
      }
    }
    return () => {
      this.#observabilityHandlers.delete(handler)
    }
  }

  /**
   * Subscribe to canvas channel frames (`tool.diff` / `context.usage`,
   * ADR-0440). Mirrors {@link onObservability}: the last canvas message is
   * replayed to a late subscriber so a freshly-mounted panel renders without
   * waiting for the next frame. These frames ONLY arrive when the daemon's
   * canvas sink is gated ON (`QUANTA_WEB_CANVAS=1`) — absent that, no frame is
   * ever decoded and every subscriber stays idle (chat UI unchanged).
   */
  onCanvas(handler: CanvasHandler): () => void {
    this.#canvasHandlers.add(handler)
    if (this.#lastCanvas !== null) {
      try {
        handler(this.#lastCanvas)
      } catch {
        // swallow — surface to console via #log instead
      }
    }
    return () => {
      this.#canvasHandlers.delete(handler)
    }
  }

  /**
   * Subscribe to agent-state channel frames (`plan.*` / `mode.changed` /
   * `tool.progress` / `context.compacted` / `ratelimit.snapshot`,
   * QUANTA_WEB_AGENT_STATE). Mirrors {@link onCanvas}: the last agent-state
   * message is replayed to a late subscriber so a freshly-mounted panel renders
   * without waiting for the next frame. These frames ONLY arrive when the
   * daemon's agent-state sink is gated ON (`QUANTA_WEB_AGENT_STATE=1`) — absent
   * that, no frame is ever decoded and every subscriber stays idle (chat UI
   * unchanged).
   */
  onAgentState(handler: AgentStateHandler): () => void {
    this.#agentStateHandlers.add(handler)
    if (this.#lastAgentState !== null) {
      try {
        handler(this.#lastAgentState)
      } catch {
        // swallow — surface to console via #log instead
      }
    }
    return () => {
      this.#agentStateHandlers.delete(handler)
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
        `[SessionClient] WebSocket ctor threw — scheduling reconnect: ${String(err)}`,
      )
      this.#scheduleReconnect("ctor_threw")
      return
    }
    this.#ws = ws

    ws.onopen = () => {
      this.#attempt = 0
      // The server requires a `connect` handshake before any command frame
      // is accepted. Until we know the canonical session id we send a
      // non-empty discovery sentinel; the daemon rejects it with the real
      // session id and we immediately retry with that value.
      //
      // Resume-on-reconnect: if this socket already knows the canonical
      // session id AND we have observed a seq from a prior connection, send
      // `resumeFromSeq` so the daemon replays only the events we missed during
      // the drop. The FIRST connect (discovery sentinel, no seq yet) omits it
      // ⇒ the daemon sends a full snapshot ⇒ byte-identical to the legacy path.
      try {
        ws.send(this.#buildConnectFrame())
      } catch (err) {
        this.#log("warn", `[SessionClient] connect frame failed: ${String(err)}`)
      }
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
    // ANY inbound frame proves the socket is alive → reset the liveness
    // deadline. The daemon's `pong` is the common case, but a normal event
    // frame is equally valid evidence (and means we needn't wait on a pong).
    // This MUST run before the binary-drop early return below: a non-text
    // frame the client can't decode is still traffic on the wire and must not
    // false-trip the deadline ("ANY inbound frame keeps alive").
    this.#resetLiveness()
    const data = typeof raw === "string" ? raw : null
    if (data === null) {
      this.#log(
        "warn",
        "[SessionClient] dropping binary frame — only JSON text frames are supported",
      )
      return
    }
    // A heartbeat frame is connection-level bookkeeping; the liveness reset
    // above is its entire effect on the client. Consume it here so it never
    // reaches the per-kind decoders below (which would log it as unrecognised).
    const heartbeatPhase = peekHeartbeatPhase(data)
    if (heartbeatPhase !== null) return
    const canvas = decodeCanvasFrame(data)
    if (canvas !== null) {
      this.#lastCanvas = canvas
      // A replayed canvas frame proves the resume handshake settled (see
      // {@link #settleResume}) — otherwise an events-only resume that leads with
      // a canvas frame would stay stuck in `connecting`.
      this.#settleResume()
      for (const handler of [...this.#canvasHandlers]) {
        try {
          handler(canvas)
        } catch (err) {
          this.#log("warn", `[SessionClient] canvas handler threw: ${String(err)}`)
        }
      }
      return
    }
    const agentState = decodeAgentStateFrame(data)
    if (agentState !== null) {
      this.#lastAgentState = agentState
      // A replayed agent-state frame likewise settles an events-only resume
      // (mirrors the canvas branch above).
      this.#settleResume()
      for (const handler of [...this.#agentStateHandlers]) {
        try {
          handler(agentState)
        } catch (err) {
          this.#log("warn", `[SessionClient] agent-state handler threw: ${String(err)}`)
        }
      }
      return
    }
    const rejected = decodeRejectedFrame(data)
    if (rejected !== null) {
      if (
        rejected.target === "connect" &&
        rejected.sessionId !== undefined &&
        rejected.sessionId.length > 0 &&
        this.#sessionId !== rejected.sessionId
      ) {
        this.#adoptSessionId(rejected.sessionId)
        if (this.#ws !== null && this.#ws.readyState === READYSTATE_OPEN) {
          try {
            // Re-handshake with the canonical id. Carry the resume cursor if we
            // already have one (a reconnect that re-discovers the id); the
            // bootstrap discovery on a fresh session has no seq yet ⇒ omitted.
            this.#ws.send(this.#buildConnectFrame(rejected.sessionId))
          } catch (err) {
            this.#log("warn", `[SessionClient] connect-retry failed: ${String(err)}`)
          }
        }
      }
      if (rejected.target === "command") {
        for (const handler of [...this.#rejectedHandlers]) {
          try {
            handler(rejected)
          } catch (err) {
            this.#log("warn", `[SessionClient] rejected handler threw: ${String(err)}`)
          }
        }
      }
      return
    }
    const snapshot = decodeSnapshotFrame(data)
    if (snapshot !== null) {
      this.#lastSnapshot = snapshot
      this.#trackSeq(snapshot.seq)
      if (this.#sessionId === null || this.#sessionId !== snapshot.sessionId) {
        this.#adoptSessionId(snapshot.sessionId)
      }
      // A snapshot settles the handshake on either path (first-connect OR the
      // resume fallback where the daemon sent a full snapshot). Clear the
      // resume flag so a later event doesn't redundantly re-promote state.
      this.#resuming = false
      this.#setState({ kind: "connected" })
      for (const handler of [...this.#snapshotHandlers]) {
        try {
          handler(snapshot)
        } catch (err) {
          this.#log("warn", `[SessionClient] snapshot handler threw: ${String(err)}`)
        }
      }
      return
    }
    const observability = decodeObservabilityFrame(data)
    if (observability !== null) {
      this.#lastObservability = observability
      // A replayed observability frame likewise settles an events-only resume.
      this.#settleResume()
      for (const handler of [...this.#observabilityHandlers]) {
        try {
          handler(observability)
        } catch (err) {
          this.#log("warn", `[SessionClient] observability handler threw: ${String(err)}`)
        }
      }
      return
    }
    const event = decodeEventFrame(data)
    if (event === null) {
      const kind = peekEnvelopeKind(data)
      if (
        kind !== "snapshot" &&
        kind !== "rejected" &&
        kind !== "observability" &&
        kind !== "canvas" &&
        kind !== "agentState" &&
        kind !== "heartbeat"
      ) {
        this.#log("warn", `[SessionClient] dropping unrecognised frame (kind=${String(kind)})`)
      }
      return
    }
    // Events-only resume: the daemon replayed missed events without a snapshot.
    // The first replayed frame proves the resume handshake settled → flip to
    // `connected` so the composer unfreezes and `send()` stops dropping commands.
    this.#settleResume()
    this.#fanoutEvent(event)
  }

  /** Settle an events-only resume: ANY replayed data frame (event / canvas /
   *  observability) proves the handshake completed, so flip `connecting` →
   *  `connected`. Snapshot-driven first-connect already flips inline (flag never
   *  set), and a re-connect rejection re-handshakes WITHOUT settling. Idempotent. */
  #settleResume(): void {
    if (this.#resuming) {
      this.#resuming = false
      this.#setState({ kind: "connected" })
    }
  }

  /** Advance the resume cursor to the max seq seen — never lowers it. */
  #trackSeq(seq: number): void {
    if (!Number.isFinite(seq)) return
    this.#lastSeq = this.#lastSeq === null ? seq : Math.max(this.#lastSeq, seq)
  }

  #fanoutEvent(event: SessionEvent): void {
    this.#trackSeq(event.seq)
    const typed = this.#eventHandlers.get(event.type)
    if (typed !== undefined) {
      for (const handler of [...typed]) {
        try {
          handler(event)
        } catch (err) {
          this.#log(
            "warn",
            `[SessionClient] event handler threw for type=${event.type}: ${String(err)}`,
          )
        }
      }
    }
    for (const handler of [...this.#wildcardEventHandlers]) {
      try {
        handler(event)
      } catch (err) {
        this.#log("warn", `[SessionClient] wildcard handler threw: ${String(err)}`)
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
    // Keepalive runs ONLY while connected. Entering `connected` arms the ping
    // timer; any other transition (connecting / disconnected / closed) tears
    // it down so we never ping a dead socket nor leak a timer across reconnect.
    if (next.kind === "connected") this.#startHeartbeat()
    else this.#stopHeartbeat()
    for (const handler of [...this.#connectionHandlers]) {
      try {
        handler(next)
      } catch (err) {
        this.#log("warn", `[SessionClient] connection handler threw: ${String(err)}`)
      }
    }
  }

  /* ---------------- Heartbeat / keepalive ----------------------- */

  /** Arm (or re-arm) the next keepalive ping. Idempotent — clears any pending
   *  ping handle first so re-entry (e.g. a snapshot resync that re-sets the
   *  `connected` state) never stacks two ping timers. */
  #startHeartbeat(): void {
    if (this.#pingHandle !== null) this.#clearTimer(this.#pingHandle)
    this.#pingHandle = this.#setTimer(() => {
      this.#pingHandle = null
      this.#sendPing()
    }, HEARTBEAT_INTERVAL_MS)
  }

  /** Send a keepalive ping and arm the liveness deadline. If the deadline fires
   *  before ANY frame resets it (see {@link resetLiveness} in #handleMessage),
   *  the socket is declared dead and we force the existing reconnect path. */
  #sendPing(): void {
    if (this.#ws === null || this.#ws.readyState !== READYSTATE_OPEN) return
    try {
      this.#ws.send(HEARTBEAT_PING_FRAME)
    } catch (err) {
      this.#log("warn", `[SessionClient] heartbeat ping failed: ${String(err)}`)
    }
    if (this.#livenessHandle !== null) this.#clearTimer(this.#livenessHandle)
    this.#livenessHandle = this.#setTimer(() => {
      this.#livenessHandle = null
      this.#onLivenessTimeout()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  /** Any inbound frame proves the socket is alive: clear the liveness deadline
   *  and schedule the next ping. No-op when no deadline is pending. */
  #resetLiveness(): void {
    if (this.#livenessHandle === null) return
    this.#clearTimer(this.#livenessHandle)
    this.#livenessHandle = null
    // Liveness proven → schedule the next keepalive ping.
    this.#startHeartbeat()
  }

  /** The liveness deadline elapsed with no frame → the socket is dead. We own
   *  the reconnect here (single source): detach the dead socket's `onclose`
   *  BEFORE closing it so its async close event cannot schedule a SECOND
   *  reconnect (which would double-bump the attempt/backoff). Then close it and
   *  drive the reconnect ourselves — matching how `disconnect()` self-drives. */
  #onLivenessTimeout(): void {
    this.#stopHeartbeat()
    const ws = this.#ws
    this.#ws = null
    if (ws !== null) {
      // Neutralise the socket's lifecycle callbacks so a late close/message
      // from this dead socket cannot perturb the fresh reconnect.
      ws.onclose = null
      ws.onmessage = null
      ws.onerror = null
      try {
        ws.close(4000, "heartbeat_timeout")
      } catch {
        // ignore — some engines throw closing a half-dead socket
      }
    }
    if (this.#intentionallyClosed) return
    this.#scheduleReconnect("heartbeat_timeout")
  }

  /** Stop all keepalive timers. Idempotent. */
  #stopHeartbeat(): void {
    if (this.#pingHandle !== null) {
      this.#clearTimer(this.#pingHandle)
      this.#pingHandle = null
    }
    if (this.#livenessHandle !== null) {
      this.#clearTimer(this.#livenessHandle)
      this.#livenessHandle = null
    }
  }

  #withAuthQuery(url: string, token: string | undefined): string {
    if (token === undefined || token.length === 0) return url
    const sep = url.includes("?") ? "&" : "?"
    return `${url}${sep}token=${encodeURIComponent(token)}`
  }

  /**
   * Build the `connect` handshake frame. Carries `resumeFromSeq` only when we
   * handshake with the canonical (server-minted) session id AND have a resume
   * cursor — i.e. a reconnect after events were seen. The discovery-sentinel
   * bootstrap (`#sessionId === null`) never resumes: the daemon rejects the
   * sentinel before any replay, so resuming there is meaningless and would
   * diverge from the byte-identical first-connect path.
   */
  #buildConnectFrame(explicitSessionId?: string): string {
    const sessionId = explicitSessionId ?? this.#sessionId ?? HANDSHAKE_DISCOVERY_SESSION_ID
    const isCanonical = sessionId !== HANDSHAKE_DISCOVERY_SESSION_ID
    if (isCanonical && this.#lastSeq !== null) {
      // This is a RESUME handshake: the daemon may reply with events-only (no
      // snapshot). Arm the resume flag so the first inbound event promotes us
      // to `connected` even when no snapshot arrives (see {@link #resuming}).
      this.#resuming = true
      return encodeConnectFrame(sessionId, this.#lastSeq)
    }
    return encodeConnectFrame(sessionId)
  }

  #adoptSessionId(sessionId: string): void {
    this.#sessionId = sessionId
    for (const handler of [...this.#sessionIdHandlers]) {
      try {
        handler(sessionId)
      } catch (err) {
        this.#log("warn", `[SessionClient] sessionId handler threw: ${String(err)}`)
      }
    }
  }
}
