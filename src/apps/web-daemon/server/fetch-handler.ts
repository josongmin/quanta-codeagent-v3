/**
 * `@/apps/web-daemon/server/fetch-handler` — the daemon's HTTP `fetch` route
 * table + the bearer-auth gate and WS upgrade probe it composes.
 *
 * Extracted verbatim from `startWebDaemon` so the parent stays under the
 * god-function ceiling. The route table is split into cohesive group helpers
 * (`tryStatusRoutes` / `tryReadRoutes` / `tryMutationRoutes`) the assembled
 * handler tries IN ORDER — each returns a `Response` (matched) or `undefined`
 * (fall through), preserving the original branch order EXACTLY. The handler
 * closes over the daemon's live locals via the `FetchHandlerDeps` bundle
 * (`server` is read lazily through `getServer` because the `Bun.serve` result
 * is assigned AFTER this handler is built). Behaviour is byte-identical to the
 * inline version: same route order, same status codes, same auth checks.
 */

import type { Server } from "bun"
import type { ArtifactPreviewResolver } from "@/host/runtime"
import type { RuntimeSession } from "@/sdk/runtime"
import {
  handleAuthLoginAttemptStatus,
  handleAuthLoginStart,
  handleAuthLogout,
  handleAuthStatus,
} from "../auth-routes"
import {
  buildWebKnobCatalog,
  catalogByGroup,
  resolveCatalogValues,
  webSafeKnobValue,
} from "../knob-catalog-wire"
import type { ThreadStore } from "../persistence-sqlite"
import { resolveReadout, type WebReadoutSources } from "../readout"
import type { WebDaemonServerConfig } from "../server"
import type { SessionRegistry } from "../session-registry"
import type { WebDaemonHealth } from "../types"
import { authReject, constantTimeEquals, extractToken } from "./auth"
import { handleConfigPost, handlePreflight, jsonResponse, serveStaticSpa } from "./http"
import { collectReachableIps, formatHost } from "./net"
import type { WSData } from "./ws-data"

export interface FetchHandlerDeps {
  readonly config: WebDaemonServerConfig
  readonly registry: SessionRegistry
  readonly startedAt: number
  readonly threadStore: ThreadStore | null
  readonly sharedSession: RuntimeSession
  /** A2 — the read-only `quanta-artifact://` preview resolver for
   *  `GET /artifact/:id`. Absent (gate `QUANTA_ARTIFACT_STORE` off) ⇒ the route
   *  404s (byte-identical). */
  readonly artifactPreviewResolver?: ArtifactPreviewResolver
  /** UUX-1-11 — read-only accessor bundle for the source-backed readouts
   *  (`/agents`, `/plan`, `/skills`, `/memory`, `/cost`, `/context`). Absent ⇒
   *  every source-backed readout degrades to its honest missing-source line. */
  readonly readoutSources?: WebReadoutSources
  /** Lazy accessor — the `Bun.serve` handle is assigned after this is built. */
  readonly getServer: () => Server<WSData>
  /** P1 Phase 2 (jul-11) — the thread the live session currently represents
   *  (swap target, or the session id before any swap). The `/events` boundary
   *  reads it so a hydrated (swapped-onto) thread reports `live-attach`, not
   *  read-only. Absent ⇒ falls back to the session id (pre-swap behavior). */
  readonly activeThreadId?: () => string
  /** Test/embedding seam for the terminal auth-route handlers.  The auth gate
   * stays in this route table, so callers can prove a rejected bearer never
   * reaches an effectful OAuth/file handler. */
  readonly authRoutes?: AuthRouteHandlers
}

type RouteResult = Response | Promise<Response> | undefined
/** Bearer-auth gate: a 401 `Response` (denied) or `null` (allow). */
type RequireAuth = (url: URL, req: Request) => Response | null

type FetchHandler = (req: Request, srv: Server<WSData>) => RouteResult

export interface AuthRouteHandlers {
  readonly login: () => Promise<Response>
  readonly loginStatus: (url: URL) => Promise<Response>
  readonly logout: () => Promise<Response>
  readonly status: () => Promise<Response>
}

