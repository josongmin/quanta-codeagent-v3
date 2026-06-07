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

import { networkInterfaces } from "node:os"
import type { Server, ServerWebSocket } from "bun"
import type { ContextUsageBreakdown } from "@/agent/context/usage-breakdown"
import { type SessionTransport, wrapWebSocketLikeAsSessionTransport } from "@/ipc/session"
import type { RuntimeSession } from "@/sdk/runtime"
import { errMessage, gateDisabled, logger } from "@/shared"
import { handleAuthLoginStart, handleAuthLogout, handleAuthStatus } from "./auth-routes"
import { type CanvasEmitterHandle, createCanvasEmitter } from "./canvas-emitter"
import {
  buildWebKnobCatalog,
  catalogByGroup,
  resolveCatalogValues,
  webSafeKnobValue,
} from "./knob-catalog-wire"
import {
  createObservabilityEmitter,
  type ObservabilityEmitterHandle,
} from "./observability-emitter"
import { openThreadStore } from "./persistence-sqlite"
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
}

/** Minimal `ServerWebSocket`-like surface the observability sink writes to.
 *  The daemon's `ServerWebSocket<WSData>` satisfies it; the hellgate passes a
 *  fake recording `.send(...)`. */
interface ObservabilitySendable {
  send(data: string | Uint8Array): unknown
}

/**
 * ADR-0420 — observability port bundle the daemon hands to each connection so
 * it can mint a per-connection emitter. Mirrors the emitter's option names
 * (consume-only — the emitter slice is sealed). All ports optional: the
 * `index.ts` composition root only passes the ones the live facade exposes.
 */
export interface ObservabilityPorts {
  readonly objective?: ObservabilityEmitterPort<"objective">
  readonly runLedger?: ObservabilityEmitterPort<"runLedger">
  readonly approvalSM?: ObservabilityEmitterPort<"approvalSM">
  readonly threadId?: string
  readonly intervalMs?: number
  /** Test seam — deterministic timer so the hellgate drives `tick()` itself. */
  readonly timer?: ObservabilityEmitterTimer
}

// Re-derive the port option types straight from the sealed emitter options so
// this surface can never drift from what `createObservabilityEmitter` accepts.
type ObservabilityEmitterOptions = NonNullable<Parameters<typeof createObservabilityEmitter>[0]>
type ObservabilityEmitterPort<K extends keyof ObservabilityEmitterOptions> = NonNullable<
  ObservabilityEmitterOptions[K]
>
type ObservabilityEmitterTimer = NonNullable<ObservabilityEmitterOptions["timer"]>

/**
 * ADR-0420 — bridge a served WebSocket to the observability emitter.
 *
 * Returns `null` when `ports` is absent (gate OFF ⇒ no sink, byte-identical).
 * Otherwise mints a per-connection emitter whose `ws` sink forwards encoded
 * frames straight to `ws.send(...)`. The first tick is a `observability.snapshot`
 * (the emitter's contract); subsequent ticks emit `observability.delta` when
 * the live ports differ. The returned handle's `stop()` MUST be called on
 * disconnect so the emitter stops writing to a dead socket.
 *
 * NO-THROW: a throwing `ws.send` is swallowed inside the emitter; mint never
 * throws on a hostile socket.
 */
export const attachObservabilitySink = (
  ws: ObservabilitySendable,
  ports: ObservabilityPorts | undefined,
): ObservabilityEmitterHandle | null => {
  if (ports === undefined) return null
  return createObservabilityEmitter({
    ws: {
      send: (frame: string): void => {
        try {
          ws.send(frame)
        } catch {
          // Dead/throwing socket — swallow. The emitter also guards, but we
          // belt-and-brace here so a non-emitter caller is equally safe.
        }
      },
    },
    ...(ports.objective !== undefined ? { objective: ports.objective } : {}),
    ...(ports.runLedger !== undefined ? { runLedger: ports.runLedger } : {}),
    ...(ports.approvalSM !== undefined ? { approvalSM: ports.approvalSM } : {}),
    ...(ports.threadId !== undefined ? { threadId: ports.threadId } : {}),
    ...(ports.intervalMs !== undefined ? { intervalMs: ports.intervalMs } : {}),
    ...(ports.timer !== undefined ? { timer: ports.timer } : {}),
  })
}

