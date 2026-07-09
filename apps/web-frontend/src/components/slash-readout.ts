/**
 * Slash commands that fetch the daemon's OUT-OF-BAND read-only readouts
 * (`GET /readout/:name`, jun-9-cli-web-parity ticket 05) and append the
 * rendered text to the transcript as a system message.
 *
 * Why HTTP (not a WS slash verb): the session single-writer lease throws if a
 * readout is fired mid-turn on the WS channel — exactly when you want to look.
 * The daemon serves these like knobs: lease-free, works idle AND mid-turn.
 *
 * Pure helper (mirrors `slash-llm-config.ts`): no React import beyond the
 * `SlashCommand` shape. Pass `httpUrl` + token + an `appendSystem` sink (the
 * SlashPalette's `appendClientMessage("system", …)`). Splice the result into
 * `buildDefaultSlashCommands(...)`'s return so these REPLACE the old prefill
 * stubs for the read-only commands.
 */

import type { SlashCommand } from "./SlashPalette"

export interface ReadoutEndpoint {
  /** Full HTTP base URL for the daemon, e.g. `http://127.0.0.1:4096`. */
  readonly httpUrl: string
  /** Bearer token from the WS auth handshake (same value). */
  readonly token?: string
  /** Append the readout body to the transcript (the system-message sink). */
  readonly appendSystem: (text: string) => void
  /** Optional error toast (network / non-2xx). */
  readonly onError?: (msg: string) => void
}

/** The read-only readouts exposed in the web palette. `state` + `capabilities`
 *  serve live data today; the rest hit the same route and currently return the
 *  daemon's graceful "not wired in this surface yet" line (honest — and turns
 *  into live data the moment the host accessor lands, no frontend change). */
const READOUT_COMMANDS: readonly {
  slug: string
  aliases?: readonly string[]
  description: string
}[] = [
  { slug: "state", description: "Session state — status / mode / model / why-stopped (live)" },
  {
    slug: "capabilities",
    aliases: ["caps"],
    description: "Capability grid for this surface (live)",
  },
  { slug: "agents", description: "Subagent fleet roster" },
  { slug: "plan", description: "Current plan body" },
  { slug: "branches", description: "Speculative branch-search results" },
  { slug: "skills", description: "Available skills" },
  { slug: "mcp", description: "MCP server status" },
  { slug: "memory", description: "Memory inspector" },
  { slug: "why", description: "Why the last tool ran" },
  { slug: "cost", description: "Cost / token breakdown" },
]

const fetchReadout = async (ep: ReadoutEndpoint, name: string): Promise<void> => {
  try {
    const res = await fetch(`${ep.httpUrl.replace(/\/+$/, "")}/readout/${name}`, {
      headers: ep.token !== undefined ? { authorization: `Bearer ${ep.token}` } : {},
    })
    const body = (await res.json().catch(() => null)) as { output?: unknown } | null
    if (body !== null && typeof body.output === "string" && body.output.length > 0) {
      ep.appendSystem(body.output)
      return
    }
    ep.onError?.(`/${name} failed (${res.status})`)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    ep.onError?.(`/${name} network error: ${msg}`)
  }
}

/** Build the read-only readout slash command set. */
export const buildReadoutSlashCommands = (ep: ReadoutEndpoint): readonly SlashCommand[] =>
  READOUT_COMMANDS.map((c) => ({
    slug: c.slug,
    ...(c.aliases !== undefined ? { aliases: c.aliases } : {}),
    description: c.description,
    kind: "readout",
    action: async () => {
      await fetchReadout(ep, c.slug)
      return ""
    },
  }))

/** Slugs this builder owns — so the caller can drop the old prefill stubs for
 *  exactly these (no duplicate palette rows). */
export const READOUT_SLUGS: readonly string[] = READOUT_COMMANDS.map((c) => c.slug)
