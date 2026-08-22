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

/** CORS headers — the frontend dev server (`localhost:5173`) is a
 *  different origin from the daemon (`localhost:4096`), so browser
 *  fetches need preflight + ACAO. Loopback-only dev; loose `*` is fine.
 *  When `Origin` is set we echo it (so credentialed requests would work
 *  if the frontend ever adds `credentials: "include"`). */
export const corsHeaders = (req: Request | null): Record<string, string> => ({
  "access-control-allow-origin": req?.headers.get("origin") ?? "*",
  "access-control-allow-methods": "GET, POST, OPTIONS, DELETE",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "600",
  vary: "Origin",
})

export const handlePreflight = (req: Request): Response =>
  new Response(null, { status: 204, headers: corsHeaders(req) })

export const jsonResponse = (status: number, body: unknown, req?: Request): Response =>
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
