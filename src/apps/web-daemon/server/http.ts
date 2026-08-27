/**
 * `@/apps/web-daemon/server/http` — plain-HTTP route helpers.
 *
 * The CORS/JSON/preflight helpers, the closed-allowlist `POST /config` writer,
 * and the static-SPA resolver the daemon's `fetch` handler composes. All pure
 * (or `process.env`-mutating, in the config case) — no per-connection state.
 */

import { isSessionForbidden, logger } from "@/shared"

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
export const CONFIG_ALLOWED_KEYS = new Set([
  "QUANTA_FAST",
  "QUANTA_SERVICE_TIER",
  "QUANTA_MODEL",
  "QUANTA_REASONING_EFFORT",
  "QUANTA_REASONING_SUMMARY",
  "QUANTA_REASONING_VERBOSITY",
])
const CONFIG_VALUE_PATTERN = /^[A-Za-z0-9_.:-]{0,64}$/

/**
 * Pure per-key write-rejection for POST /config. Returns the rejection
 * {status,error} or null if the key MAY be written. Extracted (and exported) so
 * the security branches have direct teeth — esp. the defense-in-depth 403 that is
 * otherwise unreachable while CONFIG_ALLOWED_KEYS ∩ SESSION_FORBIDDEN = ∅.
 *   - not in the closed allowlist            → 400 unknown_key
 *   - allowlisted BUT a strict-security knob → 403 forbidden_security_knob
 *     (this HTTP writer mutates process.env directly, bypassing the
 *      setKnobOverride chokepoint, so it MUST re-honor the carve-out even if a
 *      forbidden knob is ever wrongly added to the allowlist).
 */
export const configKeyWriteRejection = (key: string): { status: number; error: string } | null => {
  if (!CONFIG_ALLOWED_KEYS.has(key)) return { status: 400, error: "unknown_key" }
  if (isSessionForbidden(key)) return { status: 403, error: "forbidden_security_knob" }
  return null
}

