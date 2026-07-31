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
import type { ArtifactPreviewResolver } from "@/host/runtime"
import type { SupportedReadModels } from "@/protocol/session"
import type { RuntimeSession } from "@/sdk/runtime"
import { loadSessionById } from "@/session"
import { errMessage, logger } from "@/shared"
import type { CostReadoutTotals, WebReadoutSources } from "./readout"
import { setupApprovalContinuation } from "./server/approval-continuation"
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
import { hydrateThreadIntoLiveSession } from "./server/thread-hydrate"
import { attachTranscriptPersistence } from "./server/transcript-persist"
import type { WSData } from "./server/ws-data"
import { buildWebSocketHandlers } from "./server/ws-handlers"
import { createSessionRegistry } from "./session-registry"
import { installSubagentSource, type SubagentSourceHandle } from "./subagent-source"
import type { WebDaemonConfig, WebDaemonHandle } from "./types"

// jul-16 — heartbeat responder hoisted to `@/ipc/session` (every session.v1
// server can pong now, not just this WS daemon). Re-exported here so existing
// `@/apps/web-daemon/server` importers are unchanged.
export { HEARTBEAT_INTERVAL_MS, replyToHeartbeat } from "@/ipc/session"
export { parseFollowerApprovalTimeoutMs } from "./server/follower-approval"
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
   * QUANTA_WEB_SUBAGENTS — optional Sub-Agents panel source. Gate OFF ⇒ absent
   * ⇒ the server installs no `subagent` topic broadcast + no socket subscribes
   * (byte-identical). Populated by `./index.ts` from `facade.subagentSource`.
   */
  readonly subagentSource?: SubagentSourceHandle
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

/**
 * UUX-1-11 — server-side cumulative usage fold for the `/cost` readout. The
 * daemon-native usage truth is the `turn.completed` SessionEvent (tokenUsage +
 * modelSlug), so the aggregator subscribes the shared session and folds every
 * completed turn — the same numbers any attached client's usage footer sums.
 * Read-only + additive: a session without usage-reporting turns yields honest
 * zeros ("no completed turns yet"), never a fabricated estimate.
 */
const attachCostAggregator = (
  session: RuntimeSession,
): { totals: () => CostReadoutTotals; unsub: () => void } => {
  let turns = 0
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  let costMicroUsd = 0
  let modelSlug: string | undefined
  const unsub = session.subscribe((event) => {
    if (event.type !== "turn.completed") return
    turns += 1
    if (event.tokenUsage !== undefined) {
      promptTokens += event.tokenUsage.promptTokens ?? 0
      completionTokens += event.tokenUsage.completionTokens ?? 0
      totalTokens += event.tokenUsage.totalTokens ?? 0
      costMicroUsd += event.tokenUsage.costMicroUsd ?? 0
    }
    if (event.modelSlug !== undefined && event.modelSlug.length > 0) modelSlug = event.modelSlug
  })
  return {
    totals: () => ({
      turns,
      promptTokens,
      completionTokens,
      totalTokens,
      costMicroUsd,
      ...(modelSlug !== undefined ? { modelSlug } : {}),
    }),
    unsub,
  }
}

/**
 * god-code split — the `Bun.serve` listener construction (fetch + websocket
 * wiring) plus its bound-address resolution and the startup log line, lifted
 * VERBATIM out of `startWebDaemon` so the caller body stays under the
 * god-function gate. Pure relocation: the `getServer: () => server` closure
 * still references this function`s own `server` local (same TDZ-lazy pattern),
 * so binding + request-time behaviour is byte-identical. Returns the listener
 * and its resolved bound address for the caller`s handle + `stop` closure.
 */
