/**
 * Shared single-shot text inbox for surface slash commands that attach
 * out-of-band content to the next user turn (ADR-0224).
 *
 * Sibling of {@link ImageQueue} — same FIFO + cap + atomic-drain shape,
 * but for plain text (e.g. `/web <url>` returns markdown, `/paste` returns
 * the clipboard contents, neither belongs in a regular `say` prompt but
 * both must reach the model as part of the very NEXT user message).
 *
 * Drain semantics: a surface (REPL / future Tauri / Web) calls
 * {@link TextInbox.drain} exactly once from its `PromptSource.next()` impl
 * and concatenates the drained chunks to the user's literal text. The
 * inbox is single-shot per turn — re-running `/web` or `/paste` enqueues
 * again for a future turn.
 *
 * Slice posture (RFC §3.1):
 *   - Lives in `apps/cli` (surface-only); the only non-`node:*` import is the
 *     PORT CONTRACT type from `@/agent/surface-ports` (a downward surface→core
 *     type dependency — the agent owns the contract, this file implements it).
 *   - exactOptionalPropertyTypes-clean (no `T | undefined` on the public
 *     surface — capacity errors are typed discriminants, not nullable).
 *   - No-throw: every add-failure mode returns a typed result.
 */

export const TEXT_INBOX_DEFAULT_MAX = 8

// The PORT CONTRACT lives in `@/agent/surface-ports` (the agent core owns it;
// this surface implements it via `createTextInbox`). Re-exported here so every
// existing `./text-inbox` importer keeps its import site unchanged.
export type { TextInbox, TextInboxAddResult, TextInboxEntry } from "@/agent/surface-ports"

import type { TextInbox, TextInboxAddResult, TextInboxEntry } from "@/agent/surface-ports"

export interface TextInboxOpts {
  /** Capacity cap. Defaults to {@link TEXT_INBOX_DEFAULT_MAX}. */
  readonly maxSize?: number
}

/** Build a fresh in-memory text inbox. Owned by the REPL surface (per-
 *  process lifetime); a multi-tab Web/Tauri surface would allocate one
 *  per session. */
export const createTextInbox = (opts: TextInboxOpts = {}): TextInbox => {
  const cap =
    Number.isFinite(opts.maxSize) && (opts.maxSize ?? 0) > 0
      ? (opts.maxSize as number)
      : TEXT_INBOX_DEFAULT_MAX
  const items: TextInboxEntry[] = []
  return {
    add(entry: TextInboxEntry): TextInboxAddResult {
      if (items.length >= cap) return { kind: "over_cap", cap }
      items.push(entry)
      return { kind: "ok" }
    },
    list(): readonly TextInboxEntry[] {
      return items.slice()
    },
    clear(): void {
      items.length = 0
    },
    size(): number {
      return items.length
    },
    drain(): readonly TextInboxEntry[] {
      if (items.length === 0) return []
      const out = items.slice()
      items.length = 0
      return out
    },
  }
}

/** Render the inbox preamble that surfaces prepend to the user's literal
 *  text on the next turn. Stable + minimal — the model sees:
 *
 *      [/web https://example.com]
 *      <markdown body>
 *
 *      [/paste /tmp/notes.md]
 *      <text body>
 *
 *      <user's typed text>
 *
 *  Pure / no I/O. Returns `""` when `entries` is empty so the surface can
 *  skip the prefix without branching. */
export const renderInboxPreamble = (entries: readonly TextInboxEntry[]): string => {
  if (entries.length === 0) return ""
  const parts: string[] = []
  for (const e of entries) {
    const tag = `[/${e.kind} ${e.label}]`
    parts.push(`${tag}\n${e.text}`)
  }
  return `${parts.join("\n\n")}\n\n`
}
