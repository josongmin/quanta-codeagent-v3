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

export const buildAuthSlashCommands = (
  ep: AuthEndpoint,
): readonly SlashCommand[] => [
  {
    slug: "login",
    aliases: ["signin"],
    description: "Open ChatGPT OAuth login (uses the daemon's loopback callback)",
    action: async () => {
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
          const msg = json.error ?? `HTTP ${res.status}`
          ep.onResult?.(
            `login failed: ${msg}${json.hint !== undefined ? ` (${json.hint})` : ""}`,
            "err",
          )
          return ""
        }
        // Open the OAuth authorize URL in a new tab. Same-origin policy
        // does NOT bite us — ChatGPT redirects to the daemon's loopback
        // callback (different origin), and the browser just follows it.
        window.open(json.authorizeUrl, "_blank", "noopener,noreferrer")
        ep.onResult?.(
          "browser opened — finish the ChatGPT login flow, then come back",
          "ok",
        )
      } catch (error) {
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
        const account = json.account_id !== null && json.account_id !== undefined
          ? json.account_id.slice(0, 12) + "…"
          : "?"
        ep.onResult?.(
          `logged in — plan=${json.plan_type ?? "?"} account=${account}`,
          "ok",
        )
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        ep.onResult?.(`status network error: ${msg}`, "err")
      }
      return ""
    },
  },
]
