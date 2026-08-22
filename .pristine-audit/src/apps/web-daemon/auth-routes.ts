/**
 * Web-daemon ChatGPT OAuth login endpoint.
 *
 * This is a thin HTTP wrapper around the SAME functions the CLI's
 * `/login` slash already uses — no new OAuth code. The compose is
 * verbatim from `src/apps/cli/login-cmd.ts`:
 *
 *   runBrowserFlow({...})
 *   exchangeCode({...})
 *   writeToken(tokenPath, record)
 *
 * Flow over HTTP:
 *   1. Frontend POSTs to `/auth/login` (bearer-auth, same WS token).
 *   2. We start `runBrowserFlow` in the background; its `opener` seam
 *      captures the authorize URL and hands it back through a promise.
 *   3. We HTTP-respond with `{ authorizeUrl }` — frontend `window.open`s
 *      it. The CLI loopback callback (default `OAuthCallbackProvider`)
 *      listens on a random localhost port and the ChatGPT redirect lands
 *      there → code → exchange → writeToken to disk.
 *   4. The next LLM call picks up the fresh token (the adapter re-reads
 *      `~/.quanta/auth/chatgpt.json` per request).
 *
 * Surface limit (v1): login only works when the user's BROWSER runs on
 * the SAME machine as the daemon (loopback redirect_uri). Phone access
 * to the LAN-exposed daemon CANNOT complete OAuth this way — the phone's
 * browser would redirect to the macbook's loopback port. That needs a
 * different callback provider (LAN-bound or webhook); deferred.
 */

import {
  chatgptTokenPath,
  deleteToken,
  exchangeCode,
  isClientIdConfigured,
  readResolvedToken,
  resolveChatgptTokenCandidates,
  resolveOAuthConfig,
  resolveQuantaHome,
  runBrowserFlow,
  writeToken,
} from "@/auth/chatgpt-oauth"
import { errMessage, logger } from "@/shared"

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Browser fetches go cross-origin (Vite dev :5173 → daemon :4096).
      // Loose `*` is fine on a loopback dev daemon; tighten later when
      // there's a real `Access-Control-Allow-Credentials: true` path.
      "access-control-allow-origin": "*",
      vary: "Origin",
    },
  })

/* ------------------------------------------------------------------ */
/* UUX-4-13 — login-attempt registry (completion is observable)        */
/* ------------------------------------------------------------------ */

/** One login attempt's observable state. `pending` while the background
 *  exchange runs; terminal `ok`/`failed` afterwards. */
export type LoginAttemptView =
  | { readonly state: "pending" }
  | { readonly state: "ok"; readonly planType: string | null }
  | { readonly state: "failed"; readonly error: string }

export interface LoginAttemptRegistry {
  /** Mint a new attempt id and record it as `pending`. */
  start(): string
  succeed(id: string, planType: string | null): void
  fail(id: string, error: string): void
  read(id: string): LoginAttemptView | undefined
}

/** Default cap on remembered attempts — logins are rare; 16 covers every
 *  realistic burst while keeping the daemon map bounded. */
const LOGIN_ATTEMPT_CAP = 16

/**
 * Bounded FIFO registry of login attempts. `cap` evicts the OLDEST attempt
 * (insertion order) so a hostile login loop cannot grow the daemon map.
 */
export const createLoginAttemptRegistry = (opts?: {
  readonly cap?: number
  readonly idFactory?: () => string
}): LoginAttemptRegistry => {
  const cap = opts?.cap ?? LOGIN_ATTEMPT_CAP
  const idFactory = opts?.idFactory ?? ((): string => crypto.randomUUID())
  // Map preserves insertion order ⇒ first key is the oldest attempt.
  const attempts = new Map<string, LoginAttemptView>()
  // Terminal updates guard on `has` so a late result for an EVICTED attempt
  // cannot resurrect it past the cap semantics.
  return {
    start: () => {
      const id = idFactory()
      attempts.set(id, { state: "pending" })
      while (attempts.size > cap) {
        const oldest = attempts.keys().next().value
        if (oldest === undefined) break
        attempts.delete(oldest)
      }
      return id
    },
    succeed: (id, planType) => {
      if (attempts.has(id)) attempts.set(id, { state: "ok", planType })
    },
    fail: (id, error) => {
      if (attempts.has(id)) attempts.set(id, { state: "failed", error })
    },
    read: (id) => attempts.get(id),
  }
}

/** The daemon-wide registry the HTTP handlers share by default. */
const defaultLoginAttempts = createLoginAttemptRegistry()

/**
 * Injectable seams for `handleAuthLoginStart` (UUX-4-13). `beginFlow` runs
 * the FULL OAuth compose (browser-flow → exchange → persist), calling
 * `opener(url)` exactly once when the authorize URL is ready, and resolves
 * with the landed plan. The default wraps the same CLI functions as before —
 * behaviour-identical, now observable through the registry.
 */
export interface LoginStartDeps {
  readonly isConfigured: () => boolean
  readonly beginFlow: (
    opener: (url: string) => void,
  ) => Promise<{ readonly planType: string | null }>
  readonly registry: LoginAttemptRegistry
}

const defaultBeginFlow = async (
  opener: (url: string) => void,
): Promise<{ planType: string | null }> => {
  const cfg = resolveOAuthConfig(process.env)
  const flow = await runBrowserFlow({ cfg, opener })
  const record = await exchangeCode({
    cfg,
    code: flow.code,
    verifier: flow.verifier,
    redirectUri: flow.redirectUri,
  })
  await writeToken(chatgptTokenPath(resolveQuantaHome(process.env)), record)
  logger.info("web-daemon: /auth/login completed", {
    plan: record.plan_type ?? "unknown",
  })
  return { planType: record.plan_type ?? null }
}

