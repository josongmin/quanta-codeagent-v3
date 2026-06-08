/**
 * RFC-11 / ADR-0447 — the default keybinding map: the SSOT projection of the
 * hardcoded `onKey` if-chain in `raw-line-reader.ts` (RFC §2.1) onto the
 * closed action enum.
 *
 * Each entry mirrors an existing branch:
 *   return     → submit           (raw-line-reader.ts onKey "return")
 *   ctrl+c     → abort            ("ctrl c")
 *   ctrl+r     → reverse-search   ("ctrl r")
 *   escape     → menu-close       ("escape")
 *   tab        → complete         ("tab")
 *   up/down    → history-prev/next (context-branched in the handler)
 *   left/right → cursor-left/right
 *   home/end   → cursor-home/end
 *   backspace  → delete-back
 *   delete     → delete-forward
 *   ctrl+x ctrl+e → open-editor   (feature A, new)
 *
 * When `opts.keybindings` is absent the reader uses NEITHER this map nor the
 * remap path — it runs the original if-chain verbatim (byte-identical). This
 * map is consulted ONLY when the operator opted into the keybinding layer; it
 * is also the merge base for `mergeOverDefaults`.
 */

import type { KeyAction, KeybindingMap, KeySpec } from "./types"

const ENTRIES: ReadonlyArray<readonly [KeySpec, KeyAction]> = [
  ["return", "submit"],
  ["ctrl+c", "abort"],
  ["ctrl+r", "reverse-search"],
  ["escape", "menu-close"],
  ["tab", "complete"],
  ["up", "history-prev"],
  ["down", "history-next"],
  ["left", "cursor-left"],
  ["right", "cursor-right"],
  ["home", "cursor-home"],
  ["end", "cursor-end"],
  ["backspace", "delete-back"],
  ["delete", "delete-forward"],
  ["ctrl+x ctrl+e", "open-editor"],
  // Ticket 18 (V1) — Ctrl+B = move running turn to background. ADVERTISING ONLY
  // (the reader has no branch for it; the live binding is the per-turn cancel
  // FSM). Listed so the default map + `/help` show the chord.
  ["ctrl+b", "move-to-background"],
]

export const DEFAULT_KEYBINDINGS: KeybindingMap = new Map(ENTRIES)

/** Reverse projection: the CANONICAL default key for each action. Used by the
 *  remap path so a user binding (`ctrl+p → history-prev`) dispatches AS IF
 *  the default key (`up`) was pressed — keeping the handler's context logic
 *  (menu vs history) untouched. Built from the FIRST default entry per action
 *  (each action has exactly one default key here). */
const buildCanonicalKeyForAction = (): ReadonlyMap<KeyAction, KeySpec> => {
  const m = new Map<KeyAction, KeySpec>()
  for (const [spec, action] of ENTRIES) if (!m.has(action)) m.set(action, spec)
  return m
}

export const CANONICAL_KEY_FOR_ACTION: ReadonlyMap<KeyAction, KeySpec> =
  buildCanonicalKeyForAction()
