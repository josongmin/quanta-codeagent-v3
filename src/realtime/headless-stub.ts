/**
 * Realtime slice — headless stub adapter (ADR-0230).
 *
 * Fully deterministic in-memory `RealtimePort` for tests. No real
 * WebSocket. Surfaces inject mock inbound frames via `inject()` and
 * assert what the port sent outbound via `outbound()`.
 *
 *   const stub = createHeadlessStub()
 *   await stub.port.connect({ endpoint: "ws://test" })
 *   stub.inject({ kind: "text", data: "hi" })   // → onMessage handlers fire
 *   stub.port.send("ping")                       // → recorded in outbound()
 *   expect(stub.outbound()).toEqual([{ kind: "text", data: "ping" }])
 *
 * Determinism: nothing in the stub touches time, randomness, or I/O. Same
 * sequence of method calls → same outbound + same onMessage fire order.
 * Pinned by HELL-RT-13.
 *
 * Plane-clean: imports only `@/shared` + sibling files.
 */

import { err, ok, type Result } from "@/shared"
import type { RealtimePort, RealtimeUnsubscribe } from "./port"
import { negotiateSdp } from "./sdp-negotiator"
import type {
  AudioCodec,
  RealtimeConnectOpts,
  RealtimeError,
  RealtimeFrame,
  RealtimeInboundMessage,
  RealtimeStatus,
  SdpAnswer,
} from "./types"

/** Recorded outbound message — text/binary or one of the typed signals. */
export type StubOutbound =
  | { readonly kind: "text"; readonly data: string }
  | { readonly kind: "binary"; readonly data: Uint8Array }
  | { readonly kind: "audio-start"; readonly format: AudioCodec }
  | { readonly kind: "audio-stop" }

export interface HeadlessStubOpts {
  /** When set, `connect()` returns this error instead of opening. Used to
   *  simulate auth failures (HELL-RT-02). */
  readonly forceConnectError?: RealtimeError
  /** When set, `connect()` resolves only after this many `await Promise.resolve()`
   *  microtasks — gives tests room to abort mid-handshake (HELL-RT-10). */
  readonly connectMicrotaskDelay?: number
}

export interface HeadlessStubHandle {
  readonly port: RealtimePort
  /** Push an inbound frame — every registered onMessage handler fires in
   *  registration order. Returns the number of handlers that received it. */
  inject(msg: RealtimeInboundMessage): number
  /** Snapshot of outbound messages in send order. */
  outbound(): readonly StubOutbound[]
  /** Reset outbound log; lifecycle is preserved. */
  clearOutbound(): void
  /** Force a server-side close — transitions to `closed`. Subsequent
   *  injects are dropped. Tests use this to simulate a remote disconnect. */
  forceClose(): void
}

/**
 * Build a fresh headless stub. Each call returns an independent handle.
 *
 * The stub enforces the same invariants as the real adapter:
 *   - `send` pre-connect / post-close → `Err({kind:"not-connected"})`
 *   - concurrent `connect` → `Err({kind:"already-connected"})` on the
 *     second call (HELL-RT-16)
 *   - AbortSignal aborted before connect resolves → `Err({kind:"aborted"})`
 *     and lifecycle returns to `closed` (HELL-RT-10)
 */
export const createHeadlessStub = (opts?: HeadlessStubOpts): HeadlessStubHandle => {
  let status: RealtimeStatus = "closed"
  const handlers: Array<(msg: RealtimeInboundMessage) => void> = []
  const outboundLog: StubOutbound[] = []
  let connectInFlight = false
  let forcedClosed = false

  const ensureOpen = (): Result<void, RealtimeError> =>
    status === "open" ? ok(undefined) : err({ kind: "not-connected" })

  const port: RealtimePort = {
    async connect(connectOpts: RealtimeConnectOpts): Promise<Result<void, RealtimeError>> {
      if (status === "open" || status === "connecting" || connectInFlight) {
        return err({ kind: "already-connected" })
      }
      connectInFlight = true
      status = "connecting"

      // Pre-abort check — surface aborted before we even start.
      if (connectOpts.signal?.aborted) {
        status = "closed"
        connectInFlight = false
        return err({ kind: "aborted" })
      }

      const delay = opts?.connectMicrotaskDelay ?? 0
      for (let i = 0; i < delay; i++) {
        // Sequential microtask yields are intentional — each tick is an abort-race
        // checkpoint; parallelizing would defeat the AbortSignal seam.
        await Promise.resolve()
        if (connectOpts.signal?.aborted) {
          status = "closed"
          connectInFlight = false
          return err({ kind: "aborted" })
        }
      }

      if (opts?.forceConnectError) {
        status = "closed"
        connectInFlight = false
        return err(opts.forceConnectError)
      }

      status = "open"
      connectInFlight = false
      return ok(undefined)
    },

    send(data: RealtimeFrame): Result<void, RealtimeError> {
      const guard = ensureOpen()
      if (!guard.ok) return guard
      if (typeof data === "string") {
        outboundLog.push({ kind: "text", data })
      } else {
        // Defensive copy — surfaces that mutate the buffer after send shouldn't
        // corrupt the recorded log.
        outboundLog.push({ kind: "binary", data: new Uint8Array(data) })
      }
      return ok(undefined)
    },

    onMessage(handler): RealtimeUnsubscribe {
      handlers.push(handler)
      let active = true
      return () => {
        if (!active) return
        active = false
        const idx = handlers.indexOf(handler)
        if (idx >= 0) handlers.splice(idx, 1)
      }
    },

    async negotiate(sdpOffer: string): Promise<Result<SdpAnswer, RealtimeError>> {
      return negotiateSdp(sdpOffer)
    },

    audioStart(format: AudioCodec): Result<void, RealtimeError> {
      const guard = ensureOpen()
      if (!guard.ok) return guard
      outboundLog.push({ kind: "audio-start", format })
      return ok(undefined)
    },

    audioStop(): Result<void, RealtimeError> {
      const guard = ensureOpen()
      if (!guard.ok) return guard
      outboundLog.push({ kind: "audio-stop" })
      return ok(undefined)
    },

    async close(_code?: number, _reason?: string): Promise<Result<void, RealtimeError>> {
      if (status === "closed") return ok(undefined)
      status = "closing"
      // No real I/O; the close completes in the next microtask.
      await Promise.resolve()
      status = "closed"
      return ok(undefined)
    },

    status(): RealtimeStatus {
      return status
    },
  }

  return {
    port,
    inject(msg: RealtimeInboundMessage): number {
      if (forcedClosed || status !== "open") return 0
      // Snapshot handlers — unsubscribes during fire shouldn't skip pending.
      const snapshot = handlers.slice()
      for (const h of snapshot) h(msg)
      return snapshot.length
    },
    outbound(): readonly StubOutbound[] {
      return outboundLog.slice()
    },
    clearOutbound(): void {
      outboundLog.length = 0
    },
    forceClose(): void {
      forcedClosed = true
      status = "closed"
    },
  }
}
