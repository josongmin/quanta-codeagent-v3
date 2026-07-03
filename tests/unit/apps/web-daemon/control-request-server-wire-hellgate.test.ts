/**
 * ★ HELLGATE — the SERVER-layer control-request wire (ADR-0496 A1).
 *
 * Proves the daemon's `message` handler PEEKS a `controlRequest` frame and
 * ENQUEUES it onto the wired port (consumed, NOT forwarded to the session
 * bridge) — and that with the gate OFF (no `controlRequestPorts`) the SAME frame
 * FALLS THROUGH to the adapter (byte-identical legacy). This closes the producer
 * gap at the transport seam that the port-level hellgate cannot reach.
 *
 * Invariants (red-on-injection):
 *   1. WIRED — a `controlRequest` frame ⇒ `handle.enqueue(req)` called, frame
 *      NOT pushed to the adapter (consumed at the connection layer).
 *   2. DEFAULT-OFF — no `controlRequestPorts` ⇒ the frame is pushed to the
 *      adapter (falls through to the session bridge, byte-identical).
 *   3. NON-MATCH — a non-controlRequest frame is pushed to the adapter even when
 *      the port IS wired (only the matching envelope is consumed).
 */

import { describe, expect, test } from "bun:test"
import type { ServerWebSocket } from "bun"
import type { ControlRequest } from "@/agent/control-request"
import type { ControlRequestPorts, WebDaemonServerConfig } from "@/apps/web-daemon/server"
import type { WSData } from "@/apps/web-daemon/server/ws-data"
import { buildWebSocketHandlers } from "@/apps/web-daemon/server/ws-handlers"
import type { WebControlRequestPortHandle } from "@/apps/web-daemon/web-control-request-port"

const frame = (request: unknown): string => JSON.stringify({ kind: "controlRequest", request })

/** A spy adapter — records every frame `pushMessage`d (i.e. NOT consumed). */
const spyAdapter = () => {
  const pushed: (string | Uint8Array | ArrayBuffer)[] = []
  return {
    adapter: {
      socket: {} as never,
      pushMessage: (raw: string | Uint8Array | ArrayBuffer) => pushed.push(raw),
      handleClose: () => {},
    },
    pushed,
  }
}

/** A spy control-request port handle — records every `enqueue`d request. */
const spyPortHandle = (): { handle: WebControlRequestPortHandle; enqueued: ControlRequest[] } => {
  const enqueued: ControlRequest[] = []
  return {
    enqueued,
    handle: {
      port: { next: () => null },
      applier: {},
      context: {},
      enqueue: (req) => enqueued.push(req),
      pendingCount: () => enqueued.length,
    },
  }
}

/** Build a minimal `ws` with a spy adapter pre-attached (skips `open`). */
const fakeWs = (adapter: ReturnType<typeof spyAdapter>["adapter"]): ServerWebSocket<WSData> =>
  ({
    data: { adapter, observability: undefined, canvas: undefined, agentState: undefined },
  }) as unknown as ServerWebSocket<WSData>

const baseConfig = (controlRequestPorts?: ControlRequestPorts): WebDaemonServerConfig =>
  ({
    supportedReadModels: { session: { status: "supported", version: "session.v1" } },
    ...(controlRequestPorts !== undefined ? { controlRequestPorts } : {}),
  }) as unknown as WebDaemonServerConfig

const buildHandlers = (config: WebDaemonServerConfig) =>
  buildWebSocketHandlers({
    config,
    registry: {
      add: () => {},
      has: () => false,
      size: () => 0,
      evict: async () => {},
      closeAll: async () => {},
    },
    sharedSession: {} as never,
    followerApproval: undefined,
  })

describe("server control-request wire — message handler", () => {
  test("WIRED: a controlRequest frame is ENQUEUED and NOT forwarded to the bridge", () => {
    const { adapter, pushed } = spyAdapter()
    const { handle, enqueued } = spyPortHandle()
    const handlers = buildHandlers(baseConfig({ handle }))
    handlers.message(fakeWs(adapter), frame({ kind: "set_permission_mode", mode: "bypass" }))
    expect(enqueued).toEqual([{ kind: "set_permission_mode", mode: "bypass" }])
    expect(pushed).toEqual([]) // consumed, never reaches the adapter/bridge
  })

  test("DEFAULT-OFF: no controlRequestPorts ⇒ the frame FALLS THROUGH to the adapter", () => {
    const { adapter, pushed } = spyAdapter()
    const handlers = buildHandlers(baseConfig(undefined))
    const raw = frame({ kind: "set_permission_mode", mode: "bypass" })
    handlers.message(fakeWs(adapter), raw)
    expect(pushed).toEqual([raw]) // byte-identical legacy: forwarded to the bridge
  })

  test("NON-MATCH: a non-controlRequest frame is forwarded even when the port is wired", () => {
    const { adapter, pushed } = spyAdapter()
    const { handle, enqueued } = spyPortHandle()
    const handlers = buildHandlers(baseConfig({ handle }))
    const raw = JSON.stringify({ kind: "somethingElse", x: 1 })
    handlers.message(fakeWs(adapter), raw)
    expect(enqueued).toEqual([])
    expect(pushed).toEqual([raw])
  })
})