/**
 * ADR-0440 — canvas data source the daemon shares across connections.
 *
 * The agent loop's `onPromptAssembled` seam already computes the per-category
 * `ContextUsageBreakdown` (the SAME view the CLI `/context` renders); the
 * composition root pushes each new view into this source. Every connection
 * subscribes so its per-connection emitter forwards a `context.usage` frame.
 * `latest()` lets a fresh connection render the current usage immediately
 * (snapshot-on-connect) without waiting for the next turn.
 *
 * Diff frames (`tool.diff`) ride the SAME per-connection emitter; the live
 * agent-seam binding that surfaces a tool's before/after text is a documented
 * deferral (see canvas-emitter.ts / ADR-0440) — the emitter method + protocol
 * + frontend consumer are fully wired so the channel lights up the moment a
 * before/after seam exists.
 */
export interface CanvasUsageSource {
  /** Subscribe to subsequent usage views. Returns an unsubscribe closure. */
  subscribe(handler: (view: ContextUsageBreakdown) => void): () => void
  /** The most recently computed view, or undefined before the first turn. */
  latest(): ContextUsageBreakdown | undefined
}

/**
 * ADR-0440 wire-finish — a captured tool mutation a connection renders as a
 * `tool.diff` frame. Carries the full pre/post file text the agent's dispatch
 * seam handed the daemon (no recompute — `feedToolDiff` runs the line-diff
 * once). Structural mirror of `canvas-tool-diff-source.ts#CapturedToolDiff`.
 */
export interface CanvasToolDiff {
  readonly toolCallId: string
  readonly before: string
  readonly after: string
  readonly path?: string
}

/**
 * ADR-0440 wire-finish — canvas tool-diff source. Subscribe-only (unlike the
 * usage source there is NO `latest()` snapshot-on-connect: a diff is a
 * point-in-time mutation event, not retained state). Each connection's emitter
 * forwards every subsequent capture as a `tool.diff` frame.
 */
export interface CanvasToolDiffSource {
  /** Subscribe to subsequent tool mutations. Returns an unsubscribe closure. */
  subscribe(handler: (diff: CanvasToolDiff) => void): () => void
}

/**
 * ADR-0440 — canvas port bundle handed to each connection. All optional: the
 * `index.ts` composition root only passes what the live facade exposes. Gate
 * OFF ⇒ `index.ts` never builds this ⇒ no sink, byte-identical.
 */
export interface CanvasPorts {
  readonly usageSource?: CanvasUsageSource
  /**
   * ADR-0440 wire-finish — live tool-diff source (the agent dispatch seam feeds
   * it via `AgentConfig.onToolDiff`). Present only when `QUANTA_WEB_CANVAS=1`.
   * Absent ⇒ a connection forwards no `tool.diff` frames (byte-identical).
   */
  readonly toolDiffSource?: CanvasToolDiffSource
}

/**
 * ADR-0440 — bridge a served WebSocket to a per-connection canvas emitter.
 *
 * Returns `null` when `ports` is absent (gate OFF ⇒ no sink, byte-identical).
 * Otherwise mints an emitter whose `ws` sink forwards encoded canvas frames to
 * `ws.send(...)`, subscribes it to the shared usage source (immediately
 * forwarding the latest view as a snapshot-on-connect), and returns the handle
 * plus a `detach` closure that unsubscribes + stops the emitter. The caller
 * MUST call `detach()` on disconnect so we never emit to a dead socket.
 *
 * NO-THROW: a throwing `ws.send` is swallowed inside the emitter; mint never
 * throws on a hostile socket.
 */