const buildDaemonListener = (params: {
  readonly config: WebDaemonServerConfig
  readonly registry: ReturnType<typeof createSessionRegistry>
  readonly startedAt: number
  readonly threadStore: ReturnType<typeof setupThreadPersistence>["threadStore"]
  readonly sharedSession: RuntimeSession
  readonly readoutSources: WebReadoutSources
  readonly transcriptPersist: ReturnType<typeof attachTranscriptPersistence>
  readonly onAttachThread: ((threadId: string) => Promise<void>) | undefined
  readonly followerApproval: ReturnType<typeof setupFollowerApproval>["followerApproval"]
}): { server: Server<WSData>; boundPort: number; boundHost: string } => {
  const {
    config,
    registry,
    startedAt,
    threadStore,
    sharedSession,
    readoutSources,
    transcriptPersist,
    onAttachThread,
    followerApproval,
  } = params
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
      readoutSources,
      getServer: () => server,
      ...(threadStore !== null ? { activeThreadId: () => transcriptPersist.activeThreadId() } : {}),
      // A2 — the read-only preview resolver for `GET /artifact/:id`. Absent ⇒
      // the route 404s (byte-identical). `void` marks the intentional unused when
      // exactOptionalPropertyTypes strips it below.
      ...(config.artifactPreviewResolver !== undefined
        ? { artifactPreviewResolver: config.artifactPreviewResolver }
        : {}),
    }),
    websocket: buildWebSocketHandlers({
      config,
      registry,
      sharedSession,
      followerApproval,
      ...(onAttachThread !== undefined ? { onAttachThread } : {}),
    }),
  })

  // QUANTA_WEB_SUBAGENTS — install the Sub-Agents broadcast: each subagent
  // observation captured by the source is published on `SUBAGENT_WS_TOPIC`, and
  // every connection subscribes to that topic in the WS `open` handler. Gate OFF
  // ⇒ `config.subagentSource` absent ⇒ no install, no topic (byte-identical).
  if (config.subagentSource !== undefined) installSubagentSource(config.subagentSource, server)

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
  return { server, boundPort, boundHost }
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
  // ADR-0540 W1-B — daemon-owned post-approval continuation. Gate ON ⇒ every
  // `approval.resolved(approve)` enqueues a daemon-minted bare `turn.run` on
  // the session dispatch tail (clients see the `serverAutoContinues` capability
  // marker and skip their own re-issue). Gate OFF ⇒ `unsub` is null and NOTHING
  // was subscribed (byte-identical legacy client-owned continuation).
  let approvalContinuationUnsub = setupApprovalContinuation(sharedSession, process.env).unsub

  // UUX-1-11 — readout sources for `GET /readout/:name`. The production
  // runtime-factory exposes a `readoutSources` getter (agents / plan / skills /
  // memory / context over the SAME live session collaborators); duck-read it so
  // a test stub facade simply degrades every readout to the honest
  // missing-source line. `/cost` is folded HERE from the shared session's
  // `turn.completed` events — a daemon-owned source, present for any facade.
  const facadeReadoutSources = (runtime as { readoutSources?: WebReadoutSources }).readoutSources
  const costAggregator = attachCostAggregator(sharedSession)
  let costAggregatorUnsub: (() => void) | null = costAggregator.unsub
  // P1 Phase 1 — persist the LOSSLESS Message[] transcript to the @/session
  // store (for a later live thread swap), gate-symmetric with the sqlite
  // archive (`threadStore !== null` ⇔ QUANTA_WEB_DB on). Off ⇒ no writes.
  const transcriptPersist = attachTranscriptPersistence(sharedSession, {
    enabled: threadStore !== null,
    cwd: config.sessionConfig.cwd ?? process.cwd(),
  })
  let transcriptPersistUnsub: (() => void) | null = transcriptPersist.unsub
  // P1 Phase 2 — swap-on-attach closure: load the opened thread's lossless
  // SavedSession, replace the live transcript, repoint persistence. Only when
  // persistence is on (there is a thread store to have saved anything).
  const onAttachThread =
    threadStore !== null
      ? async (threadId: string): Promise<void> => {
          await hydrateThreadIntoLiveSession(threadId, {
            loadThread: async (id) => await loadSessionById(id),
            replaceTranscript: async (messages) => {
              await sharedSession.transcript.replace(messages)
            },
            setActiveThreadId: (id) => transcriptPersist.setActiveThreadId(id),
          })
        }
      : undefined
  const readoutSources: WebReadoutSources = {
    ...(facadeReadoutSources ?? {}),
    cost: costAggregator.totals,
  }

  const { server, boundPort, boundHost } = buildDaemonListener({
    config,
    registry,
    startedAt,
    threadStore,
    sharedSession,
    readoutSources,
    transcriptPersist,
    onAttachThread,
    followerApproval,
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
      // ADR-0540 W1-B — detach the daemon-owned continuation subscription so a
      // late `approval.resolved` can never enqueue against a closed session
      // (optional-call form, mirroring `threadStore?.close()` below).
      approvalContinuationUnsub?.()
      approvalContinuationUnsub = null
      // UUX-1-11 — stop the cost fold so it never fires against a closed session.
      if (transcriptPersistUnsub !== null) {
        transcriptPersistUnsub()
        transcriptPersistUnsub = null
      }
      if (costAggregatorUnsub !== null) {
        costAggregatorUnsub()
        costAggregatorUnsub = null
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
