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
import type { FollowerCoControlDispatcher } from "@/agent/thread-follower"
import { createFollowerApprovalCoordinator } from "@/agent/thread-follower"
import {
  type SessionTransport,
  tryDecodeSessionTransportMessage,
  wrapWebSocketLikeAsSessionTransport,
} from "@/ipc/session"
import {
  resolveReadModels,
  type SupportedReadModels,
  type SurfaceSubscription,
} from "@/protocol/session"
import type { RuntimeSession } from "@/sdk/runtime"
import { errMessage, gateDisabled, logger } from "@/shared"
import { handleAuthLoginStart, handleAuthLogout, handleAuthStatus } from "./auth-routes"
import type { CanvasEmitterHandle } from "./canvas-emitter"
import { peekFollowerVerb } from "./follower-verb-frame"
import {
  buildWebKnobCatalog,
  catalogByGroup,
  resolveCatalogValues,
  webSafeKnobValue,
} from "./knob-catalog-wire"
import type { ObservabilityEmitterHandle } from "./observability-emitter"
import { openThreadStore } from "./persistence-sqlite"
import { renderReadout } from "./readout"
import { authReject, constantTimeEquals, extractToken } from "./server/auth"
import { replyToHeartbeat } from "./server/heartbeat"
import { handleConfigPost, handlePreflight, jsonResponse, serveStaticSpa } from "./server/http"
import { collectReachableIps, formatHost } from "./server/net"
import {
  type AgentStatePorts,
  attachAgentStateSink,
  attachCanvasSink,
  attachObservabilitySink,
  type CanvasPorts,
  type ObservabilityPorts,
  type UserInputPorts,
} from "./server/sinks"
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
  ObservabilityPorts,
  UserInputPorts,
} from "./server/sinks"
export {
  attachAgentStateSink,
  attachCanvasSink,
  attachObservabilitySink,
} from "./server/sinks"

/**
 * Per-connection state attached to `ServerWebSocket<WSData>`. Holds the
 * adapter object — `open()` overwrites the `adapter` slot with the real
 * adapter after upgrade. We use a mutable container (object reference) so
 * the upgrade-time stub is the same object the open-time wiring fills in.
 */
interface WSData {
  /** Filled in by `open()` after upgrade. */
  adapter: BunWebSocketAdapter | undefined
  /**
   * ADR-0420 — per-connection observability emitter (gate ON only). `open()`
   * attaches one bridging this socket to the daemon's live ports; `close()`
   * stops it so we never emit to a dead socket. `undefined` ⇒ gate OFF
   * (byte-identical: no sink, no frames).
   */
  observability: ObservabilityEmitterHandle | undefined
  /**
   * ADR-0440 — per-connection canvas emitter (gate ON only). `open()` attaches
   * one bridging this socket to the daemon's canvas data source; `close()`
   * stops it + unsubscribes. `undefined` ⇒ gate OFF (byte-identical: no sink,
   * no frames). The detach closure unsubscribes from the shared usage source.
   */
  canvas: { handle: CanvasEmitterHandle; detach: () => void } | undefined
  /**
   * QUANTA_WEB_AGENT_STATE — per-connection agent-state forwarder (gate ON
   * only). `open()` subscribes this socket to the daemon's agent-state source;
   * `close()` unsubscribes so we never forward to a dead socket. `undefined` ⇒
   * gate OFF (byte-identical: no sink, no frames). The detach closure
   * unsubscribes from the shared agent-state source.
   */
  agentState: { detach: () => void } | undefined
}

const applySurfaceSubscription = (
  ws: ServerWebSocket<WSData>,
  config: Pick<
    WebDaemonServerConfig,
    "agentStatePorts" | "canvasPorts" | "observabilityPorts" | "supportedReadModels"
  >,
  subscription: SurfaceSubscription | undefined,
): void => {
  const resolved = resolveReadModels(config.supportedReadModels, subscription)

  ws.data.observability?.stop()
  ws.data.observability = undefined
  if (resolved.observability.status === "subscribed") {
    ws.data.observability = attachObservabilitySink(ws, config.observabilityPorts) ?? undefined
  }

  ws.data.canvas?.detach()
  ws.data.canvas = undefined
  if (resolved.canvas.status === "subscribed") {
    ws.data.canvas = attachCanvasSink(ws, config.canvasPorts) ?? undefined
  }

  ws.data.agentState?.detach()
  ws.data.agentState = undefined
  if (resolved.agentState.status === "subscribed") {
    ws.data.agentState = attachAgentStateSink(ws, config.agentStatePorts) ?? undefined
  }
}

