/** Raw-line-reader public option/IO types + the `AbortError` sentinel,
 *  extracted from `raw-line-reader.ts`. `ReadLineOptions`, `ReadLineTestIO`
 *  and `AbortError` are part of the reader's public surface and are
 *  re-exported from the parent module so importers stay byte-compatible. */

import type { AtCandidateProvider } from "../at-autocomplete"
import type { KeybindingMap } from "../keybindings/types"
import type { PromptHistory } from "../prompt-history"
import type { ExternalEditorPort } from "../raw-line-reader-editor"
import type { KeyEvent } from "./key-event"
import type { PasteBurstOptions } from "./paste-display"
import type { CompleterFn, DescribeFn } from "./types"

export interface ReadLineOptions {
  readonly prompt: string
  /** Optional host activity edge. Fired on every raw keypress before dispatch,
   * so an autonomous producer can yield while the operator is still drafting
   * a line rather than waiting for Enter. */
  readonly onActivity?: () => void
  readonly completer?: CompleterFn
  /** Optional description resolver — passed each candidate string in the
   *  filtered list. Returning a string shows it as the dim right-column
   *  hint; returning `undefined` leaves the row name-only. */
  readonly describe?: DescribeFn
  /** Optional meta line shown directly under the input prompt. Typical
   *  content: `provider · model · cwd`. Rendered dim on default background. */
  readonly meta?: string
  readonly signal?: AbortSignal
  /** Optional bash-style prompt history. When provided:
   *    - `↑`/`↓` navigate older/newer entries when the completion menu is
   *      closed (otherwise they still navigate the menu, byte-identical).
   *    - `Ctrl+R` enters reverse-i-search mode.
   *    - `Enter` pushes the submitted line back into history.
   *  Absent ⇒ all keypress paths byte-identical to the no-history build. */
  readonly history?: PromptHistory
  /** Optional heredoc multiline mode. When enabled (`true`), a leading
   *  `"""` (triple-quote, triple-backtick also accepted) on its own line
   *  opens a continuation prompt; a single line containing only the same
   *  fence closes it and submits the joined body (`\n`-separated, fence
   *  rows excluded). Absent / `false` ⇒ byte-identical, no fence detection. */
  readonly multiline?: boolean
  /** RFC-12 / ADR-0439 — optional `@`-mention autocomplete provider. When
   *  injected, typing `@` at a valid left-boundary opens a kind-grouped
   *  candidate dropdown (file / symbol / skill / plugin / app); `↑`/`↓`
   *  select, `Tab`/`Enter` accept (splice the mention token), `Esc`
   *  dismiss. Absent ⇒ `@` is an ordinary input char and EVERY keypress
   *  path is byte-identical to the no-provider build. */
  readonly atProvider?: AtCandidateProvider
  /** RFC-08 / ADR-0443 — `shift+tab` mode-cycle hook. A NON-submit key: when
   *  present, `shift+tab` (a.k.a. backtab / CSI Z) invokes this callback, which
   *  advances the host's turn-boundary mode store and returns the new `meta`
   *  line (pill + desc) to repaint under the prompt. The input buffer is NEVER
   *  touched and the line is NOT submitted. Absent ⇒ `shift+tab` is fully
   *  ignored and every keypress path is byte-identical to the no-hook build. */
  readonly onCycleMode?: () => { meta?: string } | undefined
  /** RFC-08 BUILD-1 — `effort-cycle` key action hook. A NON-submit UI callback
   *  owning NO store/model/config: when an operator-configured chord maps to the
   *  `effort-cycle` action, the keybinding-remap branch invokes this hook and
   *  consumes the key. The hook (composed at the host from the EXISTING slash
   *  `effort` + `model` wires) reads the live model's supported tiers, computes
   *  the next one via `nextSupportedEffort`, and calls the EXISTING
   *  `effort.set(next)` so the canonical `EffortStore` + status pill + next LLM
   *  request all update together. There is NO default chord and NO reader branch
   *  of its own. Absent ⇒ a bound `effort-cycle` chord is an inert no-op and
   *  every keypress path is byte-identical to the no-hook build. */
  readonly onCycleEffort?: () => void
  /** RFC-01 A4 — `focus-next-attention` key action hook. A NON-submit UI callback
   *  owning NO store: when an operator-configured chord maps to the
   *  `focus-next-attention` action, the keybinding-remap branch invokes this hook
   *  and consumes the key. The hook (composed at the host from the SAME
   *  `ctx.attention` + `ctx.agents` wires the `/attention` slash reads) runs the
   *  resolver over the live fleet and drills the next agent needing attention.
   *  There is NO default chord and NO reader branch of its own. Absent (gate off)
   *  ⇒ a bound chord is an inert no-op, byte-identical to the no-hook build. */
  readonly onFocusNextAttention?: () => void
  /** RFC-11 / ADR-0446 — external `$EDITOR` composition port. When injected,
   *  `ctrl+x ctrl+e` (the bash `edit-and-execute-command` chord) suspends raw
   *  mode, opens the current draft in `$EDITOR`, and folds the edited text back
   *  into the buffer WITHOUT submitting (the user presses Enter). Absent ⇒ the
   *  chord is ignored (ctrl-x / ctrl-e are control chars already dropped) and
   *  EVERY keypress path is byte-identical to the no-editor build. */
  readonly openEditor?: ExternalEditorPort
  /** RFC-11 / ADR-0447 — user keybinding map (loaded + merged over defaults
   *  from `~/.quanta/keybindings.json`). When injected, an incoming key is
   *  projected to its bound action and REMAPPED to that action's canonical
   *  default key before the existing if-chain runs — so context logic (menu vs
   *  history, heredoc, search) is preserved unchanged. Absent ⇒ NO remap, the
   *  hardcoded if-chain runs verbatim (byte-identical). */
  readonly keybindings?: KeybindingMap
  /** jun-6 (Codex paste-burst) — large-paste coalescing. When injected, a SINGLE
   *  keypress whose `str` carries at least `minChars` characters (a bracketed
   *  paste arrives as ONE multi-char keypress) is echoed as a compact
   *  `[Pasted Content <n> chars]` placeholder INSTEAD of the raw text — while the
   *  FULL pasted text is still spliced into the buffer and submitted verbatim.
   *  Detection uses chunk SIZE only (no clock / timing). Absent (default-OFF) ⇒
   *  every keypress path is byte-identical to today's build (paste is inserted +
   *  echoed inline, exactly as before). Injected at the composition root from the
   *  `QUANTA_PASTE_BURST` knob (the slice never reads env directly). */
  readonly pasteBurst?: PasteBurstOptions
  /** #10 (jun-11) — bracketed-paste mode. When `true`, the reader emits the
   *  DECSET `?2004h` enable sequence on raw-mode entry (and `?2004l` on every
   *  exit / editor-suspend) so the terminal wraps a paste in `ESC[200~ … ESC[201~`
   *  markers. Bun's `node:readline` surfaces those markers as discrete
   *  `paste-start`/`paste-end` keypress events (probe-verified 2026-06-11), so the
   *  reader can ACCUMULATE every keystroke between them — including the embedded
   *  `\r`/`\n` line breaks that otherwise arrive as `name:"return"` and SUBMIT the
   *  line at the first newline (the bug this fixes). The full pasted text lands in
   *  `buf` (multi-line preserved); the line only submits on a genuine Enter
   *  OUTSIDE a paste. Absent / `false` (default-OFF) ⇒ no `?2004h` is emitted, the
   *  markers never arrive, and EVERY keypress path is byte-identical to today's
   *  build (a pasted newline still early-submits — the legacy behavior). Injected
   *  at the composition root from the `QUANTA_BRACKETED_PASTE` CLI gate; the slice
   *  never reads env. */
  readonly bracketedPaste?: boolean
}

export class AbortError extends Error {
  constructor() {
    super("aborted")
    this.name = "AbortError"
  }
}

/** Narrow stdin shape `readLine` actually uses. Lets tests inject a fake
 *  keypress source without a real TTY (RFC §7). NOT part of the public
 *  contract — production always passes `process.stdin`. */
export interface ReaderStdin {
  on(event: "keypress", listener: KeypressListener): unknown
  removeListener(event: "keypress", listener: KeypressListener): unknown
  resume(): unknown
  pause(): unknown
  readonly isTTY?: boolean
  readonly isRaw?: boolean
  setRawMode?(mode: boolean): unknown
}
export type KeypressListener = (str: string | undefined, key: KeyEvent | undefined) => void
export interface ReaderStdout {
  write(chunk: string): unknown
}
/** Test-only I/O override. Production callers omit this entirely. */
export interface ReadLineTestIO {
  readonly stdin: ReaderStdin
  readonly stdout: ReaderStdout
  /** Skip `emitKeypressEvents` (the fake stdin emits `keypress` directly). */
  readonly skipKeypressSetup?: boolean
}
