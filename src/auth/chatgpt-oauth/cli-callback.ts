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

// Shared "graph-paper" stylesheet — light theme, dot grid, brutalist card,
// monospace prompt. Inlined so the loopback server is fully self-contained
// (no static-asset serving, no CDN).
const SHARED_CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{
  font-family:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;
  background-color:#f4f1ea;
  background-image:
    radial-gradient(#cfc9bb 1px,transparent 1.4px),
    radial-gradient(#e3decf 1px,transparent 1.4px);
  background-size:18px 18px,18px 18px;
  background-position:0 0,9px 9px;
  color:#1a1a1a;
  display:flex;align-items:center;justify-content:center;
  min-height:100vh;padding:24px;
}
.frame{
  background:#fffdf7;
  border:2px solid #1a1a1a;
  box-shadow:6px 6px 0 #1a1a1a;
  max-width:560px;width:100%;
}
.titlebar{
  background:#1a1a1a;color:#f4f1ea;
  border-bottom:2px solid #1a1a1a;
  padding:7px 12px;display:flex;align-items:center;gap:6px;
  font-size:11px;letter-spacing:.06em;text-transform:uppercase;
}
.tdot{width:10px;height:10px;display:inline-block}
.tdot.r{background:#e0533c}.tdot.y{background:#e3a72b}.tdot.g{background:#3fa45a}
.titlebar .label{margin-left:10px;opacity:.85}
.body{padding:24px 24px 20px}
pre.glyph{
  margin:0 0 14px;color:#1f7a3a;font-size:11px;line-height:1;
  white-space:pre;letter-spacing:0;
}
pre.glyph.err{color:#b8302a}
h1{
  margin:0 0 6px;font-size:17px;font-weight:700;letter-spacing:.01em;
  display:flex;align-items:baseline;gap:8px;
}
h1 .lead{color:#1f7a3a}
h1.err .lead{color:#b8302a}
p.msg{margin:0;color:#5a544a;font-size:13px;line-height:1.5;word-break:break-word}
.prompt{
  margin-top:18px;padding:10px 12px;
  background:#1a1a1a;color:#f4f1ea;
  font-size:12px;letter-spacing:.02em;
  border:2px solid #1a1a1a;
}
.prompt .sigil{color:#e3a72b;margin-right:8px}
.prompt .dim{opacity:.55}
.cursor{
  display:inline-block;width:7px;height:13px;background:#f4f1ea;
  vertical-align:-2px;margin-left:4px;animation:blink 1s steps(2) infinite;
}
@keyframes blink{50%{background:transparent}}
.meta{
  margin-top:14px;padding-top:12px;
  border-top:1px dashed #c8c2b3;
  display:flex;gap:14px;flex-wrap:wrap;
  color:#7a7468;font-size:11px;letter-spacing:.02em;
}
.meta b{color:#1a1a1a;font-weight:600;margin-right:4px}
`

// 13-row pixel checkmark — full-blocks on dotted underlay. Hand-pixeled to
// stay readable at 11px without needing an SVG.
const PIXEL_CHECK = `
░░░░░░░░░░░░░░░░░░░░░░░██
░░░░░░░░░░░░░░░░░░░░░░██░
░░░░░░░░░░░░░░░░░░░░░██░░
░░░░░░░░░░░░░░░░░░░░██░░░
██░░░░░░░░░░░░░░░░░██░░░░
░██░░░░░░░░░░░░░░░██░░░░░
░░██░░░░░░░░░░░░░██░░░░░░
░░░██░░░░░░░░░░░██░░░░░░░
░░░░██░░░░░░░░░██░░░░░░░░
░░░░░██░░░░░░░██░░░░░░░░░
░░░░░░██░░░░░██░░░░░░░░░░
░░░░░░░██░░░██░░░░░░░░░░░
░░░░░░░░█████░░░░░░░░░░░░`

const PIXEL_CROSS = `
██░░░░░░░░░░░░░░░░░░░░░██
░██░░░░░░░░░░░░░░░░░░░██░
░░██░░░░░░░░░░░░░░░░░██░░
░░░██░░░░░░░░░░░░░░░██░░░
░░░░██░░░░░░░░░░░░░██░░░░
░░░░░██░░░░░░░░░░░██░░░░░
░░░░░░██░░░░░░░░░██░░░░░░
░░░░░░░██░░░░░░░██░░░░░░░
░░░░░░░░█████████░░░░░░░░
░░░░░░░██░░░░░░░██░░░░░░░
░░░░░░██░░░░░░░░░██░░░░░░
░░░░░██░░░░░░░░░░░██░░░░░
░░░░██░░░░░░░░░░░░░██░░░░`

const SUCCESS_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>quanta — signed in</title>
<style>${SHARED_CSS}</style></head>
<body><main class="frame">
<div class="titlebar"><span class="tdot r"></span><span class="tdot y"></span><span class="tdot g"></span><span class="label">quanta:auth — chatgpt-oauth</span></div>
<div class="body">
<pre class="glyph" aria-hidden="true">${PIXEL_CHECK}</pre>
<h1><span class="lead">[ok]</span><span>Signed in to ChatGPT</span></h1>
<p class="msg">You can close this tab and return to your terminal.</p>
<div class="prompt"><span class="sigil">$</span>quanta status<span class="dim"> # token persisted</span><span class="cursor"></span></div>
<div class="meta"><span><b>provider</b>chatgpt-oauth</span><span><b>scope</b>openid · profile · email</span><span><b>via</b>loopback</span></div>
</div></main></body></html>`

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const errorHtml = (
  msg: string,
): string => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>quanta — login failed</title>
<style>${SHARED_CSS}</style></head>
<body><main class="frame">
<div class="titlebar"><span class="tdot r"></span><span class="tdot y"></span><span class="tdot g"></span><span class="label">quanta:auth — chatgpt-oauth</span></div>
<div class="body">
<pre class="glyph err" aria-hidden="true">${PIXEL_CROSS}</pre>
<h1 class="err"><span class="lead">[err]</span><span>Login failed</span></h1>
<p class="msg">${escapeHtml(msg)}</p>
<div class="prompt"><span class="sigil">$</span>quanta /login --chatgpt<span class="dim"> # retry</span><span class="cursor"></span></div>
<div class="meta"><span><b>provider</b>chatgpt-oauth</span><span><b>stage</b>callback</span><span><b>action</b>retry</span></div>
</div></main></body></html>`

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
      let closed = false
      let abortListener: (() => void) | null = null
      let settleReject: ((err: Error) => void) | undefined
      const sig = input.signal

      const releaseSignal = (): void => {
        if (abortListener !== null && sig !== undefined) {
          sig.removeEventListener("abort", abortListener)
          abortListener = null
        }
      }

      const dropServer = (): void => {
        if (typeof server.closeAllConnections === "function") {
          server.closeAllConnections()
        }
        server.close()
      }

      const close = (): void => {
        if (closed) return
        closed = true
        releaseSignal()
        if (!handled) {
          handled = true
          settleReject?.(new BrowserFlowError("user_cancel", "callback listener closed"))
        }
        dropServer()
      }

      const received = new Promise<OAuthCallbackResult>((resolve, reject) => {
        settleReject = reject
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

      received.then(close, close)

      return { redirectUri, received, close }
    },
  }
}