/**
 * Reconnect-replay bound (WS resume seam). When a client reconnects it sends
 * `connect{resumeFromSeq}` and the bridge replays the events with `seq >
 * resumeFromSeq` to that transport instead of a full snapshot. That replay is
 * served from the bridge's IN-MEMORY tail, whose size we cap here via
 * `replayWindow` so a long-lived daemon session never replays unbounded
 * history. A resume whose seq is older than this window falls back to a full
 * snapshot (the bridge's existing `planSessionReplay` fallback) so the client
 * resets cleanly. `128` matches the bridge's own default tail magnitude — we
 * pass it EXPLICITLY so the bound is a deliberate daemon contract rather than
 * an implicit default, and so the persisted SQLite thread store (full history)
 * stays the authority for deep transcript hydration on page reload.
 */
const WEB_DAEMON_REPLAY_WINDOW = 128

/**
 * Multi-client shared-session mode (v2):
 *   - The daemon creates ONE session at boot via `runtime.createSession`.
 *   - Every WebSocket connection attaches its own `SessionTransport` to
 *     the SAME session, so all connected clients see the same transcript
 *     and any one of them can advance the turn.
 *   - The per-WS `RegisteredSession.session` field still points at the
 *     shared session for `registry.has/size` accounting; `drop()` MUST
 *     NOT call `session.close()` (the daemon shutdown path closes it
 *     exactly once via `runtime.close`).
 */
const buildRegisteredSession = async (
  registry: SessionRegistry,
  socketKey: object,
  socket: BunWebSocketAdapter,
  sharedSession: RuntimeSession,
): Promise<void> => {
  const transport: SessionTransport = wrapWebSocketLikeAsSessionTransport(socket.socket)
  const connected = await sharedSession.attachSessionTransport(transport, {
    replayWindow: WEB_DAEMON_REPLAY_WINDOW,
  })
  const entry: RegisteredSession = {
    session: sharedSession,
    transport,
    connected,
  }
  registry.add(socketKey, entry)
}

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
   * T02 — optional thread-follower co-control dispatcher. Gate OFF
   * (`QUANTA_THIN_CLIENT_DISPATCH` unset) ⇒ absent ⇒ a `followerVerb` frame
   * falls through to the session bridge (and no conversation-action port is
   * wired, byte-identical). Populated by `./index.ts` from the session facade.
   */
  readonly followerCoControl?: FollowerCoControlDispatcher
}

/**
 * QUANTA_WEB_AGENT_STATE — peek an inbound text frame for an OUT-OF-BAND
 * `planInputAnswer` (the mirror of the agent-state OUTBOUND frame). Returns the
 * `{promptId, decision, text}` triple when the frame is a well-formed answer,
 * else `null` (so the frame falls through to the session bridge unchanged).
 *
 * NO-THROW: a non-JSON / non-matching frame returns `null` rather than throwing.
 * This is NOT a `SessionCommand` — it never reaches the kernel reducer.
 */
export const peekPlanInputAnswer = (
  raw: string,
): { promptId: string; decision: "answer" | "cancelled"; text: string } | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (obj.kind !== "planInputAnswer") return null
  if (typeof obj.promptId !== "string") return null
  const decision = obj.decision === "answer" ? "answer" : "cancelled"
  return {
    promptId: obj.promptId,
    decision,
    text: typeof obj.text === "string" ? obj.text : "",
  }
}

/** Parse QUANTA_FOLLOWER_APPROVAL_TIMEOUT_MS — the ms deadline for a follower to
 *  respond to a pending approval. 0 / unset / invalid ⇒ 0 (DISABLED ⇒ the
 *  coordinator passes relays straight through, byte-identical to no timeout). */
export const parseFollowerApprovalTimeoutMs = (raw: string | undefined): number => {
  if (raw === undefined) return 0
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : 0
}

