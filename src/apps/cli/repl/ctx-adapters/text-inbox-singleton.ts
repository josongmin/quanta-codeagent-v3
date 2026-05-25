/**
 * Text-inbox singleton factory (ADR-0291 — REPL slash-surface ctx mega-wire).
 *
 * Returns the surface-owned `TextInbox` instance `/web` (ADR-0224) writes
 * to AND the next-turn `PromptSource.next()` drains. Lifetime = REPL
 * process; a multi-tab Web/Tauri surface allocates one per session.
 * `createTextInbox` (sibling file `../../text-inbox.ts`) is the
 * primitive — this module is the wire seam so the REPL can swap caps
 * via opts without re-importing the primitive everywhere.
 */

import { createTextInbox, type TextInbox, type TextInboxOpts } from "../../text-inbox"

export interface TextInboxSingletonArgs extends TextInboxOpts {}

/** Build a fresh REPL-scoped text inbox. Always default-OFF: when the
 *  host omits this factory the slot is absent and `/web` degrades to
 *  printing the fetched body inline (web-cmd.ts handles that fallback). */
export const buildTextInboxSingleton = (args?: TextInboxSingletonArgs): TextInbox =>
  createTextInbox(args ?? {})
