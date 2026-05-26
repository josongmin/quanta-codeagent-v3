/**
 * `@/apps/web-daemon/server` — Bun.serve listener + per-connection wiring.
 *
 * One `RuntimeSession` per upgraded WebSocket (v1 scope; multiplexing later).
 * Wire framing matches `@/ipc/session` exactly — one JSON-encoded
 * `SessionTransportMessage` per WS text frame; the existing
 * `wrapWebSocketLikeAsSessionTransport` does the encode/decode after our
 * Bun adapter routes the frames into the `SessionWebSocketLike` shape.
 *
 * Auth: when `config.authToken` is set we require either an
 * `Authorization: Bearer <token>` header or a `?token=<token>` query
 * parameter (browsers cannot set custom upgrade headers — the query path
 * keeps the surface usable from a vanilla `WebSocket` constructor). Compare
 * in constant time so a timing oracle cannot leak prefix matches.
 */

import type { Server, ServerWebSocket } from "bun"
import {
  createSessionTransportBridge,
  type SessionTransport,
  type SessionTransportBridge,
  wrapWebSocketLikeAsSessionTransport,
} from "@/ipc/session"
import type { SessionEvent } from "@/protocol/session"
import type { RuntimeFacade, RuntimeSession } from "@/sdk/runtime"
import { logger } from "@/shared"
import {
  createSessionRegistry,
  type RegisteredSession,
  type SessionRegistry,
} from "./session-registry"
import type { WebDaemonConfig, WebDaemonHandle, WebDaemonHealth } from "./types"
import {
  type BunServerWebSocketLike,
  type BunWebSocketAdapter,
  createBunWebSocketAdapter,
} from "./ws-adapter"

/**
 * Per-connection state attached to `ServerWebSocket<WSData>`. Holds the
 * adapter object — `open()` overwrites the `adapter` slot with the real
 * adapter after upgrade. We use a mutable container (object reference) so
 * the upgrade-time stub is the same object the open-time wiring fills in.
 */
interface WSData {
  /** Filled in by `open()` after upgrade. */
  adapter: BunWebSocketAdapter | undefined
}

const constantTimeEquals = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

const extractToken = (url: URL, header: string | null): string | undefined => {
  if (header !== null) {
    const trimmed = header.trim()
    const prefix = "Bearer "
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      const token = trimmed.slice(prefix.length).trim()
      if (token.length > 0) return token
    }
  }
  const q = url.searchParams.get("token")
  if (q !== null && q.length > 0) return q
  return undefined
}

const authReject = (): Response =>
  new Response("unauthorized", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8" },
  })

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