const defaultAuthRoutes: AuthRouteHandlers = {
  login: handleAuthLoginStart,
  loginStatus: handleAuthLoginAttemptStatus,
  logout: handleAuthLogout,
  status: handleAuthStatus,
}

/**
 * Bearer-auth gate shared by every authenticated route (WS upgrade + the
 * `/threads`, `/config`, `/auth/*` HTTP routes). Returns a 401 `Response` when a
 * token is configured AND the request fails to present a matching one; returns
 * `null` (allow) when no token is configured or the presented token matches.
 */
const makeRequireAuth = (config: WebDaemonServerConfig): RequireAuth => {
  return (url, req) => {
    if (config.authToken === undefined) return null
    const presented = extractToken(url, req.headers.get("authorization"))
    if (presented === undefined || !constantTimeEquals(presented, config.authToken)) {
      return authReject()
    }
    return null
  }
}

/** Auth-free status routes — `GET /health` and `GET /network`. */
const tryStatusRoutes = (url: URL, req: Request, deps: FetchHandlerDeps): RouteResult => {
  const { config, registry, startedAt } = deps
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
    const port = deps.getServer().port ?? config.port
    const ips = collectReachableIps(config.bind)
    const wsUrls = ips.map((entry) => ({
      label: entry.label,
      family: entry.family,
      wsUrl: `ws://${formatHost(entry.address, entry.family)}:${port}/`,
      httpUrl: `http://${formatHost(entry.address, entry.family)}:${port}/`,
    }))
    return jsonResponse(200, { port, bind: config.bind, urls: wsUrls })
  }
  return undefined
}

/**
 * ADR-0503 P3 — `GET /api/knobs`, the unified knob catalog the web settings UI
 * reads. Mutation stays the closed-allowlist `POST /config`.
 *
 * A unit because the REDACTION is the point and must stay visible beside the
 * route: `webSafeKnobValue` is applied to EVERY value on the way out (CUSTOM
 * string knobs carry paths, credential-helper commands, and policy JSON), so
 * the projection lives in one place rather than being re-derived per group.
 * Secrets are absent from the inventory by construction. (security re-audit
 * jun-7; static-locked by `api-knobs-no-leak-hellgate`.)
 */
