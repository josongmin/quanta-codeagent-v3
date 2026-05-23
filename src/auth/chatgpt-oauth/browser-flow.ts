import { spawn } from "node:child_process"
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { URL, URLSearchParams } from "node:url"
import {
  CALLBACK_PATH,
  CALLBACK_PORTS,
  LOGIN_TIMEOUT_MS,
  type OAuthConfig,
  SCOPE_STRING,
} from "./config"
import { deriveChallengeS256, generateCodeVerifier, generateState } from "./pkce"

export class BrowserFlowError extends Error {
  readonly reason: "ports_in_use" | "timeout" | "state_mismatch" | "user_cancel" | "open_failed"
  constructor(reason: BrowserFlowError["reason"], message: string) {
    super(message)
    this.name = "BrowserFlowError"
    this.reason = reason
  }
}

/** Successful browser flow output — the caller now has the authorization
 *  code plus the verifier/redirect needed to redeem it for tokens. */
export interface BrowserFlowResult {
  readonly code: string
  readonly verifier: string
  readonly redirectUri: string
}

const SUCCESS_HTML = `<!DOCTYPE html><html><head><title>quanta — signed in</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0d10;color:#e6edf3;margin:0;display:flex;align-items:center;justify-content:center;height:100vh}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px 40px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.4)}
h1{margin:0 0 8px;font-size:22px;color:#3fb950}
p{margin:0;color:#8b949e;font-size:13px}</style></head>
<body><div class="card"><h1>✓ Signed in to ChatGPT</h1><p>You can close this tab and return to your terminal.</p></div></body></html>`

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const errorHtml = (msg: string): string => `<!DOCTYPE html><html><head><title>quanta — login failed</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0d10;color:#e6edf3;margin:0;display:flex;align-items:center;justify-content:center;height:100vh}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px 40px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.4);max-width:480px}
h1{margin:0 0 8px;font-size:22px;color:#f85149}
p{margin:0;color:#8b949e;font-size:13px;word-break:break-word}</style></head>
<body><div class="card"><h1>✗ Login failed</h1><p>${escapeHtml(msg)}</p></div></body></html>`

const tryListen = (port: number): Promise<{ server: Server; port: number } | null> =>
  new Promise((resolve) => {
    const server = createServer()
    const onError = (): void => {
      server.close()
      resolve(null)
    }
    server.once("error", onError)
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError)
      const addr = server.address() as AddressInfo
      resolve({ server, port: addr.port })
    })
  })

const openBrowserDefault = (url: string): void => {
  const platform = process.platform
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open"
  const args = platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" })
    child.unref()
  } catch (e) {
    throw new BrowserFlowError("open_failed", `failed to launch browser: ${(e as Error).message}`)
  }
}

export interface AuthorizeUrlInput {
  readonly cfg: OAuthConfig
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly state: string
}

/** Compose the `/oauth/authorize` URL with all of Codex's query params (so
 *  the OpenAI auth UI takes the simplified-flow path). */
export const buildAuthorizeUrl = (input: AuthorizeUrlInput): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.cfg.clientId,
    redirect_uri: input.redirectUri,
    scope: SCOPE_STRING,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    state: input.state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: input.cfg.originator,
  })
  return `${input.cfg.issuer}/oauth/authorize?${params.toString()}`
}

export interface RunBrowserFlowOptions {
  readonly cfg: OAuthConfig
  /** Override the browser opener (test seam — capture the URL instead of
   *  spawning `open`/`xdg-open`). */
  readonly opener?: (url: string) => void
  /** Override the timeout (default 10 min). */
  readonly timeoutMs?: number
  /** Abort signal — when aborted, rejects the in-flight wait with a
   *  `user_cancel` BrowserFlowError so callers can unstick a hung login. */
  readonly signal?: AbortSignal
}

interface PendingState {
  readonly state: string
  resolve(code: string): void
  reject(err: Error): void
}

const respond = (res: ServerResponse, status: number, body: string): void => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" })
  res.end(body)
}

const handleCallback = (
  req: IncomingMessage,
  res: ServerResponse,
  pending: PendingState,
  redirectUri: string,
): void => {
  const url = new URL(req.url ?? "/", redirectUri)
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404, { "content-type": "text/plain" })
    res.end("not found")
    return
  }
  const err = url.searchParams.get("error")
  if (err) {
    const desc = url.searchParams.get("error_description") ?? err
    respond(res, 400, errorHtml(desc))
    pending.reject(new BrowserFlowError("user_cancel", `oauth error: ${desc}`))
    return
  }
  const code = url.searchParams.get("code")
  const state = url.searchParams.get("state")
  if (!code || !state) {
    respond(res, 400, errorHtml("callback missing code or state"))
    pending.reject(new BrowserFlowError("user_cancel", "callback missing code or state"))
    return
  }
  if (state !== pending.state) {
    respond(res, 400, errorHtml("state mismatch — possible CSRF"))
    pending.reject(new BrowserFlowError("state_mismatch", "state mismatch on callback"))
    return
  }
  respond(res, 200, SUCCESS_HTML)
  pending.resolve(code)
}

