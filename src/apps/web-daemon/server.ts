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
import {
  buildObjectiveSnapshotProvider,
  prepareObjectiveSnapshotForAttach,
} from "@/host/runtime/objective-store-wire"
import { costAccountingOffWire, costSurfaceViewWire } from "@/observability/usage-accounting"
import type { SupportedReadModels } from "@/protocol/session"
import type { RuntimeFacade, RuntimeSession } from "@/sdk/runtime"
import { loadSessionById, type PersistedObjectiveSnapshot } from "@/session"
import { errMessage, logger } from "@/shared"
import { composeWebGoalWake, type WebGoalWakeHandle } from "./goal-wake-compose"
import { composeWebGoalWork, type WebGoalWorkHandler } from "./goal-work-compose"
import type { CostReadoutTotals, WebReadoutSources } from "./readout"
import { buildDaemonReadoutSources } from "./readout-compose"
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
  /**
   * GOAL-08 rail 15 (web half) — the user-requested goal-work handler. Absent
   * (no objective authority / no host verb) ⇒ a `goalWork` frame falls through
   * to the session bridge, byte-identical. Composed by `startWebDaemon` over
   * the shared session (`composeWebGoalWork`).
   */
  readonly goalWork?: WebGoalWorkHandler
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

/** RFC-03 C2 — the transcript-persist objective provider for the web session,
 *  encoded from the SESSION-STABLE authority (`runtime.objectiveAuthority`,
 *  duck-read like `readoutSources` — the base `RuntimeFacade` type does not
 *  surface it). This is deliberately the NON-obs persistence handle the factory
 *  exposes under `QUANTA_OBJECTIVE_TOOLS` alone — NOT the obs-gated `objective`
 *  facade getter (which proxies the observability wire handle and reads undefined
 *  when `QUANTA_OBSERVABILITY` is off, silently dropping the durable goal). Both
 *  are the SAME instance when observability is on; the persistence field is the
 *  one that is ALSO present with observability off, so the goal is saved either
 *  way — and reading it emits NO observability frame (obs stream byte-identical).
 *  Returns `undefined` when no authority is present (TOOLS off) ⇒ transcript-
 *  persist omits `objective` ⇒ byte-identical. Module-scope so it stays off
 *  `startWebDaemon`'s body budget. */
const webObjectiveSnapshot = (
  runtime: unknown,
): (() => PersistedObjectiveSnapshot | undefined) | undefined =>
  buildObjectiveSnapshotProvider((runtime as { objectiveAuthority?: unknown }).objectiveAuthority)

/** Bind the observability objective pane to the LIVE session key. The emitter reads
 *  `objective.get(threadId)`; without a threadId it defaults to "default", but the
 *  tools/authority key the objective by config.sessionId === base.sessionId ===
 *  sharedSession.sessionId — so the pane showed an EMPTY goal. Setting the emitter
 *  threadId to the live key (the SAME key the reopen restore re-keys onto) makes the
 *  pane reflect the live + reopened goal. Gate OFF ⇒ observabilityPorts undefined ⇒
 *  config returned unchanged (byte-identical). Module-scope to keep startWebDaemon
 *  under the god ceiling. */
/** GOAL-06 + GOAL-08 rail 15 — the two goal surfaces the daemon composes over
 *  the SHARED session and the runtime's objective ports: the autonomous wake
 *  controller, and the user-requested `/goal work` verb (same objective
 *  authority, same attributed-attempt slot the session host claims). Either is
 *  `undefined` when its preconditions are absent ⇒ that surface is inert and
 *  byte-identical. Hoisted so `startWebDaemon` stays under the god-fn cap. */
/**
 * A7 — the daemon's /cost readout as a PROJECTION of the usage authority.
 * Turn count is the one event-derived number (an event tally, not a usage
 * sum); every token/dollar comes from the shared wire mapper so this readout,
 * the header pill and the CLI /cost cannot disagree. No authority ⇒ honest
 * zeros plus the tally.
 */