const tryKnobsRoute = (url: URL, req: Request, requireAuth: RequireAuth): RouteResult => {
  if (url.pathname !== "/api/knobs" || req.method !== "GET") return undefined
  const denied = requireAuth(url, req)
  if (denied !== null) return denied
  const catalog = buildWebKnobCatalog()
  const current = resolveCatalogValues(catalog, process.env)
  const grouped = [...catalogByGroup(catalog).entries()].map(([group, knobs]) => ({
    group,
    knobs: knobs.map((k) => {
      const v = current.get(k.envKey)
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

/**
 * The `GET /threads/:id/events` body: the persisted log from `?since`, plus the
 * honest `boundary` label.
 *
 * A unit because the two facts it reports are one answer: a malformed / absent
 * `since` degrades to 0 (a clean full replay, never a crash), and `boundary`
 * tells the client whether new turns will coincide with this history
 * (`live-attach`) or not (`read-only-history`). Reporting one without the other
 * is what would let a client silently treat read-only history as live.
 */
const threadEventsResponse = (
  threadStore: NonNullable<FetchHandlerDeps["threadStore"]>,
  threadId: string,
  sinceRaw: string | null,
  liveThreadId: string,
): Response => {
  const since = sinceRaw === null ? 0 : Number.parseInt(sinceRaw, 10)
  const sinceSeq = Number.isFinite(since) && since >= 0 ? since : 0
  const boundary = threadId === liveThreadId ? "live-attach" : "read-only-history"
  return jsonResponse(200, {
    threadId,
    boundary,
    events: threadStore.loadEvents(threadId, sinceSeq),
  })
}

/**
 * `GET /threads/:id/events` — one thread's persisted transcript.
 *
 * A unit because this route carries its own boundary story (below): it is the
 * only read seam addressed by an ARBITRARY thread id rather than the live
 * session, so its auth scope and its `live-attach` vs `read-only-history`
 * answer belong together, not scattered through the read-route table.
 */
const tryThreadEventsRoute = (
  url: URL,
  req: Request,
  deps: FetchHandlerDeps,
  requireAuth: RequireAuth,
  liveThreadId: () => string,
): RouteResult => {
  const { threadStore } = deps
  // `GET /threads/:id/events?since=N` returns the SessionEvent log for that
  // thread so a reloaded client can rebuild its transcript without losing what
  // the previous tab saw. B2 — this is ALSO the cross-surface thread RESUME
  // seam: a `?thread=<id>` deeplink asks the web surface to OPEN an
  // externally-addressed thread, and this thread-ADDRESSED route serves THAT
  // thread's persisted transcript for ANY id (not only the live session id).
  //
  // HONEST BOUNDARY (single-shared-session daemon): the daemon runs ONE live
  // `RuntimeSession` whose id is server-minted; the LIVE session cannot be
  // switched to an arbitrary thread (every WS client joins the SAME live
  // transcript). So a resume of a DIFFERENT thread is READ-ONLY HISTORY — new
  // turns still advance the live session. We report which case applies in
  // `boundary` so the client can be honest with the user: `live-attach` when the
  // requested id IS the live session (history + new turns coincide), else
  // `read-only-history`. An unknown / malformed id is a CLEAN empty log (200,
  // `events:[]`) — never a crash or an auth-bypassing error.
  //
  // OWNERSHIP / AUTH SCOPE: this is a SINGLE-TENANT daemon (one shared session,
  // one bearer token). Any client that presents the daemon's bearer token may
  // read any persisted thread on THIS daemon — the token IS the ownership
  // boundary. There is no per-thread ACL because there is no multi-tenant
  // identity model here; a future multi-user daemon would gate `threadId`
  // against the caller's identity at this exact seam.
  const eventsMatch = url.pathname.match(/^\/threads\/([^/]+)\/events$/)
  if (eventsMatch !== null && req.method === "GET") {
    const denied = requireAuth(url, req)
    if (denied !== null) return denied
    if (threadStore === null) {
      return jsonResponse(404, { error: "persistence_disabled" })
    }
    return threadEventsResponse(
      threadStore,
      decodeURIComponent(eventsMatch[1] ?? ""),
      url.searchParams.get("since"),
      liveThreadId(),
    )
  }
  return undefined
}

/**
 * `GET /artifact/:id` — a registered artifact's jailed preview bytes.
 *
 * A unit because the route is a pure gate: authenticate, then hand the opaque
 * registry id to the resolver, which owns the traversal rejection and the jail
 * assertion. Keeping it separate is what stops a future edit from growing path
 * handling here, outside the resolver's jail.
 */
const tryArtifactRoute = (
  url: URL,
  req: Request,
  deps: FetchHandlerDeps,
  requireAuth: RequireAuth,
): RouteResult => {
  // A2 — `GET /artifact/:id` serves a registered artifact's JAILED preview bytes
  // read-only. The `:id` is the opaque registry id carried in the
  // `quanta-artifact://<id>` locator (the surface strips the scheme). Disabled
  // (404 `artifact_store_disabled`) when the resolver is absent (gate OFF). This
  // is the consumer for the resolver minted at the composition root — the
  // `quanta-artifact://` scheme is now resolvable by a surface.
  const artifactMatch = url.pathname.match(/^\/artifact\/([^/]+)$/)
  if (artifactMatch !== null && req.method === "GET") {
    const denied = requireAuth(url, req)
    if (denied !== null) return denied
    return tryResolveArtifact(deps.artifactPreviewResolver, artifactMatch[1] ?? "")
  }
  return undefined
}

/** Authenticated read routes — `/threads`, `/api/knobs`, `/readout/:name`,
 *  `/threads/:id/events`. Each requires the same bearer auth as WS upgrade. */
const tryReadRoutes = (
  url: URL,
  req: Request,
  deps: FetchHandlerDeps,
  requireAuth: RequireAuth,
): RouteResult => {
  const { threadStore, sharedSession } = deps
  const liveThreadId = (): string => deps.activeThreadId?.() ?? sharedSession.sessionId
  // Thread persistence read-side. `GET /threads` lists every persisted
  // thread (most-recent first). Disabled (404) when persistence is off.
  if (url.pathname === "/threads" && req.method === "GET") {
    const denied = requireAuth(url, req)
    if (denied !== null) return denied
    if (threadStore === null) {
      return jsonResponse(404, { error: "persistence_disabled" })
    }
    return jsonResponse(200, { threads: threadStore.listThreads() })
  }
  const knobs = tryKnobsRoute(url, req, requireAuth)
  if (knobs !== undefined) return knobs
  // OUT-OF-BAND read-only readouts (jun-9 ticket 05 + UUX-1-11 sources).
  // `GET /readout/:name` reads the live session snapshot (lease-free — no WS
  // single-writer contention, so it works WHILE the agent is mid-turn, exactly
  // when you want to look) plus the composition root's read-accessors, and
  // returns the rendered text. Unknown name ⇒ 404 (typo); recognized name whose
  // source is absent ⇒ 200 with a graceful body NAMING the missing piece; a
  // THROWING source ⇒ 200 graceful error payload (`resolveReadout` is total —
  // this route can never 500 on a readout).
  {
    const readoutMatch = url.pathname.match(/^\/readout\/([a-z-]+)$/)
    if (readoutMatch !== null && req.method === "GET") {
      const denied = requireAuth(url, req)
      if (denied !== null) return denied
      const name = readoutMatch[1] as string
      return sharedSession
        .snapshot()
        .then((snap) => resolveReadout(name, snap, deps.readoutSources ?? {}))
        .then((result) => jsonResponse(result.isError ? 404 : 200, result))
    }
  }
  return (
    tryThreadEventsRoute(url, req, deps, requireAuth, liveThreadId) ??
    tryArtifactRoute(url, req, deps, requireAuth)
  )
}

/** A2 — resolve `:id` to jailed preview bytes via the read-only resolver. The
 *  resolver id-only lookup rejects `file://` / absolute / `../` traversal (they
 *  can never be a registry id) and jail-asserts the resolved path, so the bytes
 *  stay JAILED. Maps the typed outcome to an HTTP status; a resolver read never
 *  serves an fs path — only registry-recorded bytes. */
const tryResolveArtifact = async (
  resolver: ArtifactPreviewResolver | undefined,
  rawId: string,
): Promise<Response> => {
  if (resolver === undefined) {
    return jsonResponse(404, { error: "artifact_store_disabled" })
  }
  const id = decodeURIComponent(rawId)
  const outcome = await resolver.resolve(id)
  if (!outcome.ok) {
    // `bad_locator` / `not_found` / `escaped` ⇒ 404 (never reveal WHY beyond a
    // coarse not-found so a traversal probe learns nothing); `read_failed` ⇒ 500.
    const status = outcome.reason === "read_failed" ? 500 : 404
    return jsonResponse(status, { error: "artifact_unavailable", reason: outcome.reason })
  }
  // Serve the jailed bytes verbatim with the registry-recorded media type — the
  // surface renders with the RIGHT type without re-sniffing. `X-Content-Type-
  // Options: nosniff` so a browser cannot MIME-sniff the payload into a script.
  return new Response(outcome.preview.bytes, {
    status: 200,
    headers: {
      "content-type": outcome.preview.mediaType,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  })
}

/**
 * Dispatch one already-authenticated `/auth/*` sub-route.
 *
 * A unit because the closed list IS the surface: anything under `/auth/` that
 * is not named here gets a 404, so a new OAuth verb has to be added in one
 * visible place rather than falling through to the static SPA.
 */
const dispatchAuthRoute = (url: URL, req: Request, authRoutes: AuthRouteHandlers): RouteResult => {
  if (url.pathname === "/auth/login" && req.method === "POST") return authRoutes.login()
  // UUX-4-13 — login-attempt completion readback for the frontend's bounded
  // poll (login success/failure used to be logger-only).
  if (url.pathname === "/auth/login/status" && req.method === "GET") {
    return authRoutes.loginStatus(url)
  }
  if (url.pathname === "/auth/logout" && req.method === "POST") return authRoutes.logout()
  if (url.pathname === "/auth/status" && req.method === "GET") return authRoutes.status()
  return jsonResponse(404, { error: "unknown_auth_route", path: url.pathname })
}

/** Authenticated mutation/OAuth routes — `POST /config` + the `/auth/*` ChatGPT
 *  OAuth login/logout/whoami wrappers. Same bearer auth as WS upgrade. */
const tryMutationRoutes = (
  url: URL,
  req: Request,
  requireAuth: RequireAuth,
  authRoutes: AuthRouteHandlers,
): RouteResult => {
  if (url.pathname === "/config" && req.method === "POST") {
    // Dynamic LLM knob update via slash commands. Mutates `process.env`
    // so the next adapter call picks it up; closed allowlist of keys
    // keeps the surface tight (no arbitrary env injection). Multi-client
    // implication: all attached clients see the change on their NEXT turn.
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
    return dispatchAuthRoute(url, req, authRoutes)
  }
  return undefined
}

const makeTryUpgrade = (config: WebDaemonServerConfig) => {
  return (req: Request, server: Server<WSData>): Response | undefined => {
    const url = new URL(req.url)
    if (url.pathname !== "/" && url.pathname !== "/ws") return undefined
    if (config.authToken !== undefined) {
      const presented = extractToken(url, req.headers.get("authorization"))
      if (presented === undefined || !constantTimeEquals(presented, config.authToken)) {
        return authReject()
      }
    }
    // P1 Phase 2 — carry the opened thread id into the connection so `open()`
    // can swap the live session onto it (hydrate). Absent ⇒ no swap.
    const threadId = new URL(req.url).searchParams.get("thread") ?? undefined
    const upgraded = server.upgrade(req, {
      data: {
        adapter: undefined,
        observability: undefined,
        canvas: undefined,
        agentState: undefined,
        threadId,
      },
    })
    if (!upgraded) return new Response("upgrade failed", { status: 400 })
    // 101 is sent by Bun on successful upgrade — return undefined so Bun
    // owns the response.
    return undefined
  }
}

/**
 * Everything that is not a JSON route: hand a WebSocket request to the
 * upgrader, otherwise serve the built SPA, otherwise 404.
 *
 * A unit because this is the daemon's ONE fallthrough, and its order is
 * load-bearing — an upgrade request must never reach the static server (it
 * would be answered with HTML instead of a 101), and a non-GET must never reach
 * it at all.
 */
const serveUpgradeOrStatic = (
  req: Request,
  srv: Server<WSData>,
  pathname: string,
  tryUpgrade: (req: Request, server: Server<WSData>) => Response | undefined,
): Response => {
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
    const staticResp = serveStaticSpa(pathname)
    if (staticResp !== null) return staticResp
  }
  return new Response("not found", { status: 404 })
}

export const buildFetchHandler = (deps: FetchHandlerDeps): FetchHandler => {
  const { config } = deps
  const requireAuth = makeRequireAuth(config)
  const tryUpgrade = makeTryUpgrade(config)
  const authRoutes = deps.authRoutes ?? defaultAuthRoutes

  return (req, srv) => {
    const url = new URL(req.url)
    // CORS preflight — cross-origin frontends (Vite dev on :5173, Tauri
    // tauri://localhost, etc.) need this OR every POST/DELETE fails.
    if (req.method === "OPTIONS") {
      return handlePreflight(req)
    }
    const status = tryStatusRoutes(url, req, deps)
    if (status !== undefined) return status
    const read = tryReadRoutes(url, req, deps, requireAuth)
    if (read !== undefined) return read
    const mutation = tryMutationRoutes(url, req, requireAuth, authRoutes)
    if (mutation !== undefined) return mutation
    return serveUpgradeOrStatic(req, srv, url.pathname, tryUpgrade)
  }
}
