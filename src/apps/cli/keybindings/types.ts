/**
 * RFC-11 / ADR-0447 — closed keybinding action vocabulary + the key→action
 * map shape consumed by the raw-line reader.
 *
 * The action set is a CLOSED enum (Codex `TuiComposerKeymap` /
 * `TuiEditorKeymap` parity, `_codex-rs-0.135-symbols.txt:47722`): a config
 * file may only bind one of these actions, anything else is REJECTED with a
 * warning (the item is dropped, the rest survive — never a crash).
 *
 * Every action below corresponds 1:1 to an existing `onKey` branch in
 * `raw-line-reader.ts` (the hardcoded if-chain that this layer makes
 * config-driven). No new behavior is introduced by the enum — it only names
 * the intents that already exist, plus `open-editor` (feature A).
 *
 * Slice posture: pure types + a frozen default constant. No `node:*`, no
 * `@/...`. Imported only inside `@/apps/cli`.
 */

export const KEY_ACTIONS = [
  "submit",
  "abort",
  "reverse-search",
  "complete",
  "menu-close",
  "history-prev",
  "history-next",
  "cursor-left",
  "cursor-right",
  "cursor-home",
  "cursor-end",
  "delete-back",
  "delete-forward",
  // jun-11 (#12) — readline-style word/line editing. Each maps 1:1 to a new
  // onKey branch in raw-line-reader.ts + a default chord in defaults.ts:
  //   delete-word-back → ctrl+w   kill-to-home → ctrl+u   kill-to-end → ctrl+k
  //   word-left → alt+b           word-right → alt+f
  // (cursor-home/cursor-end also gain ctrl+a / ctrl+e default chords.)
  "delete-word-back",
  "kill-to-home",
  "kill-to-end",
  "word-left",
  "word-right",
  "open-editor",
  // Ticket 18 (V1) — advertise the Ctrl+B "move running turn to background"
  // intent. ADVERTISING ONLY: the actual detach lives in the per-turn cancel
  // FSM (`turn-cancel-install.ts`), NOT in the raw-line reader's onKey chain
  // (this action has no reader branch). Listed so `/help` + the keybindings
  // config layer surface it as a bindable name.
  "move-to-background",
  // RFC-08 BUILD-1 — cycle the active model's supported reasoning-effort tiers.
  // Like `open-editor`, this action has NO canonical default chord (it is
  // operator-bindable ONLY, so it is absent from DEFAULT_KEYBINDINGS and
  // KEYBIND_TRUTH) and NO 1:1 reader branch — the keymap remap binding calls the
  // injected `onCycleEffort` hook directly when a configured chord maps here.
  "effort-cycle",
] as const

export type KeyAction = (typeof KEY_ACTIONS)[number]

export const ACTION_SET: ReadonlySet<string> = new Set<string>(KEY_ACTIONS)

/** A normalized key token: a single chord (`"ctrl+r"`, `"up"`) or a
 *  space-separated chord sequence (`"ctrl+x ctrl+e"`). Always lower-case,
 *  modifiers in canonical order. Produced by `normalizeKeySpec`. */
export type KeySpec = string

/** The resolved key→action map the raw-line reader routes through. */
export type KeybindingMap = ReadonlyMap<KeySpec, KeyAction>