const attachDaemonCostProjection = (
  runtime: unknown,
  sharedSession: RuntimeSession,
): { totals: () => CostReadoutTotals; unsub: () => void } => {
  // Duck-read like readoutSources: the base RuntimeFacade type does not know
  // daemon-only getters; a facade without one degrades to the honest off shape.
  const costAuthority = (
    runtime as {
      usageAccounting?: import("@/observability/usage-accounting").UsageAccountingPort
    }
  ).usageAccounting
  let turns = 0
  const unsub = sharedSession.subscribe((event) => {
    // The only event-derived number: a TURN TALLY (an event count, never a
    // usage sum — the tokens/dollars all come from the authority below).
    if (event.type === "turn.completed") turns += 1
  })
  return {
    unsub,
    totals: (): CostReadoutTotals => {
      if (costAuthority === undefined) {
        return { turns, ...costAccountingOffWire() }
      }
      const wire = costSurfaceViewWire(costAuthority)
      return { turns, ...wire }
    },
  }
}

/** Build the daemon readout projection over the shared, live session. `/cost`
 * receives authority totals plus its event-derived turn tally; the other
 * readouts stay owned by the runtime compose surface. */
const buildDaemonReadoutSurface = (
  runtime: RuntimeFacade,
  sharedSession: RuntimeSession,
  cost: () => CostReadoutTotals,
): WebReadoutSources =>
  buildDaemonReadoutSources({
    runtime,
    threadId: sharedSession.sessionId,
    cost,
  })

/** Tear the two goal surfaces down together: cancel the autonomous wake, then
 *  DRAIN in-flight user goal turns (bounded inside `settled()` — a turn that
 *  never settles must not wedge `stop()`). */
const stopGoalSurfaces = async (surfaces: {
  goalWake: WebGoalWakeHandle | undefined
  goalWork: WebGoalWorkHandler | undefined
}): Promise<void> => {
  surfaces.goalWake?.stop()
  await surfaces.goalWork?.settled()
}

const composeGoalSurfaces = async (
  runtime: RuntimeFacade,
  sharedSession: RuntimeSession,
): Promise<{
  goalWake: WebGoalWakeHandle | undefined
  goalWork: WebGoalWorkHandler | undefined
}> => ({
  goalWake: await composeWebGoalWake({
    session: sharedSession,
    runtime: runtime as Parameters<typeof composeWebGoalWake>[0]["runtime"],
    env: process.env,
  }),
  goalWork: composeWebGoalWork({
    session: sharedSession,
    runtime: runtime as Parameters<typeof composeWebGoalWork>[0]["runtime"],
  }),
})

export const bindObjectivePaneThread = (
  config: WebDaemonServerConfig,
  sessionId: string,
): WebDaemonServerConfig =>
  config.observabilityPorts !== undefined
    ? { ...config, observabilityPorts: { ...config.observabilityPorts, threadId: sessionId } }
    : config

/** P1 Phase 2 — the swap-on-attach closure (module-scope to keep `startWebDaemon`
 *  under the god-function ceiling). Load the opened thread's lossless SavedSession,
 *  replace the live transcript, repoint persistence, and (RFC-03 C2) restore its
 *  durable objective into the SAME session-stable authority the persist snapshot
 *  encodes from (`runtime.objectiveAuthority`, duck-read). Absent authority (TOOLS
 *  off) ⇒ restore no-op (byte-identical); restore fires only on the hydrated
 *  success path (see thread-hydrate). Undefined when persistence is off (no thread
 *  store ⇒ nothing was ever saved). */
