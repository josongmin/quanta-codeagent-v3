/**
 * WS-F move 1 — the SINGLE slash-command execution choke point.
 *
 * Both accept paths (palette Tab/Enter/click AND the composer's submit) route
 * through `executeSlashCommand`, which turns a typed palette entry into a
 * typed outcome the host must apply. The pre-fix bug (UUX-2-01): App.tsx ran
 * the action, DISCARDED its returned draft, and cleared the input — so
 * `/rewind` + Enter silently wiped the draft. With outcomes, "silent no-op"
 * is unrepresentable: every kind maps to exactly one observable result.
 */

import type { SlashCommand } from "./SlashPalette"

export type SlashAcceptOutcome =
  /** Apply `nextDraft` to the composer (a `local` / `readout` action ran;
   *  its effects — transcript appends, HTTP calls — already happened). */
  | { readonly kind: "draft"; readonly nextDraft: string }
  /** Send `text` to the session as a turn — the daemon/LLM sees the slash
   *  line and the turn echo renders it in the transcript. */
  | { readonly kind: "sent"; readonly text: string }
  /** The entry is `unwired`: show `hint` inline and KEEP `keptDraft`. */
  | { readonly kind: "hint"; readonly hint: string; readonly keptDraft: string }

/**
 * Execute one accepted palette entry. `draft` is the composer content at
 * accept time — preserved verbatim in the `hint` outcome so an unwired
 * command never costs the user their text.
 */
export const executeSlashCommand = async (
  cmd: SlashCommand,
  rest: string,
  draft: string,
): Promise<SlashAcceptOutcome> => {
  switch (cmd.kind) {
    case "local":
    case "readout":
      return { kind: "draft", nextDraft: await cmd.action(rest) }
    case "server-slash":
      return {
        kind: "sent",
        text: rest.length > 0 ? `/${cmd.slug} ${rest}` : `/${cmd.slug}`,
      }
    case "unwired":
      return { kind: "hint", hint: cmd.hint, keptDraft: draft }
  }
}
