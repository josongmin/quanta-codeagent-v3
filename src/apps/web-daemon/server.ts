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

import type { Server } from "bun"
import type { FollowerCoControlDispatcher } from "@/agent/thread-follower"
import type { SupportedReadModels } from "@/protocol/session"
import { errMessage, logger } from "@/shared"
import type { ArtifactPreviewResolver } from "@/host/runtime"
import { type CanvasArtifactFeed, setupCanvasArtifactBridge } from "./server/canvas-artifact-bridge"
import { buildFetchHandler } from "./server/fetch-handler"
import { setupFollowerApproval } from "./server/follower-approval"
import { setupThreadPersistence } from "./server/persistence"
import type {
  AgentStatePorts,
  CanvasPorts,
  ControlRequestPorts,
  ObservabilityPorts,
  UserInputPorts,
} from "./server/sinks"
import type { WSData } from "./server/ws-data"
import { buildWebSocketHandlers } from "./server/ws-handlers"
import { createSessionRegistry } from "./session-registry"
import type { WebDaemonConfig, WebDaemonHandle } from "./types"

export { parseFollowerApprovalTimeoutMs } from "./server/follower-approval"
export { HEARTBEAT_INTERVAL_MS, replyToHeartbeat } from "./server/heartbeat"
export {
  _serveStaticSpaForTest,
  CONFIG_ALLOWED_KEYS,
  configKeyWriteRejection,
} from "./server/http"
// Re-export the COMPLETE original public surface so every importer stays
// byte-compatible after the cluster extraction. These symbols moved to siblings
// under `./server/` but their canonical import path remains this module.
export type {
  AgentStatePorts,
  AgentStateSource,
  CanvasPorts,
  CanvasToolDiff,
  CanvasToolDiffSource,
  CanvasUsageSource,
  ControlRequestPorts,
  ObservabilityPorts,
  UserInputPorts,
} from "./server/sinks"
export {
  attachAgentStateSink,
  attachCanvasSink,
  attachObservabilitySink,
} from "./server/sinks"
// Per-connection `ServerWebSocket` state (`WSData`) and the open/message/close
// handler trio moved to `./server/ws-handlers` (+ `./server/ws-data`); the
// `peekPlanInputAnswer` inbound-frame decoder + the `applySurfaceSubscription`
// helper live there too. Re-exported below so the canonical import path stays
// this module.
export { applySurfaceSubscription, peekPlanInputAnswer } from "./server/ws-handlers"

/**
 * ADR-0420 — `WebDaemonConfig` plus the optional observability port bundle.
 * Kept local to the server (rather than widening the shared `WebDaemonConfig`)
 * so the gate-OFF surface is byte-identical: callers that never set
 * `observabilityPorts` get exactly the legacy behaviour. The composition root
 * (`./index.ts`) populates it only when `QUANTA_OBSERVABILITY=on`.
 */
export interface WebDaemonServerConfig extends WebDaemonConfig {
  readonly supportedReadModels: SupportedReadModels
  readonly observabilityPorts?: ObservabilityPorts
  /**
   * ADR-0440 — optional canvas port bundle. Gate OFF ⇒ absent ⇒ the server
   * attaches no canvas sink (byte-identical). The composition root populates
   * it only when `QUANTA_WEB_CANVAS=1`.
   */
  readonly canvasPorts?: CanvasPorts
  /**
   * A2 — the WRITE side of the Canvas artifact source. When present, the server
   * subscribes the shared session's `artifact.ready` events into it so each
   * connection's Canvas emitter forwards an `artifact.ready` frame. Gate OFF
   * (`QUANTA_WEB_CANVAS` unset) ⇒ absent ⇒ no bridge (byte-identical). The
   * composition root (`./index.ts`) populates it from `facade.canvasArtifact.sink`.
   */
  readonly canvasArtifactFeed?: CanvasArtifactFeed
  /**
   * A2 — the host-side READ-ONLY `quanta-artifact://` preview resolver. When
   * present, the `GET /artifact/:id` route serves jailed preview bytes. Gate OFF
   * (`QUANTA_ARTIFACT_STORE` unset) ⇒ absent ⇒ the route 404s (no channel,
   * byte-identical). Populated by `./index.ts` from `facade.artifactPreviewResolver`.
   */
  readonly artifactPreviewResolver?: ArtifactPreviewResolver
  /**
   * QUANTA_WEB_AGENT_STATE — optional agent-state port bundle. Gate OFF ⇒
   * absent ⇒ the server attaches no agent-state sink (byte-identical). The
   * composition root (`./index.ts`) populates it only when
   * `QUANTA_WEB_AGENT_STATE=1`.
   */
  readonly agentStatePorts?: AgentStatePorts
  /**
   * QUANTA_WEB_AGENT_STATE — optional OUT-OF-BAND INBOUND port bundle. Gate
   * OFF ⇒ absent ⇒ no inbound `planInputAnswer` frame can resolve anything (and
   * the `request_user_input` tool was never registered, byte-identical). The
   * composition root (`./index.ts`) populates it only when
   * `QUANTA_WEB_AGENT_STATE=1`.
   */
  readonly userInputPorts?: UserInputPorts
  /**
   * QUANTA_CONTROL_REQUEST (ADR-0496 A1) — optional OUT-OF-BAND INBOUND
   * control-request port bundle. Gate OFF ⇒ absent ⇒ a peeked `controlRequest`
   * frame has no enqueue target (and the loop's drain slot is unwired,
   * byte-identical). The composition root (`./index.ts`) populates it only when
   * `QUANTA_CONTROL_REQUEST` is on.
   */
  readonly controlRequestPorts?: ControlRequestPorts
  /**
   * T02 — optional thread-follower co-control dispatcher. Gate OFF
   * (`QUANTA_THIN_CLIENT_DISPATCH` unset) ⇒ absent ⇒ a `followerVerb` frame
   * falls through to the session bridge (and no conversation-action port is
   * wired, byte-identical). Populated by `./index.ts` from the session facade.
   */
  readonly followerCoControl?: FollowerCoControlDispatcher
}