export const startWebDaemon = async (config: WebDaemonServerConfig): Promise<WebDaemonHandle> => {
  const runtime = await config.runtimeFactory()
  // ONE shared session for the whole daemon lifetime. New WS connections
  // join the same session instead of minting a fresh one — see the
  // `buildRegisteredSession` comment above.
  const sharedSession = await runtime.createSession(config.sessionConfig)
  const registry = createSessionRegistry()
  const startedAt = performance.now()

  // SQLite-backed thread persistence — append every SessionEvent on the
  // shared session to `~/.quanta/web-daemon/threads.db` (override path
  // via `QUANTA_WEB_DB_DIR`). Disable by setting `QUANTA_WEB_DB=off`.
  const threadStore = gateDisabled(process.env, "QUANTA_WEB_DB") ? null : openThreadStore()
  let unsubPersist: (() => void) | null = null
  if (threadStore !== null) {
    threadStore.upsertThread({ id: sharedSession.sessionId })
    unsubPersist = sharedSession.subscribe((event) => {
      try {
        threadStore.appendEvent(sharedSession.sessionId, event)
      } catch (error) {
        logger.warn("web-daemon: sqlite append failed", {
          error: errMessage(error),
        })
      }
    })
    logger.info("web-daemon: thread persistence enabled", {
      sessionId: sharedSession.sessionId,
    })
  }

  // T02 — follower approval-relay TIMEOUT coordinator. Present iff the follower
  // co-control gate minted a dispatcher. `respond` routes a follower's decision
  // through the SAME `approval.respond` command a local client uses (→ the host
  // resolver's LIVE HARD_DENY re-check). The deadline is OPT-IN via
  // QUANTA_FOLLOWER_APPROVAL_TIMEOUT_MS (0/unset ⇒ pass-through, byte-identical):
  // when set, an unanswered approval times out to a fail-safe DENY and a late
  // follower relay is dropped (no stale-decision). The sweep timer + the
  // requested/resolved subscription run only when the deadline is enabled.
  const followerApprovalTimeoutMs = parseFollowerApprovalTimeoutMs(
    process.env.QUANTA_FOLLOWER_APPROVAL_TIMEOUT_MS,
  )
  const followerApproval =
    config.followerCoControl !== undefined
      ? createFollowerApprovalCoordinator({
          respond: (id, decision, steer) => {
            void sharedSession.approval
              .respond(id, decision, steer !== undefined ? { steer } : undefined)
              .catch((error) =>
                logger.warn("web-daemon: follower approval respond failed", {
                  error: errMessage(error),
                }),
              )
          },
          now: () => Date.now(),
          timeoutMs: followerApprovalTimeoutMs,
        })
      : undefined
  let followerApprovalUnsub: (() => void) | null = null
  let followerSweepTimer: ReturnType<typeof setInterval> | null = null
  if (followerApproval !== undefined && followerApprovalTimeoutMs > 0) {
    followerApprovalUnsub = sharedSession.subscribe((event) => {
      if (event.type === "approval.requested") followerApproval.open(event.approval.approvalId)
      else if (event.type === "approval.resolved") followerApproval.close(event.approvalId)
    })
    // Sweep at ~quarter-deadline granularity (min 250ms) so a timed-out approval
    // is denied promptly. `unref` so the timer never keeps the process alive.
    followerSweepTimer = setInterval(
      () => {
        followerApproval.sweep()
        // Evict terminal entries each tick so the tracker map stays bounded on a
        // long-lived shared-session daemon (the kernel reducer guards a late
        // pruned-relay double-resolve, so aggressive prune is safe).
        followerApproval.prune()
      },
      Math.max(250, Math.floor(followerApprovalTimeoutMs / 4)),
    )
    followerSweepTimer.unref?.()
  }

  // Bearer-auth gate shared by every authenticated route (WS upgrade + the
  // `/threads`, `/config`, `/auth/*` HTTP routes). Returns a 401 `Response`
  // when a token is configured AND the request fails to present a matching
  // one; returns `null` (allow) when no token is configured or the presented
  // token matches. Extracted from five byte-identical inline checks so each
  // route is a one-line `const denied = requireAuth(url, req); if (denied) …`.
  const requireAuth = (url: URL, req: Request): Response | null => {
    if (config.authToken === undefined) return null
    const presented = extractToken(url, req.headers.get("authorization"))
    if (presented === undefined || !constantTimeEquals(presented, config.authToken)) {
      return authReject()
    }
    return null
  }

  const tryUpgrade = (req: Request, server: Server<WSData>): Response | undefined => {
    const url = new URL(req.url)
    if (url.pathname !== "/" && url.pathname !== "/ws") return undefined
    if (config.authToken !== undefined) {
      const presented = extractToken(url, req.headers.get("authorization"))
      if (presented === undefined || !constantTimeEquals(presented, config.authToken)) {
        return authReject()
      }
    }
    const upgraded = server.upgrade(req, {
      data: {
        adapter: undefined,
        observability: undefined,
        canvas: undefined,
        agentState: undefined,
      },
    })
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
      // CORS preflight — cross-origin frontends (Vite dev on :5173, Tauri
      // tauri://localhost, etc.) need this OR every POST/DELETE fails.
      if (req.method === "OPTIONS") {
        return handlePreflight(req)
      }
      if (url.pathname === "/health" && req.method === "GET") {
        const health: WebDaemonHealth = {
          status: "ok",
          sessions: registry.size(),
          uptime_ms: Math.round(performance.now() - startedAt),
        }
        return jsonResponse(200, health)
      }
      if (url.pathname === "/network" && req.method === "GET") {
        // Reachable URL set so the UI can show every interface the daemon
        // is actually listening on (loopback + each non-internal IPv4/IPv6
        // when bound to `0.0.0.0` / `::`). Auth-free — only contains
        // host/port info; the token itself stays in the WS upgrade path.
        const port = server.port ?? config.port
        const ips = collectReachableIps(config.bind)
        const wsUrls = ips.map((entry) => ({
          label: entry.label,
          family: entry.family,
          wsUrl: `ws://${formatHost(entry.address, entry.family)}:${port}/`,
          httpUrl: `http://${formatHost(entry.address, entry.family)}:${port}/`,
        }))
        return jsonResponse(200, { port, bind: config.bind, urls: wsUrls })
      }
      // Thread persistence read-side. `GET /threads` lists every persisted
      // thread (most-recent first); `GET /threads/:id/events?since=N` returns
      // the SessionEvent log for that thread so a reloaded client can rebuild
      // its transcript without losing what the previous tab saw. Both require
      // the same bearer auth as WS upgrade. Disabled (404) when persistence
      // is off (`QUANTA_WEB_DB=off`).
      if (url.pathname === "/threads" && req.method === "GET") {
        const denied = requireAuth(url, req)
        if (denied !== null) return denied
        if (threadStore === null) {
          return jsonResponse(404, { error: "persistence_disabled" })
        }
        return jsonResponse(200, { threads: threadStore.listThreads() })
      }
      // ADR-0503 P3 — unified knob catalog for the web settings UI (read-only;
      // mutation stays the closed-allowlist POST /config). Secrets are absent
      // from the inventory by construction, so nothing here leaks credentials.
      if (url.pathname === "/api/knobs" && req.method === "GET") {
        const denied = requireAuth(url, req)
        if (denied !== null) return denied
        const catalog = buildWebKnobCatalog()
        const current = resolveCatalogValues(catalog, process.env)
        const grouped = [...catalogByGroup(catalog).entries()].map(([group, knobs]) => ({
          group,
          knobs: knobs.map((k) => {
            const v = current.get(k.envKey)
            // webSafeKnobValue redacts CUSTOM string values (paths / credential-
            // helper commands / policy JSON live in string knobs); bool/int/enum
            // + registry defaults are safe. (security re-audit jun-7.)
            return {
              ...k,
              value: webSafeKnobValue(k.kind, v),
              source: v?.source,
              isDefault: v?.isDefault,
            }
          }),
        }))
        return jsonResponse(200, { total: catalog.size, groups: grouped })
      }
      // Phase 1 (jun-9-cli-web-parity ticket 05) — OUT-OF-BAND read-only readouts.
      // `GET /readout/:name` reads the live session snapshot (lease-free — no WS
      // single-writer contention, so it works WHILE the agent is mid-turn,
      // exactly when you want to look) and returns the rendered text. Same bearer
      // auth as the other routes. Unknown name ⇒ 404 (typo); recognized-but-
      // pending host accessor ⇒ 200 with a graceful "not wired" body.
      {
        const readoutMatch = url.pathname.match(/^\/readout\/([a-z-]+)$/)
        if (readoutMatch !== null && req.method === "GET") {
          const denied = requireAuth(url, req)
          if (denied !== null) return denied
          const name = readoutMatch[1] as string
          return sharedSession.snapshot().then((snap) => {
            const result = renderReadout(name, snap)
            return jsonResponse(result.isError ? 404 : 200, result)
          })
        }
      }
      {
        const eventsMatch = url.pathname.match(/^\/threads\/([^/]+)\/events$/)
        if (eventsMatch !== null && req.method === "GET") {
          const denied = requireAuth(url, req)
          if (denied !== null) return denied
          if (threadStore === null) {
            return jsonResponse(404, { error: "persistence_disabled" })
          }
          const threadId = decodeURIComponent(eventsMatch[1] ?? "")
          const sinceRaw = url.searchParams.get("since")
          const since = sinceRaw === null ? 0 : Number.parseInt(sinceRaw, 10)
          const sinceSeq = Number.isFinite(since) && since >= 0 ? since : 0
          return jsonResponse(200, {
            threadId,
            events: threadStore.loadEvents(threadId, sinceSeq),
          })
        }
      }
      if (url.pathname === "/config" && req.method === "POST") {
        // Dynamic LLM knob update via slash commands. Mutates `process.env`
        // so the next adapter call picks it up; closed allowlist of keys
        // keeps the surface tight (no arbitrary env injection). Auth: same
        // bearer token as WS upgrade. Multi-client implication: all
        // attached clients see the change on their NEXT turn (shared
        // session).
        const denied = requireAuth(url, req)
        if (denied !== null) return denied
        return handleConfigPost(req)
      }
      // ChatGPT OAuth login/logout/whoami — same bearer auth; thin
      // wrappers around the CLI's existing `/login` slash compose
      // (`runBrowserFlow` → `exchangeCode` → `writeToken`).
      if (url.pathname.startsWith("/auth/") && (req.method === "POST" || req.method === "GET")) {
        const denied = requireAuth(url, req)
        if (denied !== null) return denied
        if (url.pathname === "/auth/login" && req.method === "POST") return handleAuthLoginStart()
        if (url.pathname === "/auth/logout" && req.method === "POST") return handleAuthLogout()
        if (url.pathname === "/auth/status" && req.method === "GET") return handleAuthStatus()
        return jsonResponse(404, { error: "unknown_auth_route", path: url.pathname })
      }
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const resp = tryUpgrade(req, srv)
        if (resp !== undefined) return resp
        // Upgrade succeeded — Bun consumed the request.
        return new Response(null, { status: 101 })
      }
      // Static SPA serve — every other GET tries to resolve against the
      // built frontend dist (Vite output). Lets the daemon double as the
      // web host so a phone / sibling laptop can hit
      // `http://<LAN-IP>:<port>/` and load the same UI Tauri renders
      // locally. `QUANTA_WEB_DIST` overrides the dist path; absent ⇒
      // try the in-repo default + give up with 404 so dev-mode (Vite-only)
      // stays usable as before.
      if (req.method === "GET") {
        const staticResp = serveStaticSpa(url.pathname)
        if (staticResp !== null) return staticResp
      }
      return new Response("not found", { status: 404 })
    },
    websocket: {
      async open(ws: ServerWebSocket<WSData>) {
        const adapter = createBunWebSocketAdapter(ws as unknown as BunServerWebSocketLike)
        // Attach adapter immediately so a fast inbound frame is buffered to
        // the right adapter; the registered session is filled in below.
        ws.data.adapter = adapter
        // Backward-compat default: a raw/legacy socket that has not sent the
        // explicit `connect.surfaceSubscription` handshake still receives the
        // historical full side-channel fan-out. A later `connect` frame can
        // narrow this set intentionally via `applySurfaceSubscription(...)`.
        applySurfaceSubscription(ws, config, undefined)
        try {
          await buildRegisteredSession(registry, ws, adapter, sharedSession)
        } catch (error) {
          logger.error("web-daemon: failed to create runtime session", {
            error: errMessage(error),
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
        // App-level keepalive: a client `heartbeat` ping is answered with a
        // `pong` BEFORE the frame reaches the session bridge. Heartbeats are
        // connection-level (no handshake / session state), so we short-circuit
        // them here — the bridge never sees them and its 5-kind contract is
        // unchanged. Any non-heartbeat frame (and any binary/undecodable
        // frame) falls through to the adapter exactly as before.
        if (typeof raw === "string") {
          const decoded = tryDecodeSessionTransportMessage(raw)
          // A heartbeat is consumed here (pong reply / terminal) so the bridge
          // never sees it — its 5-kind contract is unchanged. Any non-heartbeat
          // frame falls through to the adapter exactly as before.
          if (replyToHeartbeat(ws, decoded)) return
          if (decoded?.kind === "connect") {
            applySurfaceSubscription(ws, config, decoded.surfaceSubscription)
          }
          // QUANTA_WEB_AGENT_STATE — the OUT-OF-BAND INBOUND answer frame
          // (mirror of the agent-state OUTBOUND channel). Peek BEFORE the
          // session bridge: a `planInputAnswer` resolves a paused agent's
          // `request_user_input` prompt and is CONSUMED here (NOT a
          // `SessionCommand`, never reaches the kernel reducer). Gate OFF ⇒
          // `userInputPorts` absent ⇒ the resolve is a no-op (and the tool was
          // never registered, byte-identical). A frame that is not an answer
          // falls through to the adapter exactly as before.
          const answer = peekPlanInputAnswer(raw)
          if (answer !== null) {
            config.userInputPorts?.handle.resolve(
              answer.promptId,
              answer.decision === "answer"
                ? { decision: "answer", text: answer.text }
                : { decision: "cancelled" },
            )
            return
          }
          // T02 — a `followerVerb` frame (steer/interrupt/set-queue-mode) from a
          // 2nd client is CONSUMED here (NOT a SessionCommand): route it to the
          // co-control dispatcher whose sinks drive the live conversation-action
          // surface. Gate OFF ⇒ `followerCoControl` absent ⇒ the frame falls
          // through to the bridge (byte-identical). Approvals ride approval.respond.
          if (config.followerCoControl !== undefined) {
            const verb = peekFollowerVerb(raw)
            if (verb !== null) {
              if (verb.kind === "command-approval-decision") {
                // Approval decisions ride the TIMEOUT coordinator (deadline/stale
                // + the resolver's live HARD_DENY re-check), NOT the FIRE path.
                followerApproval?.relay(verb.approvalId, verb.decision, verb.steer)
              } else {
                config.followerCoControl.dispatch(verb)
              }
              return
            }
          }
        }
        ws.data.adapter?.pushMessage(raw)
      },
      async close(ws: ServerWebSocket<WSData>) {
        ws.data.adapter?.handleClose()
        // ADR-0420 — detach the observability sink before evicting so the
        // emitter timer stops and no further frames target the dead socket.
        ws.data.observability?.stop()
        ws.data.observability = undefined
        // ADR-0440 — detach the canvas sink (unsubscribe from the usage source
        // + stop the emitter) before evicting so no frame targets a dead socket.
        ws.data.canvas?.detach()
        ws.data.canvas = undefined
        // QUANTA_WEB_AGENT_STATE — unsubscribe from the agent-state source
        // before evicting so no frame targets a dead socket.
        ws.data.agentState?.detach()
        ws.data.agentState = undefined
        // QUANTA_WEB_AGENT_STATE — cancel every pending `request_user_input` so
        // a paused agent's `await` settles with `{decision:"cancelled"}` instead
        // of hanging forever for an answer this (now-dead) socket can never
        // deliver. The inbound port is SHARED across connections, so this
        // resolves ALL pending requests — for the v1 shared-session daemon there
        // is one logical client, so a disconnect means no one can answer.
        // RESIDUAL EDGE: a turn-abort WITHOUT a socket disconnect leaves the
        // resolver lingering until the NEXT close or answer (the close path is
        // the only cancel trigger; an in-band turn cancel does not reach here).
        try {
          config.userInputPorts?.handle.cancelAll()
        } catch {
          // NO-THROW: a cancel must never break socket teardown / eviction.
        }
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
      if (unsubPersist !== null) {
        unsubPersist()
        unsubPersist = null
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
export { constantTimeEquals as _constantTimeEqualsForTest, extractToken as _extractTokenForTest }
