/**
 * Slash commands that talk to the daemon's `POST /config` endpoint to
 * mutate LLM knobs at runtime. Pure helper — no React imports, no
 * coupling to SlashPalette's React layer beyond the `SlashCommand` shape.
 *
 * Wire: pass `httpUrl` (derived from the WS URL — same host/port, http
 * scheme) + optional bearer token. The factory returns a `SlashCommand[]`
 * suitable for splicing into `buildDefaultSlashCommands(...)`'s return.
 *
 * Side-channel by design: the slash command POSTs to the daemon, NOT
 * through the WS session protocol. Reason: the daemon's `LLMPort`
 * adapter (`src/llm/adapters/chatgpt-oauth.ts`) reads `process.env`
 * directly on each call — the POST mutates that env so the next turn
 * picks the new value up. A future iteration can move this onto a
 * proper `SessionCommand` once we add a `config.set` envelope upstream.
 */

import type { SlashCommand } from "./SlashPalette"

export interface LlmConfigEndpoint {
  /** Full HTTP base URL for the daemon, e.g. `http://127.0.0.1:4096`. */
  readonly httpUrl: string
  /** Bearer token from the WS auth handshake (same value). */
  readonly token?: string
  /** Optional toast hook so the host page can surface success / errors. */
  readonly onResult?: (msg: string, kind: "ok" | "err") => void
}

const postConfig = async (
  ep: LlmConfigEndpoint,
  body: Record<string, string | null>,
): Promise<void> => {
  try {
    const res = await fetch(`${ep.httpUrl.replace(/\/+$/, "")}/config`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(ep.token !== undefined ? { authorization: `Bearer ${ep.token}` } : {}),
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      ep.onResult?.(`config failed (${res.status}): ${text.slice(0, 120)}`, "err")
      return
    }
    const label = Object.entries(body)
      .map(([k, v]) => `${k}=${v ?? "(cleared)"}`)
      .join(" ")
    ep.onResult?.(`applied: ${label}`, "ok")
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    ep.onResult?.(`config network error: ${msg}`, "err")
  }
}

/**
 * Build the LLM-config slash command set. Splice into
 * `buildDefaultSlashCommands(...)`'s return array.
 *
 *   /fast            → service_tier = priority
 *   /standard        → service_tier cleared (backend default)
 *   /flex            → service_tier = flex (slow + cheap)
 *   /effort <level>  → reasoning_effort = low|medium|high
 *   /model <slug>    → model override
 */
export const buildLlmConfigSlashCommands = (
  ep: LlmConfigEndpoint,
): readonly SlashCommand[] => [
  {
    slug: "fast",
    aliases: ["speed", "priority"],
    description: "Fast mode — service_tier=priority (1.5× speed, more usage)",
    action: async () => {
      await postConfig(ep, { QUANTA_FAST: "1", QUANTA_SERVICE_TIER: null })
      return ""
    },
  },
  {
    slug: "standard",
    aliases: ["normal"],
    description: "Standard mode — clear fast/service_tier overrides",
    action: async () => {
      await postConfig(ep, { QUANTA_FAST: null, QUANTA_SERVICE_TIER: null })
      return ""
    },
  },
  {
    slug: "flex",
    description: "Flex tier — slower + cheaper queue",
    action: async () => {
      await postConfig(ep, { QUANTA_FAST: null, QUANTA_SERVICE_TIER: "flex" })
      return ""
    },
  },
  {
    slug: "effort",
    description: "Set reasoning effort — usage: /effort low|medium|high",
    action: async (rest) => {
      const level = rest.trim().toLowerCase()
      if (level !== "low" && level !== "medium" && level !== "high") {
        ep.onResult?.("usage: /effort low|medium|high", "err")
        return `/effort `
      }
      await postConfig(ep, { QUANTA_REASONING_EFFORT: level })
      return ""
    },
  },
  {
    slug: "model",
    description: "Override model slug — usage: /model gpt-5 | gpt-4o | o1 | ...",
    action: async (rest) => {
      const slug = rest.trim()
      if (slug.length === 0) {
        ep.onResult?.("usage: /model <slug>  (e.g. /model gpt-5)", "err")
        return `/model `
      }
      await postConfig(ep, { QUANTA_MODEL: slug })
      return ""
    },
  },
]

/** Derive an HTTP base URL from a WebSocket URL (same host + port). */
export const httpUrlFromWsUrl = (wsUrl: string): string => {
  try {
    const u = new URL(wsUrl)
    const scheme = u.protocol === "wss:" ? "https:" : "http:"
    return `${scheme}//${u.host}`
  } catch {
    return wsUrl.replace(/^wss?:/, "http:")
  }
}