export const handleConfigPost = async (req: Request): Promise<Response> => {
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
    const rejection = configKeyWriteRejection(key)
    if (rejection) {
      return jsonResponse(rejection.status, { error: rejection.error, key })
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

/**
 * Origins a BROWSER may drive this daemon from.
 *
 * The daemon binds loopback and (by default) carries no token, so `Origin` is
 * the only thing separating the user's own frontend from a page they happen to
 * be visiting. Echoing the request's own `Origin` — the original behaviour —
 * made that separation vacuous: any site could read `/threads/<id>/events`.
 *
 * ── WHY THE PORT IS PART OF THE ALLOWLIST ─────────────────────────────────
 * The allowlist used to be LOOPBACK-on-ANY-PORT, described as "exactly the set
 * the shipped frontends are served from". That description was false, and the
 * gap it hid is not academic: because the daemon is TOKENLESS by default, every
 * other web server on the machine was an allowed origin. A project's own
 * `localhost:3000` dev server — carrying one compromised npm dependency in its
 * browser bundle — or any locally-installed app's web UI could
 * `fetch("http://127.0.0.1:4096/threads/<id>/events")` for the whole transcript
 * and `POST /config`. That is squarely "a page in the user's browser", which is
 * the threat this fence exists for.
 *
 * So the allowlist is now the CLOSED set of origins the shipped frontends are
 * actually served from:
 *   - the daemon's OWN port — the SPA that `serveStaticSpa` hands out in
 *     production;
 *   - {@link DEV_SERVER_PORT} (5173) — pinned in BOTH
 *     `apps/web-frontend/vite.config.ts` (`server.port`) and
 *     `apps/tauri-shell/tauri.conf.json` (`build.devUrl`);
 *   - the two Tauri shell origins.
 * ...crossed with the three loopback spellings a browser emits (`localhost`,
 * `127.0.0.1`, `[::1]`) and both schemes.
 *
 * ── WHERE THE DAEMON PORT COMES FROM ──────────────────────────────────────
 * NOT from `process.env` — no code below this comment reads the environment
 * (`QUANTA_WEB_DIST`, further down in the static-SPA resolver, is the module's
 * only env read and is unrelated to the fence). The port is THREADED
 * in by the caller, which is what makes the fence track the port the SPA is
 * really served from rather than a second, independently-resolved guess:
 *   - `apps/web-daemon/index.ts` resolves the port ONCE
 *     (`overrides.port ?? QUANTA_WEB_PORT ?? 4096`) into `config.port`;
 *   - `server/fetch-handler.ts` prefers the LIVE `Bun.serve` handle's `.port`
 *     (the actually-bound port) and falls back to `config.port`.
 * That covers all four launch shapes: the default port, the Tauri shell's
 * random `QUANTA_WEB_PORT` sidecar (`apps/tauri-shell/src/daemon.rs`), a
 * PROGRAMMATIC `main({ port })` override (which never touches the env), and an
 * OS-chosen port (`port: 0`, or `index.ts`'s EADDRINUSE fallback) — in the last
 * case the bound port is known to the handle even though it was never in the
 * config. An earlier version of this fence read `QUANTA_WEB_PORT` directly and
 * therefore 403'd its OWN SPA in the last two shapes; the arms in
 * `cross-origin-fence-hellgate.test.ts` pin each shape.
 *
 * ── WHAT THIS DOES *NOT* DO (measured, not aspirational) ──────────────────
 *   - It does not isolate the daemon from a page served on port 5173 itself.
 *     Whatever runs on the Vite dev port is trusted by construction.
 *   - It is not a substitute for `QUANTA_WEB_AUTH_TOKEN`. `Origin` is set by
 *     the browser, so this stops BROWSER-driven cross-origin access only; any
 *     local process can still speak to the daemon directly with no `Origin` at
 *     all (see below).
 *   - A port that is not a usable TCP port (`0`, negative, non-integer, > 65535
 *     — i.e. anything `resolveFencePort` refuses) contributes NO daemon-port
 *     origins at all. `http://localhost:0` is not minted as an allowed origin;
 *     the fence degrades to Vite + Tauri only rather than opening up. A daemon
 *     that BINDS `port: 0` is unaffected: by request time the handle carries the
 *     real OS-chosen port, and that is what the fence trusts.
 *   - A LAN-bound daemon (`QUANTA_WEB_BIND=0.0.0.0`, which the Tauri shell sets
 *     so phones can reach it) serves its SPA on a LAN origin like
 *     `http://192.168.1.5:<port>`. That origin is NOT loopback and is refused —
 *     as it already was before this change. Unchanged here, flagged as a known
 *     gap in the LAN-phone path rather than silently widened.
 *
 * A hostile page cannot forge `Origin` — the browser sets it — and a non-browser
 * caller sends none at all, which is why absence is allowed rather than refused.
 */
/** Vite dev-server port. Pinned in `apps/web-frontend/vite.config.ts` and in
 *  `apps/tauri-shell/tauri.conf.json`'s `devUrl`. NOTE: that Vite config sets
 *  `strictPort: false`, so a dev whose 5173 is already taken gets 5174 and a
 *  403 here — the remedy is to free 5173 (or point `QUANTA_WEB_PORT` at the
 *  port in use), and the refusal is a loud 403, never a silent wrong answer. */
const DEV_SERVER_PORT = 5173
/** Loopback hosts as a BROWSER spells them in an `Origin`. Deliberately the
 *  three literal forms and nothing else: `2130706433`, `0x7f000001`,
 *  `[::ffff:127.0.0.1]` and `localhost.` are NOT emitted by browsers as origins
 *  and are refused (pinned by the X-6 spoofing arms). */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const
const TAURI_ORIGINS: ReadonlySet<string> = new Set(["tauri://localhost", "https://tauri.localhost"])

/**
 * Normalise a threaded daemon port into "a port a browser can present in an
 * Origin", or `null` when there is no such port.
 *
 * TOTAL by design: this runs on the serving path, so a nonsense value must
 * degrade to a NARROWER allowlist (Vite + Tauri only), never to a throw (a 500
 * on every route) and never to a wider one. `0` is refused specifically — it is
 * the "let the OS choose" sentinel, not a reachable origin, and minting
 * `http://localhost:0` would put six origins in the set that nothing can ever
 * legitimately present. `index.ts`'s own startup parse is the one that rejects
 * bad operator input loudly.
 */
const resolveFencePort = (port: number | null | undefined): number | null => {
  if (port === undefined || port === null) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return port
}

/** Every origin string a shipped frontend can present, for one daemon port.
 *  Built as EXACT strings (not a regex) so the match is an equality test and
 *  cannot be widened by a future pattern edit. A `null` daemon port contributes
 *  nothing — the Vite + Tauri arms stand alone. */
const buildAllowedOrigins = (daemonPort: number | null): ReadonlySet<string> => {
  const out = new Set<string>(TAURI_ORIGINS)
  const ports = daemonPort === null ? [DEV_SERVER_PORT] : [daemonPort, DEV_SERVER_PORT]
  for (const port of ports) {
    for (const host of LOOPBACK_HOSTS) {
      out.add(`http://${host}:${port}`)
      out.add(`https://${host}:${port}`)
      // A browser OMITS the default port for the scheme, so a daemon on 80/443
      // presents a portless origin. Requires root to bind, hence rare — but the
      // omission is what the browser does, not something we get to opt out of.
      if (port === 80) out.add(`http://${host}`)
      if (port === 443) out.add(`https://${host}`)
    }
  }
  return out
}

/** Memoised on the RESOLVED port, so the set is rebuilt when (and only when)
 *  the daemon port the caller threads in actually changes, rather than on every
 *  request.
 *
 *  `resolveFencePort` is applied HERE and nowhere else. Normalising at the call
 *  sites instead would be the same two-places-must-agree shape that produced the
 *  bug this fence is being repaired for: the caller-facing predicate would mint
 *  `http://localhost:0` while the request path did not. */
let allowedOriginsCache:
  | { readonly port: number | null; readonly set: ReadonlySet<string> }
  | undefined

const allowedOrigins = (daemonPort: number | null | undefined): ReadonlySet<string> => {
  const port = resolveFencePort(daemonPort)
  if (allowedOriginsCache === undefined || allowedOriginsCache.port !== port) {
    allowedOriginsCache = { port, set: buildAllowedOrigins(port) }
  }
  return allowedOriginsCache.set
}

/** Test-only view of the resolved allowlist, so the fence's SET (not just its
 *  yes/no answers) can be asserted directly. */
export const _allowedOriginsForTest = (
  daemonPort: number | null | undefined,
): ReadonlySet<string> => allowedOrigins(daemonPort)

/** `true` when this request may be served to a browser. An ABSENT `Origin`
 *  (curl, the CLI's own client, a same-origin fetch) is allowed — adding a
 *  header requirement there would be a breaking change for every non-browser
 *  caller and buys nothing, since the attack shape is a page in the user's
 *  browser. `daemonPort` is the caller-threaded port the daemon serves its own
 *  SPA on (see the header comment); `null` ⇒ no daemon-port origin is allowed. */
export const isAllowedOrigin = (
  origin: string | null,
  daemonPort: number | null | undefined,
): boolean => {
  if (origin === null || origin === "") return true
  return allowedOrigins(daemonPort).has(origin)
}

/** CORS headers — the frontend dev server (`localhost:5173`) is a
 *  different origin from the daemon (`localhost:4096`), so browser
 *  fetches need preflight + ACAO. A DISALLOWED origin gets no ACAO at all;
 *  an allowed named origin is ECHOED rather than collapsed to `*`, and an
 *  absent origin (curl, the CLI's own client) keeps the historical `*`, where
 *  CORS does not apply and the value is inert.
 *
 *  Echoing is what a NAMED origin requires — `*` and a specific origin are not
 *  interchangeable to a browser — and nothing more. It does NOT enable
 *  `credentials: "include"`: that additionally needs
 *  `access-control-allow-credentials`, which is deliberately absent. Granting
 *  it is not a one-line header. This allowlist admits `tauri://localhost` and
 *  every LAN interface the daemon binds, so credentialed access would hand a
 *  page on any of them the user's authenticated session, and the absent-origin
 *  `*` above is illegal alongside credentials at all. Pinned in both directions
 *  by X-10 in `cross-origin-fence-hellgate.test.ts`. */
export const corsHeaders = (
  req: Request | null,
  daemonPort: number | null | undefined,
): Record<string, string> => {
  const origin = req?.headers.get("origin") ?? null
  const base = {
    "access-control-allow-methods": "GET, POST, OPTIONS, DELETE",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  }
  if (!isAllowedOrigin(origin, daemonPort)) return base
  return { ...base, "access-control-allow-origin": origin ?? "*" }
}

/** Refusal for a browser origin outside the allowlist. Deliberately a REFUSAL
 *  and not merely a withheld ACAO: a `POST` with a simple content-type is sent
 *  without a preflight, so the side effect (`/auth/logout`, `/config`) lands
 *  even when the page cannot read the reply. */
export const crossOriginReject = (): Response =>
  new Response(JSON.stringify({ error: "cross_origin_forbidden" }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8", vary: "Origin" },
  })

export const handlePreflight = (req: Request, daemonPort: number | null | undefined): Response =>
  new Response(null, { status: 204, headers: corsHeaders(req, daemonPort) })

/** JSON reply for a request that has ALREADY cleared the cross-origin fence
 *  (the fence runs above every route in `buildFetchHandler`), so the ACAO here
 *  is the historical `*` and carries no origin decision of its own — the one
 *  place a decision is still needed pre-fence is `handlePreflight`, which takes
 *  the port explicitly. */
export const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(null, null),
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

export const serveStaticSpa = (
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
