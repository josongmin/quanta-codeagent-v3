/**
 * Realtime slice — default adapter (ADR-0230).
 *
 * Bun-native `globalThis.WebSocket` wrapper implementing `RealtimePort`.
 * Zero external dependency — Bun ships WebSocket as a web-standard global.
 * If Node-only support is ever needed, the adapter swap is one line at the
 * factory (`new WebSocket(...)` → `new (require("ws"))(...)`).
 *
 * Why Bun-native:
 *   - install gate blocks `ws` package.
 *   - Bun's WebSocket is spec-compliant; the test environment runs Bun.
 *   - The factory shape lets callers swap by passing their own
 *     `webSocketCtor` (HELL-RT-02 / HELL-RT-04 / HELL-RT-15 use this for
 *     deterministic tests without real sockets).
 *
 * The adapter owns:
 *   - 4-state lifecycle (`connecting → open → closing → closed`).
 *   - subscriber list for `onMessage` (multiple handlers; ordering preserved).
 *   - outbound queue is a NOOP — the underlying WebSocket buffers on its own.
 *     Backpressure-aware send is a follow-up.
 *   - AbortSignal cleanup: aborting mid-handshake calls `ws.close()` and
 *     resolves the connect promise with `Err({kind:"aborted"})`.
 *
 * Plane-clean: imports only `@/shared` + sibling files.
 */

import { dispatchNoThrow, err, errMessage, notifyAllNoThrow, ok, type Result } from "@/shared"
import type { RealtimePort, RealtimeUnsubscribe } from "./port"
import { negotiateSdp } from "./sdp-negotiator"
import type {
  AudioCodec,
  RealtimeConnectOpts,
  RealtimeError,
  RealtimeFrame,
  RealtimeInboundMessage,
  RealtimeOutboundSignal,
  RealtimeStatus,
  SdpAnswer,
  VoiceInfo,
} from "./types"

/** §6.5 — server voices query. The minimal MVP WS has no built-in voices RPC,
 *  so a surface that needs the voice list injects this provider (e.g. an HTTPS
 *  GET to the provider's `/voices` endpoint). NO-THROW expected — a thrown
 *  provider is mapped to a typed `io-error` by the adapter. */
export type VoicesProvider = (
  signal?: AbortSignal,
) => Promise<Result<readonly VoiceInfo[], RealtimeError>>

/**
 * Minimal WebSocket-like surface — matches `globalThis.WebSocket` shape so
 * tests can inject a stub ctor without dragging in `ws` types.
 */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string | ArrayBufferView | ArrayBuffer): void
  close(code?: number, reason?: string): void
  onopen: ((this: WebSocketLike, ev: unknown) => void) | null
  onmessage: ((this: WebSocketLike, ev: { data: unknown }) => void) | null
  onclose: ((this: WebSocketLike, ev: { code: number; reason: string }) => void) | null
  onerror: ((this: WebSocketLike, ev: unknown) => void) | null
}

/** Constructor injection seam — tests pass a fake to drive deterministic
 *  open/message/error/close events without opening a real socket. */
export type WebSocketCtor = (url: string, protocols?: readonly string[]) => WebSocketLike

export interface BunAdapterOpts {
  /** Inject a WebSocket constructor (defaults to `globalThis.WebSocket`).
   *  Test code passes a stub here for HELL-RT-02 / HELL-RT-04 / HELL-RT-15. */
  readonly webSocketCtor?: WebSocketCtor
  /** §6.5 — optional server-voices provider. Absent ⇒ `listVoices()` returns
   *  `Err({kind:"voices-unsupported"})` (byte-identical to pre-§6.5: the
   *  default MVP adapter has no voices RPC). */
  readonly voicesProvider?: VoicesProvider
}

/** WebSocket readyState constants — mirror the web spec since we don't
 *  rely on the global `WebSocket` constants existing at module-load time. */
const WS_CONNECTING = 0
const WS_OPEN = 1
const WS_CLOSING = 2
// const WS_CLOSED = 3  // unused — we read .readyState in lifecycle transitions

const defaultCtor: WebSocketCtor = (url, protocols) => {
  // globalThis.WebSocket is the Bun-native / browser-native constructor.
  // We type-assert through `unknown` to avoid pulling DOM lib into tsconfig.
  const Ctor = (
    globalThis as { WebSocket?: new (url: string, protocols?: readonly string[]) => WebSocketLike }
  ).WebSocket
  if (!Ctor) {
    throw new Error("WebSocket is not available in this runtime")
  }
  return new Ctor(url, protocols)
}

/**
 * By-reference mutable state for the adapter. `status` and `ws` are
 * REASSIGNED (not just mutated) across method bodies, so the helpers thread
 * this box and mutate its fields in place — preserving the single-closure
 * semantics of the original factory verbatim.
 */
interface AdapterState {
  status: RealtimeStatus
  ws: WebSocketLike | null
  readonly handlers: Array<(msg: RealtimeInboundMessage) => void>
}

