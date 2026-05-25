/**
 * Realtime slice — `RealtimePort` (ADR-0230).
 *
 * 8-method surface mirroring Codex Desktop's realtime WS API (Codex absorption).
 * Single closed-port for bidirectional voice/text streaming. Adapters are
 * private to the slice; consumers only ever see `RealtimePort`.
 *
 *   const rt = createBunWebSocketAdapter()        // or createHeadlessStub() in tests
 *   const c = await rt.connect({ endpoint, auth })
 *   if (!c.ok) renderErr(c.error)
 *   else {
 *     const unsub = rt.onMessage((m) => render(m))
 *     rt.audioStart("pcm")
 *     rt.send("hello")
 *     // ...
 *     unsub()
 *     await rt.close()
 *   }
 *
 * Plane-clean: imports only `@/shared`. Zero `@/agent` / `@/tool` / `@/llm`
 * / `@/permission` / `@/mcp` / `@/media` / `@/voice` — realtime is an I/O
 * primitive, not a tool, not a permission, not an LLM call.
 *
 * Contract:
 *   - NO-THROW: every method returns `Result<…>` for operational failures.
 *     Invalid input is also encoded as `Err` (HELL-RT-03, HELL-RT-06,
 *     HELL-RT-18).
 *   - 4-state lifecycle (`connecting → open → closing → closed`) queryable
 *     via `status()`. Pinned by HELL-RT-12.
 *   - AbortSignal cleanup: connect aborted mid-handshake closes the WS and
 *     transitions to `closed` (HELL-RT-10) — no zombie WS handles.
 *   - Idempotent guard: concurrent `connect` returns `already-connected`
 *     (HELL-RT-16). Post-close `send` returns `not-connected` (HELL-RT-11).
 *   - FIFO message order across `send` (HELL-RT-14). Binary frames pass
 *     through unchanged (HELL-RT-15).
 */

import type { Result } from "@/shared"
import type {
  AudioCodec,
  RealtimeConnectOpts,
  RealtimeError,
  RealtimeFrame,
  RealtimeInboundMessage,
  RealtimeStatus,
  SdpAnswer,
} from "./types"

/** Unsubscribe function returned by `onMessage`. Calling it removes the
 *  handler; calling it a second time is a no-op. */
export type RealtimeUnsubscribe = () => void

/** Inbound message handler. Surfaces render or log; the port never inspects
 *  the data. */
export type RealtimeMessageHandler = (msg: RealtimeInboundMessage) => void

export interface RealtimePort {
  /** Open the underlying WebSocket. Transitions `closed → connecting → open`.
   *  Concurrent invocations return `Err({kind:"already-connected"})`. The
   *  `signal` aborts mid-handshake; aborted connects cleanup the in-flight
   *  WS and end in `status()=closed`. */
  connect(opts: RealtimeConnectOpts): Promise<Result<void, RealtimeError>>

  /** Send a text or binary frame. Pre-connect or post-close returns
   *  `Err({kind:"not-connected"})`. Binary frames pass through unchanged. */
  send(data: RealtimeFrame): Result<void, RealtimeError>

  /** Subscribe to inbound frames. Returns an unsubscribe. Multiple
   *  subscribers are allowed; ordering is registration order. */
  onMessage(handler: RealtimeMessageHandler): RealtimeUnsubscribe

  /** Exchange an SDP offer for an SDP answer (text-level only). Empty
   *  offer → `Err({kind:"empty-sdp"})`. Missing required SDP lines →
   *  `Err({kind:"invalid-sdp"})`. The slice does NOT own the actual
   *  `RTCPeerConnection` — the surface uses the answer to build its own. */
  negotiate(sdpOffer: string): Promise<Result<SdpAnswer, RealtimeError>>

  /** Emit an outbound `{type:"audio.start", format}` signal on the open WS.
   *  Pre-connect returns `Err({kind:"not-connected"})`. Codec marker only;
   *  actual audio encode/decode is OUT-OF-SCOPE for this MVP. */
  audioStart(format: AudioCodec): Result<void, RealtimeError>

  /** Emit an outbound `{type:"audio.stop"}` signal on the open WS.
   *  Pre-connect returns `Err({kind:"not-connected"})`. */
  audioStop(): Result<void, RealtimeError>

  /** Graceful close. Transitions `open → closing → closed`. Idempotent —
   *  closing an already-closed port is `ok`. */
  close(code?: number, reason?: string): Promise<Result<void, RealtimeError>>

  /** Current lifecycle state. */
  status(): RealtimeStatus
}