export const attachCanvasSink = (
  ws: ObservabilitySendable,
  ports: CanvasPorts | undefined,
): { handle: CanvasEmitterHandle; detach: () => void } | null => {
  if (ports === undefined) return null
  const handle = createCanvasEmitter({
    ws: {
      send: (frame: string): void => {
        try {
          ws.send(frame)
        } catch {
          // Dead/throwing socket — swallow (emitter also guards internally).
        }
      },
    },
  })
  let unsubscribe: (() => void) | undefined
  const source = ports.usageSource
  if (source !== undefined) {
    // Snapshot-on-connect: render the current usage without waiting a turn.
    const current = source.latest()
    if (current !== undefined) handle.feedUsage(current)
    unsubscribe = source.subscribe((view) => handle.feedUsage(view))
  }
  // ADR-0440 wire-finish — subscribe this connection's emitter to the live
  // tool-diff source so a file-mutating tool's before/after becomes a
  // `tool.diff` frame. NO snapshot-on-connect (a diff is a point-in-time
  // mutation, not retained state) — diffs render from the next mutation
  // forward. `feedToolDiff` runs the line-diff math once + applies the caps.
  let unsubscribeDiffs: (() => void) | undefined
  const diffSource = ports.toolDiffSource
  if (diffSource !== undefined) {
    unsubscribeDiffs = diffSource.subscribe((diff) =>
      handle.feedToolDiff({
        toolCallId: diff.toolCallId,
        before: diff.before,
        after: diff.after,
        ...(diff.path !== undefined ? { path: diff.path } : {}),
      }),
    )
  }
  return {
    handle,
    detach: () => {
      unsubscribe?.()
      unsubscribeDiffs?.()
      handle.stop()
    },
  }
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

/**
 * Allowlist of `process.env` keys the `/config` HTTP endpoint may write.
 * The adapter layer reads these on every LLM call, so a successful POST
 * takes effect on the user's next turn (no daemon restart needed).
 *
 * Hard rules:
 *   - Keys are closed-enumerated (no arbitrary env injection).
 *   - Values are length-capped + character-allowlisted to head off
 *     accidental shell-style injection if the env is ever spliced
 *     into a child process command line in the future.
 */
const CONFIG_ALLOWED_KEYS = new Set([
  "QUANTA_FAST",
  "QUANTA_SERVICE_TIER",
  "QUANTA_MODEL",
  "QUANTA_REASONING_EFFORT",
])
const CONFIG_VALUE_PATTERN = /^[A-Za-z0-9_.:-]{0,64}$/

const handleConfigPost = async (req: Request): Promise<Response> => {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return jsonResponse(400, { error: "invalid_json" })
  }
  if (body === null || typeof body !== "object") {
    return jsonResponse(400, { error: "body_must_be_object" })
  }
  const entries = body as Record<string, unknown>
  const applied: Record<string, string | null> = {}
  for (const [key, raw] of Object.entries(entries)) {
    if (!CONFIG_ALLOWED_KEYS.has(key)) {
      return jsonResponse(400, { error: "unknown_key", key })
    }
    if (raw === null || raw === "") {
      delete process.env[key]
      applied[key] = null
      continue
    }
    if (typeof raw !== "string") {
      return jsonResponse(400, { error: "value_must_be_string_or_null", key })
    }
    if (!CONFIG_VALUE_PATTERN.test(raw)) {
      return jsonResponse(400, { error: "value_pattern_rejected", key })
    }
    process.env[key] = raw
    applied[key] = raw
  }
  logger.info("web-daemon: /config applied", applied)
  return jsonResponse(200, { ok: true, applied })
}

/** CORS headers — the frontend dev server (`localhost:5173`) is a
 *  different origin from the daemon (`localhost:4096`), so browser
 *  fetches need preflight + ACAO. Loopback-only dev; loose `*` is fine.
 *  When `Origin` is set we echo it (so credentialed requests would work
 *  if the frontend ever adds `credentials: "include"`). */
const corsHeaders = (req: Request | null): Record<string, string> => ({
  "access-control-allow-origin": req?.headers.get("origin") ?? "*",
  "access-control-allow-methods": "GET, POST, OPTIONS, DELETE",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
  vary: "Origin",
})

const handlePreflight = (req: Request): Response =>
  new Response(null, { status: 204, headers: corsHeaders(req) })

const jsonResponse = (status: number, body: unknown, req?: Request): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(req ?? null),
    },
  })

/* ---------- static SPA serve ------------------------------------------ */

const RESOLVED_DIST_DIR: string | null = (() => {
  const envOverride = process.env.QUANTA_WEB_DIST
  const candidates: string[] = []
  if (envOverride !== undefined && envOverride.length > 0) candidates.push(envOverride)
  candidates.push("apps/web-frontend/dist")
  candidates.push("./apps/web-frontend/dist")
  for (const c of candidates) {
    try {
      // Bun.file is lazy — check the index sentinel.
      const path = c.endsWith("/") ? `${c}index.html` : `${c}/index.html`
      // biome-ignore lint/style/noNonNullAssertion: presence-only probe
      const file = Bun.file(path)
      // Bun.file.size === 0 on miss; > 0 means it exists with content.
      // We don't await stat: `existsSync` is sync and well-defined here.
      void file
      // Use a sync existence test so we can pick the right candidate
      // without async at module init.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs")
      if (fs.existsSync(path)) return c.replace(/\/$/, "")
    } catch {
      // try next
    }
  }
  return null
})()

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
}

const mimeFor = (path: string): string => {
  const idx = path.lastIndexOf(".")
  if (idx < 0) return "application/octet-stream"
  return MIME_BY_EXT[path.slice(idx).toLowerCase()] ?? "application/octet-stream"
}