const buildOnAttachThread = (deps: {
  readonly threadStore: ReturnType<typeof setupThreadPersistence>["threadStore"]
  readonly sharedSession: RuntimeSession
  readonly transcriptPersist: ReturnType<typeof attachTranscriptPersistence>
  readonly runtime: unknown
  readonly goalWake?: WebGoalWakeHandle | undefined
}): ((threadId: string) => Promise<void>) | undefined =>
  deps.threadStore !== null
    ? async (threadId: string): Promise<void> => {
        await hydrateThreadIntoLiveSession(threadId, {
          loadThread: async (id) => await loadSessionById(id),
          replaceTranscript: async (messages) => {
            await deps.sharedSession.transcript.replace(messages)
          },
          setActiveThreadId: (id) => deps.transcriptPersist.setActiveThreadId(id),
          // Re-key the persisted goal onto the LIVE session's objective read key
          // (`sharedSession.sessionId` === base.sessionId === config.sessionId ===
          // the tools' ctx.ownerId). The daemon mints a fresh per-boot session id,
          // so the snapshot's saving-boot key never matches the reopening read key —
          // without this re-key the restore is inert (goal orphaned under the old id).
          prepareObjectiveAttach: (snapshot) => {
            const prepared = prepareObjectiveSnapshotForAttach(
              (deps.runtime as { objectiveAuthority?: unknown }).objectiveAuthority,
              snapshot,
              deps.sharedSession.sessionId,
            )
            return prepared.ok ? prepared.prepared : null
          },
          prepareUsageAccountingAttach: (snapshot) => ({
            commit: () => {
              const accounting = (
                deps.runtime as {
                  usageAccounting?: import("@/observability/usage-accounting").UsageAccountingPort
                }
              ).usageAccounting
              if (accounting === undefined) return true
              if (snapshot === undefined) {
                accounting.reset()
                return true
              }
              if (
                !accounting.hydrate(snapshot, { rebindSessionId: deps.sharedSession.sessionId })
              ) {
                logger.warn("web-daemon: attached usage accounting state was corrupt", {
                  threadId,
                })
              }
              return true
            },
          }),
          cancelGoalWake: deps.goalWake?.onAttachStart,
          rearmGoalWake: deps.goalWake?.onAttachSettled,
        })
      }
    : undefined

/** Ordered, idempotent teardown of one daemon's resources. The listener closes
 * before the registry so active sockets cannot keep Bun.serve alive. */
const createDaemonStop = (resources: {
  readonly runtime: RuntimeFacade
  readonly server: Server<WSData>
  readonly registry: ReturnType<typeof createSessionRegistry>
  readonly goalWake: WebGoalWakeHandle | undefined
  readonly goalWork: WebGoalWorkHandler | undefined
  readonly threadStore: ReturnType<typeof setupThreadPersistence>["threadStore"]
  readonly followerSweepTimer: ReturnType<typeof setupFollowerApproval>["followerSweepTimer"]
  readonly beforeSweep: readonly ((() => void) | null | undefined)[]
  readonly afterSweep: readonly ((() => void) | null | undefined)[]
}): WebDaemonHandle["stop"] => {
  let stopped = false
  return async () => {
    if (stopped) return
    stopped = true
    await stopGoalSurfaces(resources)
    await resources.server.stop(true)
    await resources.registry.closeAll()
    for (const detach of resources.beforeSweep) detach?.()
    if (resources.followerSweepTimer !== null) clearInterval(resources.followerSweepTimer)
    for (const detach of resources.afterSweep) detach?.()
    resources.threadStore?.close()
    await resources.runtime.close().catch((error: unknown) => {
      logger.warn("web-daemon: runtime.close failed", { error: errMessage(error) })
    })
  }
}