const forwardSessionEvents = (
  session: RuntimeSession,
  bridge: SessionTransportBridge,
): (() => void) => {
  // Pipe every event the runtime publishes into the transport bridge so the
  // client sees full server-side activity (turn events, approvals, etc.).
  const unsubscribe = session.subscribe((event: SessionEvent) => {
    void bridge.publishEvents([event]).catch((error: unknown) => {
      logger.warn("web-daemon: bridge.publishEvents failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
  })
  return unsubscribe
}

const buildRegisteredSession = async (
  registry: SessionRegistry,
  socketKey: object,
  config: WebDaemonConfig,
  socket: BunWebSocketAdapter,
  runtime: RuntimeFacade,
): Promise<void> => {
  const session = await runtime.createSession(config.sessionConfig)
  const snapshot = await session.snapshot()
  const bridge = createSessionTransportBridge({
    snapshot,
    onCommand: async (command) => {
      try {
        await session.dispatch(command)
      } catch (error) {
        logger.warn("web-daemon: session.dispatch failed", {
          commandId: command.commandId,
          type: command.type,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
    onBridgeError: ({ error }) => {
      logger.warn("web-daemon: bridge error", {
        error: error instanceof Error ? error.message : String(error),
      })
    },
  })
  const transport: SessionTransport = wrapWebSocketLikeAsSessionTransport(socket.socket)
  const connected = await bridge.connect(transport)
  const stopForwarder = forwardSessionEvents(session, bridge)
  const entry: RegisteredSession = {
    session,
    bridge,
    transport,
    connected,
    stopForwarder,
  }
  registry.add(socketKey, entry)
}

export const startWebDaemon = async (config: WebDaemonConfig): Promise<WebDaemonHandle> => {
  const runtime = await config.runtimeFactory()
  const registry = createSessionRegistry()
  const startedAt = performance.now()

  const tryUpgrade = (req: Request, server: Server<WSData>): Response | undefined => {
    const url = new URL(req.url)
    if (url.pathname !== "/" && url.pathname !== "/ws") return undefined
    if (config.authToken !== undefined) {
      const presented = extractToken(url, req.headers.get("authorization"))
      if (presented === undefined || !constantTimeEquals(presented, config.authToken)) {
        return authReject()
      }
    }
    const upgraded = server.upgrade(req, { data: { adapter: undefined } })
    if (!upgraded) return new Response("upgrade failed", { status: 400 })
    // 101 is sent by Bun on successful upgrade — return undefined so Bun
    // owns the response.
    return undefined
  }

  const server: Server<WSData> = Bun.serve<WSData, never>({
    port: config.port,
    hostname: config.bind,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname === "/health" && req.method === "GET") {
        const health: WebDaemonHealth = {
          status: "ok",
          sessions: registry.size(),
          uptime_ms: Math.round(performance.now() - startedAt),
        }
        return jsonResponse(200, health)
      }
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const resp = tryUpgrade(req, srv)
        if (resp !== undefined) return resp
        // Upgrade succeeded — Bun consumed the request.
        return new Response(null, { status: 101 })
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      async open(ws: ServerWebSocket<WSData>) {
        const adapter = createBunWebSocketAdapter(ws as unknown as BunServerWebSocketLike)
        // Attach adapter immediately so a fast inbound frame is buffered to
        // the right adapter; the registered session is filled in below.
        ws.data.adapter = adapter
        try {
          await buildRegisteredSession(registry, ws, config, adapter, runtime)
        } catch (error) {
          logger.error("web-daemon: failed to create runtime session", {
            error: error instanceof Error ? error.message : String(error),
          })
          adapter.handleClose()
          try {
            ws.close(1011, "session_init_failed")
          } catch {
            // ignore double-close
          }
        }
      },
      message(ws: ServerWebSocket<WSData>, raw) {
        ws.data.adapter?.pushMessage(raw)
      },
      async close(ws: ServerWebSocket<WSData>) {
        ws.data.adapter?.handleClose()
        await registry.evict(ws)
      },
    },
  })

  // Bun.serve binds synchronously when a port is requested — `port` is the
  // OS-chosen port when `config.port === 0`. `hostname` is `undefined` only
  // on unix sockets (we always bind to a host, so non-undefined here).
  const boundPort = server.port ?? config.port
  const boundHost = server.hostname ?? config.bind

  logger.info("web-daemon: listening", {
    port: boundPort,
    hostname: boundHost,
    auth: config.authToken !== undefined,
  })

  let stopped = false
  return {
    port: boundPort,
    hostname: boundHost,
    activeSessions: () => registry.size(),
    uptimeMs: () => Math.round(performance.now() - startedAt),
    stop: async () => {
      if (stopped) return
      stopped = true
      // Stop the listener FIRST (with force=true so in-flight WS clients
      // are detached at the socket layer) — then drain the registry and
      // close the runtime. Order matters: if we drain first, our adapter
      // closes its half of the WS and Bun's `stop()` then waits forever
      // for the client to ack on a socket we already removed handlers
      // from. Force-stopping first delivers the close frame from Bun
      // BEFORE we tear down our adapter state.
      await server.stop(true)
      await registry.closeAll()
      await runtime.close().catch((error: unknown) => {
        logger.warn("web-daemon: runtime.close failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    },
  }
}

// Exported for unit tests so the adapter/registry contracts can be exercised
// without booting a real Bun.serve.
export { constantTimeEquals as _constantTimeEqualsForTest, extractToken as _extractTokenForTest }
