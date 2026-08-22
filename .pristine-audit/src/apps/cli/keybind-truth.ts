/**
 * WS-E (jul-10, UUX-2-02/1-09) — keybind copy SSOT.
 *
 * ONE table of the chord→action pairs that are ACTUALLY WIRED in production,
 * consumed by every surface that ADVERTISES a chord (`/help` keybind section,
 * welcome-banner footer). Hand-written mirrors of this information rotted
 * (UUX-2-02: `/help` shipped Ctrl+C and Esc-Esc INVERTED for weeks while the
 * welcome banner was correct) — so copy now derives from here and the
 * keybind-truth hellgate pins render ⟷ SSOT parity.
 *
 * Ground truth per entry (where the binding is INSTALLED):
 *  - `during-turn` chords — `repl/turn-cancel-install.ts` FSM (its unit
 *    hellgate pins the behavior: Ctrl+C ⇒ onAbort/quit, Esc-Esc ⇒ onCancel,
 *    Ctrl+B ⇒ onBackground). That module re-exports these entries as
 *    `TURN_CANCEL_KEYBINDS` so the copy sits ADJACENT to the FSM it describes.
 *  - `line-edit` chords — `raw-line-reader.ts#onKey` branches (all wired
 *    unconditionally or behind a CLI-seeded default-ON gate, noted inline).
 *  - `global` — chords honored both at the prompt AND during a turn.
 *
 * NOT here: `keybindings/defaults.ts` "advertising-only" remap-layer entries
 * without an installed branch — an entry lands in this table only when a real
 * handler exists (WS-E.1; the full install-time registry arrives with the
 * stdin-arbiter workstream).
 *
 * Slice pin: ZERO imports (pure data leaf) so the welcome banner (whose
 * header pins a minimal import surface) and help-render can both consume it.
 */

/** Where a chord is live: at the prompt (`line-edit`), while a turn streams
 *  (`during-turn`), or both (`global`). */
export type KeybindScope = "global" | "during-turn" | "line-edit"

export interface KeybindTruth {
  /** Display chord, e.g. `"Ctrl+C"`, `"Esc Esc"`. */
  readonly chord: string
  /** One-line action copy rendered verbatim by `/help`. */
  readonly describe: string
  readonly scope: KeybindScope
}

/** Esc-Esc (2× within the window) — SOFT cancel of the CURRENT turn; the REPL
 *  stays alive. Installed by `installTurnCancel` (`onCancel`). */
export const KB_CANCEL_TURN: KeybindTruth = {
  chord: "Esc Esc",
  describe: "Cancel the current turn (REPL stays alive)",
  scope: "during-turn",
}

/** Ctrl+C — HARD quit of the whole REPL. During a turn: `installTurnCancel`
 *  `onAbort`; at the prompt: `readLine` rejects `AbortError` ⇒ loop exit. */
export const KB_QUIT: KeybindTruth = {
  chord: "Ctrl+C",
  describe: "Quit the REPL",
  scope: "global",
}

/** Ctrl+B — move the running turn to the background (Ticket 18). Installed by
 *  `installTurnCancel` ONLY when the host wires `onBackground` — which needs
 *  the QUANTA_BG_TURN portal gate (default-OFF, NOT CLI-seeded) and a
 *  non-weave, non-interrupted turn (`shouldWireBackground`). The describe
 *  carries the gate so `/help` never advertises an unbound chord. */
export const KB_BACKGROUND: KeybindTruth = {
  chord: "Ctrl+B",
  describe: "Move the running turn to the background (requires QUANTA_BG_TURN=1)",
  scope: "during-turn",
}

/** Ctrl+D — EOF: exit the REPL when the line buffer is EMPTY (D-2, UUX-2-03);
 *  a non-empty buffer ignores it. Installed in `raw-line-reader.ts#onKey`. */
export const KB_EOF: KeybindTruth = {
  chord: "Ctrl+D",
  describe: "EOF — exit (empty line only)",
  scope: "line-edit",
}

/** Shift+Tab — cycle the permission mode. Installed by the raw-line-reader
 *  `onKey` branch behind the CLI-seeded QUANTA_MODE_CYCLE gate. Exported as a
 *  named entry (Wave-4, UUX-2-23) so the WELCOME BANNER advertises the SAME
 *  chord object `/help` renders — never a third hand-written mirror. */
export const KB_MODE_CYCLE: KeybindTruth = {
  chord: "Shift+Tab",
  describe: "Cycle permission mode (QUANTA_MODE_CYCLE gate)",
  scope: "line-edit",
}

/** The prompt-time (raw-line-reader `onKey`) bindings that actually have a
 *  handler branch. Gated entries name their gate — all CLI-seeded default-ON
 *  (see `cli-feature-gates.ts`). */
export const READER_KEYBINDS: readonly KeybindTruth[] = [
  { chord: "Enter", describe: "Submit the line", scope: "line-edit" },
  {
    chord: "Tab",
    describe: "Complete slash command / accept ghost text",
    scope: "line-edit",
  },
  {
    chord: "↑ / ↓",
    describe: "History prev/next · completion-list nav",
    scope: "line-edit",
  },
  {
    chord: "← / →",
    describe: "Move cursor (→ at end accepts ghost text)",
    scope: "line-edit",
  },
  {
    chord: "Home / End",
    describe: "Cursor to line start / end (also Ctrl+A / Ctrl+E)",
    scope: "line-edit",
  },
  { chord: "Backspace / Del", describe: "Delete back / forward", scope: "line-edit" },
  { chord: "Ctrl+R", describe: "Reverse history search", scope: "line-edit" },
  { chord: "Ctrl+W", describe: "Delete word before cursor", scope: "line-edit" },
  { chord: "Ctrl+U", describe: "Kill to line start", scope: "line-edit" },
  { chord: "Ctrl+K", describe: "Kill to line end", scope: "line-edit" },
  { chord: "Alt+B / Alt+F", describe: "Word left / right", scope: "line-edit" },
  { chord: "Esc", describe: "Close the completion menu", scope: "line-edit" },
  KB_MODE_CYCLE,
  {
    chord: "Ctrl+X Ctrl+E",
    describe: "Edit draft in $EDITOR (QUANTA_EXTERNAL_EDITOR gate)",
    scope: "line-edit",
  },
  KB_EOF,
] as const

/** The full advertised keybind table, render order = FSM chords first (the
 *  three a new operator needs), then the prompt line-edit set. */
export const KEYBIND_TRUTH: readonly KeybindTruth[] = [
  KB_CANCEL_TURN,
  KB_QUIT,
  KB_BACKGROUND,
  ...READER_KEYBINDS,
] as const