const defaultLoginStartDeps = (): LoginStartDeps => ({
  isConfigured: () => isClientIdConfigured(resolveOAuthConfig(process.env)),
  beginFlow: defaultBeginFlow,
  registry: defaultLoginAttempts,
})

/**
 * Start the OAuth flow. Returns the authorize URL the caller should open
 * in a browser plus an `attemptId` (UUX-4-13) the caller can poll via
 * `GET /auth/login/status?attempt=<id>` — the background exchange's outcome
 * used to die in `logger.*`, invisible to the web surface.
 *
 * Idempotent at the user level — multiple concurrent calls just create
 * multiple parallel CLI loopback listeners on different random ports;
 * the FIRST one to successfully exchange wins, the rest time out
 * harmlessly after `LOGIN_TIMEOUT_MS`.
 */
export const handleAuthLoginStart = async (
  deps: LoginStartDeps = defaultLoginStartDeps(),
): Promise<Response> => {
  if (!deps.isConfigured()) {
    return jsonResponse(400, {
      error: "client_id_missing",
      hint: "set QUANTA_OAUTH_CLIENT_ID in the daemon environment",
    })
  }

  const attemptId = deps.registry.start()

  // Capture the URL through the `opener` seam — the flow calls `opener(url)`
  // exactly once after PKCE/state/URL build. We resolve `urlPromise` from
  // inside that callback so the HTTP response can fire immediately while the
  // rest of the flow continues in the background.
  let urlResolve: (u: string) => void = () => undefined
  let urlReject: (err: unknown) => void = () => undefined
  const urlPromise = new Promise<string>((res, rej) => {
    urlResolve = res
    urlReject = rej
  })

  void (async () => {
    try {
      const { planType } = await deps.beginFlow((url: string) => {
        urlResolve(url)
      })
      deps.registry.succeed(attemptId, planType)
    } catch (error) {
      const message = errMessage(error)
      // UUX-4-13: the outcome is now readable by the frontend's poll instead
      // of being console-only.
      deps.registry.fail(attemptId, message)
      // If we never even produced a URL (e.g. callback provider failed to
      // bind a loopback port), surface it to the HTTP response. (No-op when
      // the URL already resolved.)
      urlReject(new Error(message))
      logger.warn("web-daemon: /auth/login failed", { error: message })
    }
  })()

  try {
    const authorizeUrl = await urlPromise
    return jsonResponse(200, { authorizeUrl, attemptId })
  } catch (error) {
    const message = errMessage(error)
    return jsonResponse(500, { error: "login_setup_failed", message })
  }
}

/**
 * UUX-4-13 — `GET /auth/login/status?attempt=<id>`. Reads one attempt's
 * state back so the frontend's bounded poll can report login completion
 * (success OR the previously console-only failure) into the transcript.
 */
export const handleAuthLoginAttemptStatus = async (
  url: URL,
  registry: LoginAttemptRegistry = defaultLoginAttempts,
): Promise<Response> => {
  const id = url.searchParams.get("attempt")
  if (id === null || id.length === 0) {
    return jsonResponse(400, { error: "missing_attempt" })
  }
  const view = registry.read(id)
  if (view === undefined) return jsonResponse(404, { error: "unknown_attempt" })
  return jsonResponse(200, view)
}

/** Delete the on-disk token so the next LLM call has to re-login.
 *  Returns 200 even if the file didn't exist (idempotent). */
export const handleAuthLogout = async (): Promise<Response> => {
  const fallbackPath = resolveChatgptTokenCandidates(process.env)[0]?.path ?? ""
  try {
    const resolved = await readResolvedToken(process.env)
    if (resolved?.source === "codex") {
      return jsonResponse(409, {
        ok: false,
        error: "externally_managed_token",
        source: "codex",
        path: resolved.path,
        hint: "sign out from Codex to remove this token",
      })
    }
    const path = resolved?.path ?? fallbackPath
    await deleteToken(path)
    logger.info("web-daemon: /auth/logout — token removed", {
      source: resolved?.source ?? "quanta",
    })
    return jsonResponse(200, { ok: true, source: resolved?.source ?? "quanta", path })
  } catch (error) {
    const message = errMessage(error)
    return jsonResponse(500, { error: "logout_failed", message })
  }
}

/** Lightweight `who am I` — reads the on-disk token (if any) and reports
 *  a redacted summary so the frontend can show "logged in as …". */
export const handleAuthStatus = async (): Promise<Response> => {
  const path = resolveChatgptTokenCandidates(process.env)[0]?.path ?? ""
  try {
    const resolved = await readResolvedToken(process.env)
    if (resolved === null) {
      return jsonResponse(200, { loggedIn: false, path })
    }
    return jsonResponse(200, {
      loggedIn: true,
      source: resolved.source,
      path: resolved.path,
      plan_type: resolved.record.plan_type ?? null,
      account_id: resolved.record.account_id ?? null,
      expires_at: resolved.record.expires_at,
    })
  } catch (error) {
    const msg = errMessage(error)
    logger.warn("web-daemon: /auth/status read fail", { path, error: msg })
    return jsonResponse(200, { loggedIn: false, path, error: msg })
  }
}