const serveStaticSpa = (
  pathname: string,
  distDir: string | null = RESOLVED_DIST_DIR,
): Response | null => {
  if (distDir === null) return null
  // Canonicalise — strip leading "/" so we can `join` safely; guard against
  // path traversal by rejecting any "..". SPA root → index.html.
  const cleaned = pathname.replace(/^\/+/, "")
  if (cleaned.includes("..")) return null
  // Root navigation ⇒ index.html. Any other path is served ONLY if a real
  // built asset exists there; an unknown path returns null so the caller
  // emits 404. We deliberately do NOT blanket-fall-back to index.html for
  // arbitrary unknown paths: that would let any unauthenticated path (e.g.
  // `/no-such-path`, `/admin`) resolve to 200, defeating the daemon's intent
  // that unknown HTTP paths are rejected. The bundled frontend has no
  // client-side router, so deep-link SPA fallback is not required.
  if (cleaned === "" || cleaned === "index.html") {
    const indexFile = Bun.file(`${distDir}/index.html`)
    if (indexFile.size === 0) return null
    return new Response(indexFile, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  }
  const candidate = `${distDir}/${cleaned}`
  const file = Bun.file(candidate)
  if (file.size === 0) return null
  return new Response(file, {
    status: 200,
    headers: { "content-type": mimeFor(candidate) },
  })
}

/** Test-only: exercise the static-SPA resolver against an arbitrary dist dir
 *  (the production `RESOLVED_DIST_DIR` is frozen at module init). Proves the
 *  auth-gate invariant — unknown paths return null (⇒ 404) even when a built
 *  frontend dist is present, while real assets + the SPA root still serve. */
export const _serveStaticSpaForTest = serveStaticSpa

/** IPv6 literals need brackets in URLs (RFC 3986 §3.2.2). */
const formatHost = (address: string, family: "IPv4" | "IPv6"): string =>
  family === "IPv6" ? `[${address}]` : address

interface ReachableIp {
  readonly label: string
  readonly family: "IPv4" | "IPv6"
  readonly address: string
}

/**
 * Resolve which interfaces a client could actually reach this daemon at.
 *
 * - `127.0.0.1` / `::1` / `localhost` bind ⇒ only loopback is reachable.
 * - `0.0.0.0` / `::` bind ⇒ every non-internal interface plus loopback.
 * - Specific IP bind ⇒ just that IP (loopback added only if same machine).
 *
 * IPv6 link-local (`fe80::*`) is dropped — its zone-id suffix isn't safe
 * inside a URL.
 */
const collectReachableIps = (bind: string): readonly ReachableIp[] => {
  const wildcard = bind === "0.0.0.0" || bind === "::" || bind === ""
  const loopback: ReachableIp =
    bind === "::" || bind === "::1"
      ? { label: "loopback", family: "IPv6", address: "::1" }
      : { label: "loopback", family: "IPv4", address: "127.0.0.1" }
  if (!wildcard && bind !== "0.0.0.0") {
    if (bind === "127.0.0.1" || bind === "::1" || bind === "localhost") {
      return [loopback]
    }
    return [
      loopback,
      {
        label: "bind",
        family: bind.includes(":") ? "IPv6" : "IPv4",
        address: bind,
      },
    ]
  }
  const out: ReachableIp[] = [loopback]
  const ifaces = networkInterfaces()
  for (const [name, list] of Object.entries(ifaces)) {
    if (list === undefined) continue
    for (const entry of list) {
      if (entry.internal) continue
      if (entry.family !== "IPv4" && entry.family !== "IPv6") continue
      // Drop IPv6 link-local — `fe80::%en0` URLs aren't broadly usable.
      if (entry.family === "IPv6" && entry.address.toLowerCase().startsWith("fe80")) {
        continue
      }
      out.push({
        label: name,
        family: entry.family,
        address: entry.address,
      })
    }
  }
  return out
}

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
  const connected = await sharedSession.attachSessionTransport(transport)
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
  readonly observabilityPorts?: ObservabilityPorts
  /**
   * ADR-0440 — optional canvas port bundle. Gate OFF ⇒ absent ⇒ the server
   * attaches no canvas sink (byte-identical). The composition root populates
   * it only when `QUANTA_WEB_CANVAS=1`.
   */
  readonly canvasPorts?: CanvasPorts
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
      data: { adapter: undefined, observability: undefined, canvas: undefined },
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
        // ADR-0420 — bridge this socket to the observability emitter (gate ON
        // only). `null` ⇒ gate OFF (byte-identical: no sink, no frames). The
        // emitter's first tick is a snapshot; deltas follow as the live ports
        // change. `close()` stops it so we never emit to a dead socket.
        ws.data.observability = attachObservabilitySink(ws, config.observabilityPorts) ?? undefined
        // ADR-0440 — bridge this socket to the canvas emitter (gate ON only).
        // `null` ⇒ gate OFF (byte-identical). Snapshot-on-connect forwards the
        // current usage view; `close()` detaches so no frame targets a dead
        // socket.
        ws.data.canvas = attachCanvasSink(ws, config.canvasPorts) ?? undefined
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