export const startWebDaemon = async (config: WebDaemonServerConfig): Promise<WebDaemonHandle> => {
  const runtime = await config.runtimeFactory()
  // ONE shared session for the whole daemon lifetime. New WS connections
  // join the same session instead of minting a fresh one — see the
  // `buildRegisteredSession` comment above.
  const sharedSession = await runtime.createSession(config.sessionConfig)
  const registry = createSessionRegistry()
  const startedAt = performance.now()

  // SQLite-backed thread persistence (append every SessionEvent on the shared
  // session) + the T02 follower approval-relay TIMEOUT coordinator. Both are
  // gate-OFF byte-identical (null/undefined handles) and extracted verbatim into
  // their `./server/` siblings — see those modules for the full contracts.
  const { threadStore, unsubPersist: unsubPersist0 } = setupThreadPersistence(sharedSession)
  let unsubPersist = unsubPersist0
  // A2 — server-boot bridge: pump every session `artifact.ready` event into the
  // Canvas artifact source so each connection's emitter forwards an
  // `artifact.ready` Canvas frame. Gate OFF ⇒ `canvasArtifactFeed` absent ⇒ null
  // unsub, no subscription (byte-identical).
  const { unsub: canvasArtifactUnsub0 } = setupCanvasArtifactBridge(
    sharedSession,
    config.canvasArtifactFeed ?? null,
  )
  let canvasArtifactUnsub = canvasArtifactUnsub0
  const {
    followerApproval,
    followerApprovalUnsub: followerApprovalUnsub0,
    followerSweepTimer: followerSweepTimer0,
  } = setupFollowerApproval(config, sharedSession)
  let followerApprovalUnsub = followerApprovalUnsub0
  let followerSweepTimer = followerSweepTimer0

  // `fetch` reads `server.port` (the `/network` route) but `server` is the
  // `Bun.serve` result assigned HERE — `getServer` resolves it lazily at request
  // time (after binding completes), so the closure may reference it before this
  // `const` initializer returns without a TDZ hazard.
  const server: Server<WSData> = Bun.serve<WSData, never>({
    port: config.port,
    hostname: config.bind,
    fetch: buildFetchHandler({
      config,
      registry,
      startedAt,
      threadStore,
      sharedSession,
      getServer: () => server,
      // A2 — the read-only preview resolver for `GET /artifact/:id`. Absent ⇒
      // the route 404s (byte-identical). `void` marks the intentional unused when
      // exactOptionalPropertyTypes strips it below.
      ...(config.artifactPreviewResolver !== undefined
        ? { artifactPreviewResolver: config.artifactPreviewResolver }
        : {}),
    }),
    websocket: buildWebSocketHandlers({ config, registry, sharedSession, followerApproval }),
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
      if (unsubPersist !== null) {
        unsubPersist()
        unsubPersist = null
      }
      // A2 — stop the artifact bridge so it never fires against a closed session.
      if (canvasArtifactUnsub !== null) {
        canvasArtifactUnsub()
        canvasArtifactUnsub = null
      }
      // T02 — tear down the follower approval coordinator's subscription + sweep
      // timer so neither fires against a closed session.
      if (followerApprovalUnsub !== null) {
        followerApprovalUnsub()
        followerApprovalUnsub = null
      }
      if (followerSweepTimer !== null) {
        clearInterval(followerSweepTimer)
        followerSweepTimer = null
      }
      threadStore?.close()
      await runtime.close().catch((error: unknown) => {
        logger.warn("web-daemon: runtime.close failed", {
          error: errMessage(error),
        })
      })
    },
  }
}

// Exported for unit tests so the adapter/registry contracts can be exercised
// without booting a real Bun.serve.
export {
  constantTimeEquals as _constantTimeEqualsForTest,
  extractToken as _extractTokenForTest,
} from "./server/auth"
