/** OAuth browser-flow orchestrator.
 *
 *  Composes PKCE + state + authorize-URL + a surface-supplied
 *  `OAuthCallbackProvider` to return a redeemable authorization code.
 *
 *  Surface separation (Audit-W blocker #1):
 *    - The callback receiver is a **port** (`OAuthCallbackProvider`) — CLI
 *      uses loopback HTTP, Tauri uses deep-link, Web uses an origin redirect
 *      handler. Each surface plugs its own implementation in.
 *    - When no provider is supplied, the default loopback-HTTP CLI listener
 *      is used so existing terminal callers see byte-identical behavior.
 *    - Browser launching is similarly a `opener` seam — present by default
 *      (spawn `open` / `xdg-open` / Windows `start`), overridable for tests
 *      *and* for surfaces where the provider itself owns user navigation
 *      (e.g. Tauri's `WebviewWindow.eval` or Web's `window.location.href`).
 */

import { spawn } from "node:child_process"
import { URLSearchParams } from "node:url"
import { errMessage } from "@/shared"
import { BrowserFlowError } from "./browser-flow-error"
import type { OAuthCallbackProvider } from "./callback-port"
import { createCliOAuthCallback } from "./cli-callback"
import { LOGIN_TIMEOUT_MS, type OAuthConfig, SCOPE_STRING } from "./config"
import { deriveChallengeS256, generateCodeVerifier, generateState } from "./pkce"

// Re-export so existing `import { BrowserFlowError } from "./browser-flow"`
// (and `from "@/auth/chatgpt-oauth"`) callers remain byte-identical.
export { BrowserFlowError } from "./browser-flow-error"
export type {
  OAuthCallbackHandle,
  OAuthCallbackProvider,
  OAuthCallbackResult,
  OAuthCallbackStartInput,
} from "./callback-port"
export { createCliOAuthCallback } from "./cli-callback"

/** Successful browser flow output — the caller now has the authorization
 *  code plus the verifier/redirect needed to redeem it for tokens. */
export interface BrowserFlowResult {
  readonly code: string
  readonly verifier: string
  readonly redirectUri: string
}

const openBrowserDefault = (url: string): void => {
  const platform = process.platform
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open"
  const args = platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" })
    child.unref()
  } catch (e) {
    throw new BrowserFlowError("open_failed", `failed to launch browser: ${errMessage(e)}`)
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
   *  spawning `open`/`xdg-open`). Surfaces whose `callbackProvider` owns
   *  navigation themselves (e.g. Web SPA `location.href = …`) can pass a
   *  no-op opener here. */
  readonly opener?: (url: string) => void
  /** Override the timeout (default 10 min). */
  readonly timeoutMs?: number
  /** Abort signal — when aborted, rejects the in-flight wait with a
   *  `user_cancel` BrowserFlowError so callers can unstick a hung login. */
  readonly signal?: AbortSignal
  /** Surface-supplied callback receiver. Defaults to the loopback-HTTP CLI
   *  implementation (`createCliOAuthCallback()`) — preserves byte-identical
   *  behavior for the terminal flow. Web/Tauri surfaces inject their own. */
  readonly callbackProvider?: OAuthCallbackProvider
}

/** Run the full browser-side OAuth flow: ask the callback provider for a
 *  redirect_uri, open the browser to the OpenAI authorize URL, await the
 *  provider's resolution with the authorization code, and return
 *  `{ code, verifier, redirectUri }` for the caller to exchange for tokens.
 *  Throws BrowserFlowError on any failure. */
export const runBrowserFlow = async (opts: RunBrowserFlowOptions): Promise<BrowserFlowResult> => {
  const verifier = generateCodeVerifier()
  const challenge = deriveChallengeS256(verifier)
  const state = generateState()

  const provider = opts.callbackProvider ?? createCliOAuthCallback()
  const startInput: Parameters<OAuthCallbackProvider["start"]>[0] = {
    expectedState: state,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  }
  const handle = await provider.start(startInput)
  const redirectUri = handle.redirectUri

  const url = buildAuthorizeUrl({
    cfg: opts.cfg,
    redirectUri,
    codeChallenge: challenge,
    state,
  })

  // `handle.received` already self-suppresses unhandled-rejection inside
  // the provider; we still attach a local catch here to cover the window
  // before `Promise.race(...)` attaches its own handler one microtask later
  // (matches the pre-refactor codePromise comment in this file).
  handle.received.catch((_unhandled: unknown) => {
    /* unhandled-rejection suppressant only */
  })

  // Provider teardown is the provider's responsibility once `received`
  // settles. If `openBrowserDefault` throws, the BrowserFlowError propagates
  // out — provider's pending `received` promise stays open and will be torn
  // down via the abort signal / timeout / next caller. In practice tests
  // pass `opener`, so the throw path is only hit when a real shell spawn
  // fails.
  if (opts.opener) opts.opener(url)
  else openBrowserDefault(url)

  const timeoutMs = opts.timeoutMs ?? LOGIN_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new BrowserFlowError("timeout", `login timed out after ${Math.round(timeoutMs / 1000)}s`),
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
    abortListener = () => reject(new BrowserFlowError("user_cancel", "login aborted by caller"))
    sig.addEventListener("abort", abortListener, { once: true })
  })
  abortPromise.catch((_unhandled: unknown) => {
    /* see handle.received comment — unhandled-rejection suppressant only. */
  })

  try {
    const { code } = await Promise.race([handle.received, timeoutPromise, abortPromise])
    return { code, verifier, redirectUri }
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (abortListener !== null && opts.signal !== undefined) {
      opts.signal.removeEventListener("abort", abortListener)
    }
  }
}