export const startWebDaemon = async (config: WebDaemonServerConfig): Promise<WebDaemonHandle> => {
  const runtime = await config.runtimeFactory()
  // ONE shared session for the whole daemon lifetime. New WS connections
  // join the same session instead of minting a fresh one — see the
  // `buildRegisteredSession` comment above.
  const sharedSession = await runtime.createSession(config.sessionConfig)
  const { goalWake, goalWork } = await composeGoalSurfaces(runtime, sharedSession)
  const registry = createSessionRegistry()
  const startedAt = performance.now()

  // SQLite-backed thread persistence (append every SessionEvent on the shared
  // session) + the T02 follower approval-relay TIMEOUT coordinator. Both are
  // gate-OFF byte-identical (null/undefined handles) and extracted verbatim into
  // their `./server/` siblings — see those modules for the full contracts.
  const { threadStore, unsubPersist } = setupThreadPersistence(sharedSession)
  // A2 — server-boot bridge: pump every session `artifact.ready` event into the
  // Canvas artifact source so each connection's emitter forwards an
  // `artifact.ready` Canvas frame. Gate OFF ⇒ `canvasArtifactFeed` absent ⇒ null
  // unsub, no subscription (byte-identical).
  const { unsub: canvasArtifactUnsub } = setupCanvasArtifactBridge(
    sharedSession,
    config.canvasArtifactFeed ?? null,
  )
  const { followerApproval, followerApprovalUnsub, followerSweepTimer } = setupFollowerApproval(
    config,
    sharedSession,
    process.env,
  )
  // ADR-0540 W1-B — daemon-owned post-approval continuation. Gate ON ⇒ every
  // `approval.resolved(approve)` enqueues a daemon-minted bare `turn.run` on
  // the session dispatch tail (clients see the `serverAutoContinues` capability
  // marker and skip their own re-issue). Gate OFF ⇒ `unsub` is null and NOTHING
  // was subscribed (byte-identical legacy client-owned continuation).
  const approvalContinuationUnsub = setupApprovalContinuation(sharedSession, process.env).unsub

  const cost = attachDaemonCostProjection(runtime, sharedSession)
  // P1 Phase 1 — persist the LOSSLESS Message[] transcript to the @/session
  // store (for a later live thread swap), gate-symmetric with the sqlite
  // archive (`threadStore !== null` ⇔ QUANTA_WEB_DB on). Off ⇒ no writes.
  const transcriptPersist = attachTranscriptPersistence(sharedSession, {
    enabled: threadStore !== null,
    cwd: config.sessionConfig.cwd ?? process.cwd(),
    // RFC-03 C2 — durable objective snapshot from the live web authority.
    objectiveSnapshot: webObjectiveSnapshot(runtime),
    usageAccountingSnapshot: () =>
      (
        runtime as {
          usageAccounting?: import("@/observability/usage-accounting").UsageAccountingPort
        }
      ).usageAccounting?.serialize(),
  })
  // P1 Phase 2 — swap-on-attach closure (extracted to buildOnAttachThread to keep
  // this function under the god ceiling): load the opened thread, replace the live
  // transcript, repoint persistence, restore the durable objective.
  const onAttachThread = buildOnAttachThread({
    threadStore,
    sharedSession,
    transcriptPersist,
    runtime,
    ...(goalWake !== undefined ? { goalWake } : {}),
  })
  const readoutSources = buildDaemonReadoutSurface(runtime, sharedSession, cost.totals)

  const { server, boundPort, boundHost } = buildDaemonListener({
    config: {
      ...bindObjectivePaneThread(config, sharedSession.sessionId),
      ...(goalWork !== undefined ? { goalWork } : {}),
    },
    registry,
    startedAt,
    threadStore,
    sharedSession,
    readoutSources,
    transcriptPersist,
    onAttachThread,
    followerApproval,
  })

  return {
    port: boundPort,
    hostname: boundHost,
    activeSessions: () => registry.size(),
    uptimeMs: () => Math.round(performance.now() - startedAt),
    stop: createDaemonStop({
      runtime,
      server,
      registry,
      goalWake,
      goalWork,
      threadStore,
      followerSweepTimer,
      beforeSweep: [unsubPersist, canvasArtifactUnsub, followerApprovalUnsub],
      afterSweep: [approvalContinuationUnsub, transcriptPersist.unsub, cost.unsub],
    }),
  }
}

// Exported for unit tests so the adapter/registry contracts can be exercised
// without booting a real Bun.serve.
export {
  constantTimeEquals as _constantTimeEqualsForTest,
  extractToken as _extractTokenForTest,
} from "./server/auth"

// RFC-03 C2 (web-parity persistence seam) — exported for the hellgate so the
// EXACT server snapshot builder (`objectiveSnapshot: webObjectiveSnapshot(runtime)`)
// can be driven against a production-shaped facade without booting Bun.serve.
export { webObjectiveSnapshot as _webObjectiveSnapshotForTest }
