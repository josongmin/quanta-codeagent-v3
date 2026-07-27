/** Bun-compatible line reader with Codex-style input box + below-prompt
 *  slash command palette.
 *
 *  Bun's `node:readline` polyfill (probe-verified 2026-05) does NOT invoke
 *  the `completer` option, so this module reads keys at the raw-mode
 *  `keypress` event level and renders the completion UX itself.
 *
 *  Layout (matches the Codex CLI reference):
 *
 *      › {buf}{ghost}                                           ◀ input row
 *        {meta}                                                 ◀ meta row
 *
 *      /name1      description for /name1                       ◀ candidate rows
 *      /name2      description for /name2                          (cyan name + dim desc)
 *      …
 *
 *  - The composer rows render on the terminal's default background — the
 *    earlier dark-band (xterm color 236) read as a solid black bar under
 *    dark themes, which several users called out as visually heavy.
 *  - The candidate list appears below the prompt rows, in a separate region.
 *    It's a plain two-column list (no border) with the command name in
 *    cyan and the description in dim gray, column-aligned to the widest
 *    visible name.
 *  - The list auto-opens as soon as the buffer starts with `/` and at
 *    least one candidate matches. Typing filters it in place; `↑`/`↓`
 *    navigate; `Tab`/`Enter` commit; `Esc` collapses it.
 *  - Ghost-text inline completion is still painted on the prompt row
 *    when the list is closed (a single match's tail in dim).
 *
 *  Scroll-stability invariant: every redraw paints inside the reserved
 *  band that the last expansion claimed; the band only ever grows (with
 *  a single terminal-scroll moment when it does), never shrinks
 *  mid-read. On read exit the band is fully erased and the prompt
 *  line is echoed normally so subsequent stdout starts on a fresh row.
 *
 *  Module layout: pure helpers (ANSI / column math, paste display, key-event
 *  rebuild, candidate-row rendering, shared types) live in `./raw-line-reader/`
 *  siblings and are re-exported below to preserve the public surface. The
 *  stateful `readLine` driver (+ its `onKey` keypress machine) stays here.
 */

import * as readline from "node:readline"
import {
  DISABLE_BRACKETED_PASTE,
  ENABLE_BRACKETED_PASTE,
  stringColumns,
  stripAnsi,
} from "./raw-line-reader/ansi"
import { createReaderMachine } from "./raw-line-reader/machine"
import type {
  ReaderStdin,
  ReaderStdout,
  ReadLineOptions,
  ReadLineTestIO,
} from "./raw-line-reader/options"
import { ghostSuffix } from "./raw-line-reader/render-rows"
import {
  createReaderState,
  longestCommonPrefix,
  refreshSlashCandidates,
  type State,
} from "./raw-line-reader/types"

export type { ReadLineOptions, ReadLineTestIO } from "./raw-line-reader/options"
// Re-export the complete public surface so every importer of
// `./raw-line-reader` stays byte-compatible after the split.
export { AbortError } from "./raw-line-reader/options"
export {
  type PasteBurstOptions,
  pasteBurstPlaceholder,
  projectPasteDisplay,
} from "./raw-line-reader/paste-display"
export type { CandidateDescriptor, CompleterFn, DescribeFn, State } from "./raw-line-reader/types"

export const readLine = (opts: ReadLineOptions, testIO?: ReadLineTestIO): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    const stdin: ReaderStdin = testIO?.stdin ?? process.stdin
    const stdout: ReaderStdout = testIO?.stdout ?? process.stderr
    const promptCols = stringColumns(stripAnsi(opts.prompt))
    // RFC-08 — `metaText` is a MUTABLE copy of `opts.meta` so the shift+tab
    // mode-cycle hook can repaint the pill line in place. `META_ROWS` is fixed
    // at construction from the INITIAL meta: when a meta line is present (the
    // production path always passes `provider · model · cwd`), the row is
    // reserved once and the cycle only swaps its CONTENT — the reserved row
    // count never changes, so the band geometry stays stable. When no meta was
    // supplied, the cycle hook leaves the layout untouched (no row to paint).
    // Boxed so the keymap's mode-cycle handler can repaint the pill line in
    // place (a handler receives the box through the KeyContext and writes
    // `metaText.value`). `redraw` reads `metaText.value` on every paint.
    const metaText = { value: opts.meta }
    const META_ROWS = metaText.value !== undefined && metaText.value !== "" ? 1 : 0
    const state: State = createReaderState()
    // Reset the history cursor at the start of every readLine so `↑` always
    // pulls the freshest entry first. Default-OFF when `opts.history` absent.
    opts.history?.reset()
    // RFC-11 / ADR-0446 — `ctrl+x` chord prefix latch. Set when `ctrl+x` is
    // seen with `opts.openEditor` wired; a following `ctrl+e` opens the editor.
    // Any other key clears it. Inert when `opts.openEditor` is absent. Boxed
    // so the keymap chord handlers can read/write the latch through the ctx.
    const pendingCtrlX = { value: false }

    if (testIO?.skipKeypressSetup !== true) {
      readline.emitKeypressEvents(stdin as unknown as NodeJS.ReadStream)
    }
    const wasRaw = stdin.isTTY === true ? (stdin.isRaw ?? false) : false
    if (stdin.isTTY === true) stdin.setRawMode?.(true)
    stdin.resume()

    // #10 — bracketed-paste enable/disable. Guarded on the opt AND a real TTY so
    // the OFF path (and a non-tty test stdin) never emits the DECSET bytes
    // (byte-identical). `enable` is called on raw-mode entry + editor-resume;
    // `disable` on every exit (cleanup) + editor-suspend, so no terminal is ever
    // left with bracketed-paste latched after the reader yields or crashes.
    const bracketedPasteOn = opts.bracketedPaste === true
    const enableBracketedPaste = (): void => {
      if (bracketedPasteOn && stdin.isTTY === true) stdout.write(ENABLE_BRACKETED_PASTE)
    }
    const disableBracketedPaste = (): void => {
      if (bracketedPasteOn && stdin.isTTY === true) stdout.write(DISABLE_BRACKETED_PASTE)
    }
    enableBracketedPaste()

    const refreshCandidates = (): void => refreshSlashCandidates(state, opts.completer)

    // Wire the reader machine (render band + settle lifecycle + interaction
    // closures + keymap adapter) in one factory so this executor stays a thin
    // composition root. Every closure body is byte-for-byte the former inline
    // version — see `./raw-line-reader/machine`.
    const machine = createReaderMachine({
      state,
      opts,
      stdin,
      stdout,
      promptCols,
      META_ROWS,
      metaText,
      pendingCtrlX,
      bracketedPasteOn,
      wasRaw,
      skipKeypressSetup: testIO?.skipKeypressSetup === true,
      refreshCandidates,
      enableBracketedPaste,
      disableBracketedPaste,
      resolve,
      reject,
    })

    // Attach the keypress listener + paint the initial band.
    stdin.on("keypress", machine.onKey)
    machine.growBandToTarget()
    machine.redraw()
  })
}

export const __longestCommonPrefixForTest = longestCommonPrefix
export const __stringColumnsForTest = stringColumns
export const __ghostSuffixForTest = ghostSuffix
