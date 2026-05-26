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
  exchangeCode,
  isClientIdConfigured,
  resolveOAuthConfig,
  resolveQuantaHome,
  runBrowserFlow,
  writeToken,
} from "@/auth/chatgpt-oauth"
import { logger } from "@/shared"

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

/**
 * Start the OAuth flow. Returns the authorize URL the caller should open
 * in a browser. The background task drives the full flow (code exchange
 * + token persistence) so the HTTP response can short-circuit at URL.
 *
 * Idempotent at the user level — multiple concurrent calls just create
 * multiple parallel CLI loopback listeners on different random ports;
 * the FIRST one to successfully exchange wins, the rest time out
 * harmlessly after `LOGIN_TIMEOUT_MS`.
 */
export const handleAuthLoginStart = async (): Promise<Response> => {
  const cfg = resolveOAuthConfig(process.env)
  if (!isClientIdConfigured(cfg)) {
    return jsonResponse(400, {
      error: "client_id_missing",
      hint: "set QUANTA_OAUTH_CLIENT_ID in the daemon environment",
    })
  }

  // Capture the URL through the `opener` seam — `runBrowserFlow` calls
  // `opener(url)` exactly once after PKCE/state/URL build. We resolve
  // `urlPromise` from inside that callback so the HTTP response can fire
  // immediately while the rest of the flow continues in the background.
  let urlResolve: (u: string) => void = () => undefined
  let urlReject: (err: unknown) => void = () => undefined
  const urlPromise = new Promise<string>((res, rej) => {
    urlResolve = res
    urlReject = rej
  })

  void (async () => {
    try {
      const flow = await runBrowserFlow({
        cfg,
        opener: (url: string) => {
          urlResolve(url)
        },
      })
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // If we never even produced a URL (e.g. callback provider failed to
      // bind a loopback port), surface it to the HTTP response.
      urlReject(new Error(message))
      logger.warn("web-daemon: /auth/login failed", { error: message })
    }
  })()

  try {
    const authorizeUrl = await urlPromise
    return jsonResponse(200, { authorizeUrl })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return jsonResponse(500, { error: "login_setup_failed", message })
  }
}

/** Delete the on-disk token so the next LLM call has to re-login.
 *  Returns 200 even if the file didn't exist (idempotent). */
export const handleAuthLogout = async (): Promise<Response> => {
  const { rm } = await import("node:fs/promises")
  try {
    await rm(chatgptTokenPath(resolveQuantaHome(process.env)), { force: true })
    logger.info("web-daemon: /auth/logout — token removed")
    return jsonResponse(200, { ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return jsonResponse(500, { error: "logout_failed", message })
  }
}

/** Lightweight `who am I` — reads the on-disk token (if any) and reports
 *  a redacted summary so the frontend can show "logged in as …". */
export const handleAuthStatus = async (): Promise<Response> => {
  const { readFile } = await import("node:fs/promises")
  const home = resolveQuantaHome(process.env)
  const path = chatgptTokenPath(home)
  try {
    const raw = await readFile(path, "utf-8")
    const json = JSON.parse(raw) as Record<string, unknown>
    return jsonResponse(200, {
      loggedIn: true,
      plan_type: json.plan_type ?? null,
      account_id: typeof json.account_id === "string" ? json.account_id : null,
      expires_at: json.expires_at ?? null,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.warn("web-daemon: /auth/status read fail", { home, path, error: msg })
    return jsonResponse(200, { loggedIn: false, home, path, error: msg })
  }
}
