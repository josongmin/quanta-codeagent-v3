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

import { planRetryWith } from "../lib/retry-with"
import type { UiMessage } from "../types/protocol"
import type { SlashCommand } from "./SlashPalette"

export interface LlmConfigEndpoint {
  /** Full HTTP base URL for the daemon, e.g. `http://127.0.0.1:4096`. */
  readonly httpUrl: string
  /** Bearer token from the WS auth handshake (same value). */
  readonly token?: string
  /** Optional toast hook so the host page can surface success / errors. */
  readonly onResult?: (msg: string, kind: "ok" | "err") => void
  /** P2 (UUX-4-18) — live transcript accessor for `/retry-with` (last user
   *  message). Threaded on by the catalogue when the App wires it; absent ⇒
   *  the entry reports "no prior turn". */
  readonly getMessages?: () => readonly UiMessage[]
  /** P2 (UUX-4-18) — resend a turn (the App's `sendTurn`), used by
   *  `/retry-with` after applying the model override. Absent ⇒ no resend. */
  readonly resend?: (text: string) => void
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
export const buildLlmConfigSlashCommands = (ep: LlmConfigEndpoint): readonly SlashCommand[] => [
  {
    slug: "fast",
    aliases: ["speed", "priority"],
    description: "Fast mode — service_tier=priority (1.5× speed, more usage)",
    kind: "local",
    action: async () => {
      await postConfig(ep, { QUANTA_FAST: "1", QUANTA_SERVICE_TIER: null })
      return ""
    },
  },
  {
    slug: "standard",
    aliases: ["normal"],
    description: "Standard mode — clear fast/service_tier overrides",
    kind: "local",
    action: async () => {
      await postConfig(ep, { QUANTA_FAST: null, QUANTA_SERVICE_TIER: null })
      return ""
    },
  },
  {
    slug: "flex",
    description: "Flex tier — slower + cheaper queue",
    kind: "local",
    action: async () => {
      await postConfig(ep, { QUANTA_FAST: null, QUANTA_SERVICE_TIER: "flex" })
      return ""
    },
  },
  {
    slug: "effort",
    description: "Set reasoning effort — usage: /effort low|medium|high",
    kind: "local",
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
    kind: "local",
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
  {
    // P2 (jul-11, UUX-4-18) — /retry-with <slug>: the CLI re-runs the last turn
    // with a different model. The web protocol carries NO per-turn model
    // (TurnRunCommand is an empty envelope), so the HONEST parity is a two-step:
    // apply the model override THEN resend the last user message. The live
    // transcript + send path arrive endpoint-carried (getMessages/resend);
    // absent ⇒ "no prior turn". ONE retry-with impl, no parallel builder.
    slug: "retry-with",
    description: "Re-run the last turn with a different model — usage: /retry-with <slug>",
    kind: "local",
    action: async (rest) => {
      const plan = planRetryWith(rest ?? "", ep.getMessages?.() ?? [])
      if (!plan.ok) {
        ep.onResult?.(
          plan.reason === "no_slug"
            ? "usage: /retry-with <slug>  (e.g. /retry-with gpt-5)"
            : "/retry-with: no prior user message to resend",
          "err",
        )
        return plan.reason === "no_slug" ? "/retry-with " : ""
      }
      await postConfig(ep, { QUANTA_MODEL: plan.slug })
      ep.resend?.(plan.resendText)
      ep.onResult?.(`retrying last message under ${plan.slug} (model override + resend)`, "ok")
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

/** P2 (jul-11, UUX-4-18) — /retry-with deps: the palette entry needs the live
 *  transcript (last user message) and the composer's send path. Thin getters
 *  so the catalogue memo does not re-assemble per message. */
/** P2 (UUX-4-18) — the App-side deps the catalogue threads onto the shared
 *  endpoint so the (endpoint-carried) `/retry-with` reads the live transcript +
 *  resends. Kept as the wiring contract; there is ONE retry-with impl (baked
 *  into {@link buildLlmConfigSlashCommands}), no parallel builder. */
export interface RetryWithDeps {
  readonly getMessages: () => readonly UiMessage[]
  readonly sendUserTurn: (text: string) => void
}
