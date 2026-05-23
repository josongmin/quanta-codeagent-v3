/** Default `OAuthCallbackProvider` implementation for the CLI surface —
 *  binds a loopback HTTP listener on the Codex-compatible ports (1455 → 1457
 *  fallback) and resolves on `/auth/callback?code=…&state=…`.
 *
 *  This is the byte-identical extraction of the listener body that used to
 *  live inline in `browser-flow.ts`. Keeping it in the `@/auth/chatgpt-oauth`
 *  slice (rather than `apps/cli/`) preserves the **default** that
 *  `runBrowserFlow({...})` works out-of-the-box for terminal callers —
 *  without a slice-illegal `@/auth → apps/cli` cross-import. Web/Tauri
 *  surfaces supply their own provider from their own apps/* tree.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { URL } from "node:url"
import { BrowserFlowError } from "./browser-flow-error"
import type {
  OAuthCallbackHandle,
  OAuthCallbackProvider,
  OAuthCallbackResult,
  OAuthCallbackStartInput,
} from "./callback-port"
import { CALLBACK_PATH, CALLBACK_PORTS } from "./config"

const SUCCESS_HTML = `<!DOCTYPE html><html><head><title>quanta — signed in</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0d10;color:#e6edf3;margin:0;display:flex;align-items:center;justify-content:center;height:100vh}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px 40px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.4)}
h1{margin:0 0 8px;font-size:22px;color:#3fb950}
p{margin:0;color:#8b949e;font-size:13px}</style></head>
<body><div class="card"><h1>✓ Signed in to ChatGPT</h1><p>You can close this tab and return to your terminal.</p></div></body></html>`

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const errorHtml = (
  msg: string,
): string => `<!DOCTYPE html><html><head><title>quanta — login failed</title>
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

export interface CliCallbackOptions {
  /** Override the port-probe list (test seam). Defaults to the
   *  Codex-compatible `[1455, 1457]`. */
  readonly ports?: readonly number[]
}

/** Factory: build a CLI loopback-HTTP `OAuthCallbackProvider`. */
export const createCliOAuthCallback = (opts: CliCallbackOptions = {}): OAuthCallbackProvider => {
  const ports = opts.ports ?? CALLBACK_PORTS
  return {
    async start(input: OAuthCallbackStartInput): Promise<OAuthCallbackHandle> {
      let bound: { server: Server; port: number } | null = null
      for (const port of ports) {
        bound = await tryListen(port)
        if (bound) break
      }
      if (!bound) {
        throw new BrowserFlowError(
          "ports_in_use",
          `Local callback ports [${ports.join(", ")}] are already in use. ` +
            "Close the process holding them or wait a few seconds and retry.",
        )
      }
      const { server, port } = bound
      // CRITICAL: `localhost` (not `127.0.0.1`) so the redirect_uri matches
      // the one registered on the OpenAI OAuth app — Codex CLI uses this
      // exact literal. OAuth redirect-URI checks are byte-exact; a
      // `127.0.0.1` URI makes the authorize page return "Authentication
      // Error / error_code: unknown_error" even though everything else is
      // correct. The server still binds to `127.0.0.1` for security; Node
      // resolves localhost → 127.0.0.1 on the browser side via the system
      // resolver.
      const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`

      let handled = false
      let abortListener: (() => void) | null = null
      const sig = input.signal

      const received = new Promise<OAuthCallbackResult>((resolve, reject) => {
        const pending: PendingState = {
          state: input.expectedState,
          resolve: (code) => resolve({ code }),
          reject,
        }
        server.on("request", (req, res) => {
          // Browsers and connection-keep-alive clients can issue a follow-up
          // request (favicon, retry) on the same listener — after the OAuth
          // code has already been handled. Ignore everything past the first
          // request so we never double-reject (which surfaces as an
          // unhandled rejection that aborts the test under bun:test).
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

        if (sig !== undefined) {
          if (sig.aborted) {
            handled = true
            reject(new BrowserFlowError("user_cancel", "login aborted by caller"))
            return
          }
          abortListener = () => {
            if (handled) return
            handled = true
            reject(new BrowserFlowError("user_cancel", "login aborted by caller"))
          }
          sig.addEventListener("abort", abortListener, { once: true })
        }
      })

      // Self-suppress unhandled-rejection between provider construction and
      // the caller attaching its own awaiter (matches the existing
      // codePromise comment in browser-flow.ts — purely a suppressant, not
      // an error sink).
      received.catch((_unhandled: unknown) => {
        /* see comment above */
      })

      // Always tear the server down once the callback settles — success,
      // failure, or abort — and detach any signal listener.
      const teardown = (): void => {
        if (abortListener !== null && sig !== undefined) {
          sig.removeEventListener("abort", abortListener)
        }
        server.close()
      }
      received.then(teardown, teardown)

      return { redirectUri, received }
    },
  }
}