const ensureOpen = (state: AdapterState): Result<void, RealtimeError> =>
  state.status === "open" && state.ws !== null && state.ws.readyState === WS_OPEN
    ? ok(undefined)
    : err({ kind: "not-connected" })

const sendSignal = (
  state: AdapterState,
  signal: RealtimeOutboundSignal,
): Result<void, RealtimeError> => {
  const guard = ensureOpen(state)
  if (!guard.ok) return guard
  try {
    state.ws?.send(JSON.stringify(signal))
    return ok(undefined)
  } catch (e) {
    return err({
      kind: "io-error",
      degradeReason: errMessage(e),
    })
  }
}

const dispatchInbound = (state: AdapterState, data: unknown): void => {
  let msg: RealtimeInboundMessage
  if (typeof data === "string") {
    msg = { kind: "text", data }
  } else if (data instanceof Uint8Array) {
    msg = { kind: "binary", data }
  } else if (data instanceof ArrayBuffer) {
    msg = { kind: "binary", data: new Uint8Array(data) }
  } else if (ArrayBuffer.isView(data)) {
    msg = { kind: "binary", data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
  } else {
    // Unknown frame shape — drop silently; the spec only emits string or
    // binary. Logging would require @/observability which violates plane-clean.
    return
  }
  // L6 H8: isolate sibling subscribers — a single throwing handler must not
  // starve the rest of the fan-out. `notifyAllNoThrow` snapshots-safe (we
  // already `.slice()` so concurrent unsubscribe during dispatch is safe) and
  // swallows each handler's throw independently (matches the documented
  // isolation contract `event-bridge.ts` / `ws-adapter.ts` already honour).
  notifyAllNoThrow(state.handlers.slice(), undefined, msg)
}

const detachSocket = (state: AdapterState): void => {
  if (!state.ws) return
  state.ws.onopen = null
  state.ws.onmessage = null
  state.ws.onclose = null
  state.ws.onerror = null
  state.ws = null
}

const connectAdapter = async (
  state: AdapterState,
  ctor: WebSocketCtor,
  connectOpts: RealtimeConnectOpts,
): Promise<Result<void, RealtimeError>> => {
  if (state.status !== "closed") return err({ kind: "already-connected" })

  if (connectOpts.signal?.aborted) {
    return err({ kind: "aborted" })
  }

  state.status = "connecting"

  // Pass auth as a subprotocol prefix — the Bun/spec WebSocket constructor
  // doesn't accept custom headers, but subprotocols are echoed by the
  // server. Surfaces that need Bearer header semantics use a different
  // adapter (e.g. an HTTPS upgrade with fetch + manual upgrade).
  const protocols = connectOpts.auth ? [`bearer.${connectOpts.auth}`] : undefined

  let socket: WebSocketLike
  try {
    socket = ctor(connectOpts.endpoint, protocols)
  } catch (e) {
    state.status = "closed"
    return err({
      kind: "connect-failed",
      degradeReason: errMessage(e),
    })
  }
  state.ws = socket

  return await new Promise<Result<void, RealtimeError>>((resolve) => {
    let settled = false
    const finish = (result: Result<void, RealtimeError>): void => {
      if (settled) return
      settled = true
      if (connectOpts.signal) {
        connectOpts.signal.removeEventListener("abort", onAbort)
      }
      resolve(result)
    }

    const onAbort = (): void => {
      if (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN) {
        try {
          socket.close()
        } catch {
          // ignore — already-closed throws are not actionable
        }
      }
      state.status = "closed"
      detachSocket(state)
      finish(err({ kind: "aborted" }))
    }

    if (connectOpts.signal) {
      connectOpts.signal.addEventListener("abort", onAbort, { once: true })
    }

    socket.onopen = (): void => {
      state.status = "open"
      finish(ok(undefined))
    }

    socket.onerror = (ev: unknown): void => {
      state.status = "closed"
      detachSocket(state)
      // Auth failures surface as error events on most server impls; the
      // close event that follows carries the actual code. We classify
      // the FIRST error as connect-failed since onclose will arrive
      // after we've already settled.
      const evObj = ev as { message?: unknown } | null
      const reason = evObj && typeof evObj.message === "string" ? evObj.message : "websocket error"
      finish(err({ kind: "connect-failed", degradeReason: reason }))
    }

    socket.onmessage = (ev): void => {
      dispatchInbound(state, ev.data)
    }

    socket.onclose = (ev): void => {
      // 1008 = policy violation (auth typical), 4401 = our convention
      // for unauthorized. Surfaces that need precise mapping inspect
      // their own server's codes.
      if (!settled) {
        state.status = "closed"
        detachSocket(state)
        const authLike = ev.code === 1008 || ev.code === 4401 || ev.code === 4403
        if (authLike) {
          finish(err({ kind: "auth-failed", degradeReason: ev.reason || `code ${ev.code}` }))
        } else {
          finish(err({ kind: "connect-failed", degradeReason: ev.reason || `code ${ev.code}` }))
        }
        return
      }
      state.status = "closed"
      detachSocket(state)
    }
  })
}

const closeAdapter = async (
  state: AdapterState,
  code?: number,
  reason?: string,
): Promise<Result<void, RealtimeError>> => {
  // L6 C1: the guard MUST also cover `"closing"`. A second close() entering
  // while the first is mid-flight previously fell through to the
  // already-closed path below and resolved ONLY itself — leaving the first
  // close promise hung forever (port.ts:87 idempotency violation). Treat a
  // re-entrant close as a clean idempotent ok; the in-flight close drives
  // the single onclose teardown.
  if (state.status === "closed" || state.status === "closing" || !state.ws) {
    return ok(undefined)
  }
  state.status = "closing"
  const socket = state.ws
  return await new Promise<Result<void, RealtimeError>>((resolve) => {
    const prevOnClose = socket.onclose
    socket.onclose = (ev: { code: number; reason: string }): void => {
      state.status = "closed"
      detachSocket(state)
      // L6 H7: a throwing chained handler must NOT skip the resolve() and
      // strand the close promise. Route it through the no-throw dispatcher.
      dispatchNoThrow(prevOnClose ? () => prevOnClose.call(socket, ev) : undefined)
      resolve(ok(undefined))
    }
    try {
      if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) {
        socket.close(code, reason)
      }
      if (socket.readyState === WS_CLOSING) {
        // already closing — let onclose drive
        return
      }
      // already-closed path
      state.status = "closed"
      detachSocket(state)
      resolve(ok(undefined))
    } catch (e) {
      state.status = "closed"
      detachSocket(state)
      resolve(err({ kind: "io-error", degradeReason: errMessage(e) }))
    }
  })
}

