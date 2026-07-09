/**
 * ChatGPT OAuth slash commands — thin HTTP shim to the daemon's
 * `/auth/login`, `/auth/logout`, `/auth/status` endpoints (which are
 * themselves wrappers around the CLI's existing `runBrowserFlow` +
 * `exchangeCode` + `writeToken` compose).
 *
 * Splice into `buildDefaultSlashCommands(...)`'s return alongside
 * `buildLlmConfigSlashCommands(...)`.
 *
 * Surface limit (v1): login only completes when the user's BROWSER runs
 * on the SAME machine as the daemon. Phone users on the LAN-exposed
 * daemon cannot complete OAuth this way — the redirect_uri is a
 * loopback port on the daemon machine.
 */

import type { SlashCommand } from "./SlashPalette"

export interface AuthEndpoint {
  /** Full HTTP base URL for the daemon, e.g. `http://127.0.0.1:4096`. */
  readonly httpUrl: string
  /** Bearer token from the WS auth handshake (same value). */
  readonly token?: string
  /** Optional toast hook so the host page can surface success / errors. */
  readonly onResult?: (msg: string, kind: "ok" | "err") => void
}

const authHeaders = (ep: AuthEndpoint): Record<string, string> => ({
  "content-type": "application/json",
  ...(ep.token !== undefined ? { authorization: `Bearer ${ep.token}` } : {}),
})

const baseUrl = (ep: AuthEndpoint): string => ep.httpUrl.replace(/\/+$/, "")

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

const readTauriInvoke = (): TauriInvoke | undefined => {
  if (typeof window === "undefined") return undefined
  const candidate = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: TauriInvoke } })
    .__TAURI_INTERNALS__?.invoke
  return typeof candidate === "function" ? candidate : undefined
}

/**
 * Open `url` in the user's default OS browser. Two paths:
 *
 *   1. Tauri webview — call the `open_external_url` Rust command which
 *      shells out to `/usr/bin/open` (host-allowlisted in Rust). The
 *      webview's `window.open(_, "_blank")` is silently dropped by
 *      WKWebView so this is the only path that actually works there.
 *
 *   2. Plain browser — use the pre-opened blank tab passed in. Opening
 *      a tab AFTER an `await` loses the user-gesture context and gets
 *      popup-blocked, so the caller MUST `window.open("", "_blank")`
 *      BEFORE the fetch, then hand the returned window here to set
 *      `location.href`. Returns `true` if the navigation was issued.
 */
const openExternalAuthUrl = async (url: string, preOpened: Window | null): Promise<boolean> => {
  const invoke = readTauriInvoke()
  if (invoke !== undefined) {
    try {
      await invoke("open_external_url", { url })
      // Pre-opened tab in Tauri context is useless — close it so we don't
      // leave an empty about:blank tab around.
      preOpened?.close()
      return true
    } catch (error) {
      console.warn("open_external_url invoke failed, falling back:", error)
    }
  }
  if (preOpened !== null && !preOpened.closed) {
    preOpened.location.href = url
    return true
  }
  // Last-ditch: try a synchronous-ish window.open. In a normal browser
  // this will be popup-blocked because we're past an `await`; in Tauri
  // it's a silent no-op. Caller should surface the URL so the user can
  // copy it manually.
  const w = window.open(url, "_blank", "noopener,noreferrer")
  return w !== null
}

export const buildAuthSlashCommands = (ep: AuthEndpoint): readonly SlashCommand[] => [
  {
    slug: "login",
    aliases: ["signin"],
    description: "Open ChatGPT OAuth login (uses the daemon's loopback callback)",
    kind: "local",
    action: async () => {
      // Pre-open a blank tab WHILE we still have user-gesture context.
      // Popping it after the `await fetch` below would lose that context
      // and trip every browser's popup-blocker (the actual root cause of
      // the silent "browser opened — but nothing happened" bug). For
      // Tauri we'll just close this scratch tab and route through Rust.
      const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
      const preOpened = isTauri ? null : window.open("about:blank", "_blank", "noopener,noreferrer")
      try {
        const res = await fetch(`${baseUrl(ep)}/auth/login`, {
          method: "POST",
          headers: authHeaders(ep),
          body: "{}",
        })
        const json = (await res.json()) as {
          authorizeUrl?: string
          error?: string
          hint?: string
        }
        if (!res.ok || typeof json.authorizeUrl !== "string") {
          preOpened?.close()
          const msg = json.error ?? `HTTP ${res.status}`
          ep.onResult?.(
            `login failed: ${msg}${json.hint !== undefined ? ` (${json.hint})` : ""}`,
            "err",
          )
          return ""
        }
        const opened = await openExternalAuthUrl(json.authorizeUrl, preOpened)
        if (opened) {
          ep.onResult?.("browser opened — finish the ChatGPT login flow, then come back", "ok")
        } else {
          // Popup blocked AND no Tauri command — surface the URL so the
          // user can paste it manually instead of staring at a silent UI.
          ep.onResult?.(
            `browser open blocked — paste this URL manually: ${json.authorizeUrl}`,
            "err",
          )
        }
      } catch (error) {
        preOpened?.close()
        const msg = error instanceof Error ? error.message : String(error)
        ep.onResult?.(`login network error: ${msg}`, "err")
      }
      return ""
    },
  },
  {
    slug: "logout",
    aliases: ["signout"],
    description: "Forget the on-disk ChatGPT token (next call will need /login)",
    kind: "local",
    action: async () => {
      try {
        const res = await fetch(`${baseUrl(ep)}/auth/logout`, {
          method: "POST",
          headers: authHeaders(ep),
        })
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          ep.onResult?.(`logout failed (${res.status}): ${text.slice(0, 120)}`, "err")
          return ""
        }
        ep.onResult?.("logged out — token removed", "ok")
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ep.onResult?.(`logout network error: ${msg}`, "err")
      }
      return ""
    },
  },
  {
    slug: "whoami",
    aliases: ["status"],
    description: "Show current ChatGPT login state (plan / account / expiry)",
    kind: "local",
    action: async () => {
      try {
        const res = await fetch(`${baseUrl(ep)}/auth/status`, {
          method: "GET",
          headers: authHeaders(ep),
        })
        const json = (await res.json()) as {
          loggedIn?: boolean
          plan_type?: string | null
          account_id?: string | null
          expires_at?: number | string | null
        }
        if (json.loggedIn !== true) {
          ep.onResult?.("not logged in — run /login", "ok")
          return ""
        }
        const account =
          json.account_id !== null && json.account_id !== undefined
            ? json.account_id.slice(0, 12) + "…"
            : "?"
        ep.onResult?.(`logged in — plan=${json.plan_type ?? "?"} account=${account}`, "ok")
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ep.onResult?.(`status network error: ${msg}`, "err")
      }
      return ""
    },
  },
]