/** Run the full browser-side OAuth flow: bind a local callback port, open
 *  the browser to the OpenAI authorize URL, await the redirect with the
 *  authorization code, and return `{ code, verifier, redirectUri }` for the
 *  caller to exchange for tokens. Throws BrowserFlowError on any failure. */
export const runBrowserFlow = async (
  opts: RunBrowserFlowOptions,
): Promise<BrowserFlowResult> => {
  let bound: { server: Server; port: number } | null = null
  for (const port of CALLBACK_PORTS) {
    bound = await tryListen(port)
    if (bound) break
  }
  if (!bound) {
    throw new BrowserFlowError(
      "ports_in_use",
      `Local callback ports [${CALLBACK_PORTS.join(", ")}] are already in use. ` +
        "Close the process holding them or wait a few seconds and retry.",
    )
  }
  const { server, port } = bound
  // CRITICAL: `localhost` (not `127.0.0.1`) so the redirect_uri matches the
  // one registered on the OpenAI OAuth app — Codex CLI uses this exact
  // literal. OAuth redirect-URI checks are byte-exact; a `127.0.0.1` URI
  // makes the authorize page return "Authentication Error /
  // error_code: unknown_error" even though everything else is correct.
  // The server still binds to `127.0.0.1` for security; Node resolves
  // localhost → 127.0.0.1 on the browser side via the system resolver.
  const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`

  const verifier = generateCodeVerifier()
  const challenge = deriveChallengeS256(verifier)
  const state = generateState()
  const url = buildAuthorizeUrl({
    cfg: opts.cfg,
    redirectUri,
    codeChallenge: challenge,
    state,
  })

  let handled = false
  const codePromise = new Promise<string>((resolve, reject) => {
    const pending: PendingState = { state, resolve, reject }
    server.on("request", (req, res) => {
      // Browsers and connection-keep-alive clients can issue a follow-up
      // request (favicon, retry) on the same listener — after the OAuth
      // code has already been handled. Ignore everything past the first
      // request so we never double-reject (which surfaces as an unhandled
      // rejection that aborts the test under bun:test).
      if (handled) {
        res.writeHead(204)
        res.end()
        return
      }
      handled = true
      try {
        handleCallback(req, res, pending, redirectUri)
      } catch (e) {
        reject(e as Error)
      }
    })
    server.on("error", (e) => {
      if (handled) return
      handled = true
      reject(e)
    })
  })
  // No-op catch attached up front so a synchronous reject (state-mismatch /
  // user-cancel paths) isn't transiently classified as an unhandled
  // rejection between `pending.reject()` and `Promise.race(...)` attaching
  // its own handler one microtask later. The real error surfaces via
  // `Promise.race(...)` below — this handler is purely an unhandled-rejection
  // suppressant, not an error sink.
  codePromise.catch((_unhandled: unknown) => {
    /* see comment above */
  })

  try {
    if (opts.opener) opts.opener(url)
    else openBrowserDefault(url)
  } catch (e) {
    server.close()
    throw e
  }

  const timeoutMs = opts.timeoutMs ?? LOGIN_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new BrowserFlowError(
            "timeout",
            `login timed out after ${Math.round(timeoutMs / 1000)}s`,
          ),
        ),
      timeoutMs,
    )
  })

  let abortListener: (() => void) | null = null
  const abortPromise = new Promise<never>((_, reject) => {
    const sig = opts.signal
    if (sig === undefined) return
    if (sig.aborted) {
      reject(new BrowserFlowError("user_cancel", "login aborted by caller"))
      return
    }
    abortListener = () =>
      reject(new BrowserFlowError("user_cancel", "login aborted by caller"))
    sig.addEventListener("abort", abortListener, { once: true })
  })
  abortPromise.catch((_unhandled: unknown) => {
    /* see codePromise comment — unhandled-rejection suppressant only. */
  })

  try {
    const code = await Promise.race([codePromise, timeoutPromise, abortPromise])
    return { code, verifier, redirectUri }
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (abortListener !== null && opts.signal !== undefined) {
      opts.signal.removeEventListener("abort", abortListener)
    }
    server.close()
  }
}