const listVoicesAdapter = async (
  voicesProvider: VoicesProvider | undefined,
): Promise<Result<readonly VoiceInfo[], RealtimeError>> => {
  // §6.5 — no provider wired ⇒ the MVP WS has no voices RPC; degrade with a
  // typed `voices-unsupported` (byte-identical to pre-§6.5 behaviour).
  if (voicesProvider === undefined) return err({ kind: "voices-unsupported" })
  try {
    return await voicesProvider()
  } catch (e) {
    // NO-THROW boundary — a thrown provider maps to a typed io-error.
    return err({ kind: "io-error", degradeReason: errMessage(e) })
  }
}

const sendFrame = (state: AdapterState, data: RealtimeFrame): Result<void, RealtimeError> => {
  const guard = ensureOpen(state)
  if (!guard.ok) return guard
  try {
    if (typeof data === "string") {
      state.ws?.send(data)
    } else {
      // Defensive copy — surfaces that mutate the buffer after send shouldn't
      // corrupt the in-flight frame. The WS impl may or may not copy.
      state.ws?.send(new Uint8Array(data))
    }
    return ok(undefined)
  } catch (e) {
    return err({
      kind: "io-error",
      degradeReason: errMessage(e),
    })
  }
}

/**
 * Build a `RealtimePort` over Bun's native WebSocket.
 *
 * `connect()` returns a Promise that resolves on `open` or `error`.
 * Subsequent `connect()` while one is in-flight returns
 * `Err({kind:"already-connected"})`. `close()` is idempotent.
 */
export const createBunWebSocketAdapter = (opts?: BunAdapterOpts): RealtimePort => {
  const ctor = opts?.webSocketCtor ?? defaultCtor
  const voicesProvider = opts?.voicesProvider

  // By-reference state box: `connect`/`close` reassign `status`/`ws`; the
  // module-level helpers mutate these fields in place so the single-closure
  // lifecycle semantics are preserved verbatim.
  const state: AdapterState = { status: "closed", ws: null, handlers: [] }

  return {
    async connect(connectOpts: RealtimeConnectOpts): Promise<Result<void, RealtimeError>> {
      return connectAdapter(state, ctor, connectOpts)
    },

    send(data: RealtimeFrame): Result<void, RealtimeError> {
      return sendFrame(state, data)
    },

    onMessage(handler): RealtimeUnsubscribe {
      state.handlers.push(handler)
      let active = true
      return () => {
        if (!active) return
        active = false
        const idx = state.handlers.indexOf(handler)
        if (idx >= 0) state.handlers.splice(idx, 1)
      }
    },

    async negotiate(sdpOffer: string): Promise<Result<SdpAnswer, RealtimeError>> {
      return negotiateSdp(sdpOffer)
    },

    audioStart(format: AudioCodec): Result<void, RealtimeError> {
      return sendSignal(state, { type: "audio.start", format })
    },

    audioStop(): Result<void, RealtimeError> {
      return sendSignal(state, { type: "audio.stop" })
    },

    async listVoices(): Promise<Result<readonly VoiceInfo[], RealtimeError>> {
      return listVoicesAdapter(voicesProvider)
    },

    async close(code?: number, reason?: string): Promise<Result<void, RealtimeError>> {
      return closeAdapter(state, code, reason)
    },

    status(): RealtimeStatus {
      return state.status
    },
  }
}
