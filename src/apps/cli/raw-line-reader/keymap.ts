/** Raw-line-reader keypress DISPATCH TABLE, extracted from the `onKey`
 *  if/else cascade in `raw-line-reader.ts`.
 *
 *  The original `onKey` was a ~34-branch first-match if/else chain. Some
 *  branches `return` (they fully consume the key); OTHERS deliberately FALL
 *  THROUGH to a later branch (e.g. the `@`-dropdown Enter with no selection
 *  falls through to the submit branch; a printable char inside the dropdown
 *  falls through to the shared insert branch which then re-queries). A naive
 *  "one void handler per key, always return" table would silently drop those
 *  fall-throughs — the #1 refactor hazard.
 *
 *  So each binding's handler returns a `KeyResult`:
 *    - `"handled"`     ⇒ stop (equivalent to the original branch's `return`),
 *    - `"fallthrough"` ⇒ keep scanning later bindings (equivalent to the
 *                        original branch NOT returning and control reaching
 *                        the next `if`).
 *
 *  The dispatcher walks the table in DECLARATION ORDER and runs the FIRST
 *  binding whose `when(ctx)` predicate matches; if that handler returns
 *  `"fallthrough"` it continues from the NEXT binding. This reproduces the
 *  exact first-match + fall-through semantics of the original cascade
 *  byte-for-byte — the ordering of `KEY_BINDINGS` below is load-bearing and
 *  MUST match the source order of the original `if` blocks.
 *
 *  Everything the handlers touch (mutable `state`, the reader-owned redraw /
 *  refresh / settle closures, `opts`, and the two mutable latches `metaText`
 *  / `pendingCtrlX`) is threaded through the `KeyContext` so the table stays a
 *  pure data structure with no terminal / closure capture of its own.
 */

import type { AtCandidate } from "../at-autocomplete"
import {
  classifyBackspace,
  classifyChar,
  dismiss as dismissAt,
  selectNext,
  selectPrev,
} from "../at-autocomplete"
import { CANONICAL_KEY_FOR_ACTION } from "../keybindings/defaults"
import { keyOf } from "../keybindings/normalize"
import type { KeybindingMap } from "../keybindings/types"
import {
  deleteWordBefore,
  killToLineEnd,
  killToLineStart,
  wordLeft,
  wordRight,
} from "../line-edit-ops"
import type { ExternalEditorPort } from "../raw-line-reader-editor"
import { ESC, MAX_VISIBLE_CANDIDATES } from "./ansi"
import {
  cancelSearch,
  commitSearch,
  detectFence,
  setBufFromHistory,
  stepSearch,
} from "./history-search"
import { type KeyEvent, remapKeyEvent } from "./key-event"
import { AbortError } from "./options"
import {
  accumulatePasteKey,
  beginPaste,
  finishPaste,
  isPasteEnd,
  isPasteStart,
} from "./paste-accum"
import { pasteBurstPlaceholder } from "./paste-display"
import { ghostSuffix } from "./render-rows"
import type { State } from "./types"

/** The subset of `ReadLineOptions` the keymap handlers read. Kept structural so
 *  `keymap.ts` never imports the concrete `ReadLineOptions` (avoids a cycle) —
 *  the reader passes its own `opts` which is assignable to this shape. */
export interface KeymapOpts {
  readonly completer?: (line: string) => readonly string[]
  readonly history?: {
    reset(): unknown
    next(): string | undefined
    prev(): string | undefined
    push(entry: string): unknown
    search(query: string): string | undefined
  }
  readonly multiline?: boolean
  readonly atProvider?: {
    list(query: string, signal?: AbortSignal): Promise<readonly AtCandidate[]>
  }
  readonly onCycleMode?: () => { meta?: string } | undefined
  /** RFC-08 BUILD-1 — bound `effort-cycle` action hook (see `options.ts`). */
  readonly onCycleEffort?: () => void
  /** RFC-01 A4 — bound `focus-next-attention` action hook (see `options.ts`). */
  readonly onFocusNextAttention?: () => void
  readonly openEditor?: ExternalEditorPort
  readonly keybindings?: KeybindingMap
  readonly pasteBurst?: { readonly minChars: number }
  readonly bracketedPaste?: boolean
  readonly signal?: AbortSignal
}

/** A mutable single-slot box for a reader-owned local (`metaText`,
 *  `pendingCtrlX`) so a handler can both read and write it through the ctx. */
export interface Box<T> {
  value: T
}

/** Everything a keymap handler needs. The reader constructs ONE of these per
 *  `readLine` call, closing over its stdin/stdout/band closures, and hands the
 *  same object to every dispatch. */
export interface KeyContext {
  readonly state: State
  readonly opts: KeymapOpts
  /** The (possibly remapped) key event for this dispatch. */
  key: KeyEvent
  /** The raw `str` argument of the keypress. */
  readonly str: string | undefined
  readonly metaText: Box<string | undefined>
  readonly pendingCtrlX: Box<boolean>
  readonly bracketedPasteOn: boolean
  // reader-owned side-effecting closures (impure: terminal + async) ─────────
  refreshCandidates(): void
  redraw(): void
  settleResolve(value: string): void
  settleReject(err: Error): void
  acceptGhost(): boolean
  commitSelected(): boolean
  commitAtSelected(): boolean
  openAtDropdown(triggerPos: number): void
  runAtList(): void
  runExternalEdit(): void
}

/** The per-`readLine` invariant slice of a `KeyContext`: everything that does
 *  NOT change between keystrokes (the state, opts, latches, and reader-owned
 *  closures). The driver builds this ONCE; `makeKeyContext` stamps the
 *  per-keystroke `key` / `str` onto it. Keeps the executor body thin. */
export type KeyContextBase = Omit<KeyContext, "key" | "str">

/** Build a per-keystroke `KeyContext` from the invariant base + this event. */
export const makeKeyContext = (
  base: KeyContextBase,
  str: string | undefined,
  key: KeyEvent | undefined,
): KeyContext => ({ ...base, key: key ?? {}, str })

export type KeyResult = "handled" | "fallthrough"

export interface KeyBinding {
  /** Guard: does this binding apply to the current key/context? */
  readonly when: (ctx: KeyContext) => boolean
  /** Handler: mutate state / fire side effects; return whether the key is
   *  fully consumed (`"handled"`) or should keep scanning (`"fallthrough"`). */
  readonly run: (ctx: KeyContext) => KeyResult
}

const isBackTab = (k: KeyEvent): boolean =>
  (k.name === "tab" && k.shift === true) || k.sequence === `${ESC}Z`

/**
 * The dispatch table. Order == the source order of the original `onKey` if
 * blocks. DO NOT REORDER — a reordered binding changes which handler wins for
 * an ambiguous key (the exact hazard this refactor guards against).
 *
 * Each entry is annotated with the original branch it replaces.
 */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  // ── #10 — bracketed paste: while pasting, route EVERY key to accumulation ──
  {
    when: (c) => c.bracketedPasteOn && c.state.pasting,
    run: (c) => {
      if (isPasteEnd(c.key)) {
        finishPaste(c.state, c.opts, c.refreshCandidates, c.redraw)
        return "handled"
      }
      accumulatePasteKey(c.state, c.str, c.key)
      return "handled"
    },
  },
  // paste-start marker (not yet pasting)
  {
    when: (c) => c.bracketedPasteOn && !c.state.pasting && isPasteStart(c.key),
    run: (c) => {
      beginPaste(c.state)
      return "handled"
    },
  },

  // ── ctrl+c: abort always wins ─────────────────────────────────────────────
  {
    when: (c) => c.key.ctrl === true && c.key.name === "c",
    run: (c) => {
      c.settleReject(new AbortError())
      return "handled"
    },
  },

  // ── RFC-11 — ctrl+x ctrl+e chord (only when openEditor is wired) ───────────
  // ONE binding (NOT two) so the original `if (pendingCtrlX) … else if (ctrl+x)`
  // MUTUAL EXCLUSION is preserved. Splitting it into two bindings was a real
  // regression: after the "latch was set" arm cleared `pendingCtrlX` and fell
  // through, the dispatcher re-evaluated the "arm the latch" binding's `when` —
  // which now matched the just-cleared state — so `ctrl+x ctrl+x` RE-LATCHED and
  // a following `ctrl+e` wrongly opened the editor. Capturing the entry-state in a
  // single handler makes the two arms un-re-matchable (pinned by the golden
  // ctrl+x-ctrl+x-ctrl+e case).
  {
    when: (c) =>
      c.opts.openEditor !== undefined &&
      (c.pendingCtrlX.value || (c.key.ctrl === true && c.key.name === "x")),
    run: (c) => {
      if (c.pendingCtrlX.value) {
        // latch WAS set — consume the chord
        c.pendingCtrlX.value = false
        if (c.key.ctrl === true && c.key.name === "e") {
          c.runExternalEdit()
          return "handled"
        }
        // Any other key after ctrl-x (INCLUDING a 2nd ctrl+x): abandon the chord,
        // do NOT re-arm, FALL THROUGH so the key reaches its normal handler below.
        return "fallthrough"
      }
      // latch was NOT set, key is ctrl+x → arm the chord.
      c.pendingCtrlX.value = true
      return "handled"
    },
  },

  // ── RFC-11 — keybinding remap: rewrite `key` in place, then FALL THROUGH ───
  {
    when: (c) => c.opts.keybindings !== undefined,
    run: (c) => {
      const chord = keyOf(c.key)
      const action = chord !== null ? c.opts.keybindings?.get(chord) : undefined
      if (action === "open-editor") {
        if (c.opts.openEditor !== undefined) c.runExternalEdit()
        return "handled"
      }
      // RFC-08 BUILD-1 — a chord bound to `effort-cycle` invokes the injected
      // hook and CONSUMES the key (like `open-editor`, it has no canonical
      // reader branch to remap onto). The hook reads the live model/effort wires
      // and calls the EXISTING `effort.set`; the reader owns no effort state. A
      // bound chord with NO hook wired is an inert consume (byte-identical to the
      // no-hook build apart from the key not reaching its raw insert).
      if (action === "effort-cycle") {
        c.opts.onCycleEffort?.()
        return "handled"
      }
      // RFC-01 A4 — a chord bound to `focus-next-attention` invokes the injected
      // hook and CONSUMES the key (like `effort-cycle`, it has no canonical reader
      // branch to remap onto). The hook runs the resolver over the live fleet and
      // drills the top pick. A bound chord with NO hook wired (gate off) is an
      // inert consume (byte-identical apart from the key not reaching raw insert).
      if (action === "focus-next-attention") {
        c.opts.onFocusNextAttention?.()
        return "handled"
      }
      if (action !== undefined) {
        const canonical = CANONICAL_KEY_FOR_ACTION.get(action)
        if (canonical !== undefined && !canonical.includes(" ") && canonical !== chord) {
          c.key = remapKeyEvent(canonical)
        }
      }
      return "fallthrough"
    },
  },

  // ── RFC-08 — shift+tab (backtab) mode-cycle ───────────────────────────────
  {
    when: (c) => isBackTab(c.key) && c.opts.onCycleMode !== undefined,
    run: (c) => {
      const res = c.opts.onCycleMode?.()
      if (res && typeof res.meta === "string") c.metaText.value = res.meta
      c.redraw()
      return "handled"
    },
  },

  // ── reverse-i-search: highest priority once active ────────────────────────
  {
    when: (c) => c.state.searchMode,
    run: (c) => {
      const { key: k, state } = c
      if (k.name === "return") {
        commitSearch(state, c.refreshCandidates)
        c.settleResolve(state.buf)
        return "handled"
      }
      if (k.name === "escape" || (k.ctrl === true && k.name === "g")) {
        cancelSearch(state)
        c.redraw()
        return "handled"
      }
      if (k.ctrl === true && k.name === "r") {
        state.searchMatch = c.opts.history?.search(state.searchQuery) ?? state.searchMatch
        c.redraw()
        return "handled"
      }
      if (k.name === "backspace") {
        state.searchQuery = state.searchQuery.slice(0, -1)
        stepSearch(state, c.opts.history, c.redraw)
        return "handled"
      }
      if (typeof c.str === "string" && c.str.length === 1 && c.str >= " ") {
        state.searchQuery += c.str
        stepSearch(state, c.opts.history, c.redraw)
        return "handled"
      }
      // Ignore other keys inside search mode (no edit, no nav).
      return "handled"
    },
  },

  // ── ctrl+r: ENTER reverse-i-search (history wired) ────────────────────────
  {
    when: (c) => c.key.ctrl === true && c.key.name === "r" && c.opts.history !== undefined,
    run: (c) => {
      c.state.searchMode = true
      c.state.searchQuery = ""
      c.state.searchMatch = ""
      c.opts.history?.reset()
      c.redraw()
      return "handled"
    },
  },

  // ── ctrl+d: EOF on empty line ─────────────────────────────────────────────
  {
    when: (c) => c.key.ctrl === true && c.key.name === "d",
    run: (c) => {
      if (c.state.buf.length === 0 && !c.state.heredocOpen) c.settleReject(new AbortError())
      return "handled"
    },
  },

  // ── RFC-12 — @-dropdown routing (may FALL THROUGH for shared handlers) ─────
  {
    when: (c) => c.state.at.active,
    run: (c) => {
      const { key: k, state } = c
      const total = state.at.candidates.length
      if (k.name === "escape") {
        dismissAt(state.at)
        c.redraw()
        return "handled"
      }
      if (k.name === "return" || k.name === "tab") {
        if (c.commitAtSelected()) {
          c.redraw()
          return "handled"
        }
        dismissAt(state.at)
        if (k.name === "tab") {
          c.redraw()
          return "handled"
        }
        // Enter with no selection: FALL THROUGH to the normal submit below.
        return "fallthrough"
      }
      if (k.name === "down") {
        state.at.selectedIdx = selectNext(state.at, total)
        c.redraw()
        return "handled"
      }
      if (k.name === "up") {
        state.at.selectedIdx = selectPrev(state.at, total)
        c.redraw()
        return "handled"
      }
      if (k.name === "backspace") {
        const verdict = classifyBackspace(state.at, state.cursor)
        if (verdict.kind === "dismiss") {
          if (state.cursor > 0) {
            state.buf = state.buf.slice(0, state.cursor - 1) + state.buf.slice(state.cursor)
            state.cursor -= 1
          }
          dismissAt(state.at)
          c.refreshCandidates()
          c.redraw()
          return "handled"
        }
        if (verdict.kind === "requery") {
          state.buf = state.buf.slice(0, state.cursor - 1) + state.buf.slice(state.cursor)
          state.cursor -= 1
          c.runAtList()
          c.redraw()
          return "handled"
        }
      }
      // Any other key (printable char, Left/Right/Home/End, Delete) FALLS
      // THROUGH to the shared handlers below; the char branch re-queries.
      return "fallthrough"
    },
  },

  // ── return: submit (with slash-commit + heredoc handling) ─────────────────
  {
    when: (c) => c.key.name === "return",
    run: (c) => {
      const { state, opts } = c
      if (state.listOpen && state.selectedIdx >= 0) c.commitSelected()
      if (opts.multiline === true) {
        const fence = detectFence(state.buf)
        if (!state.heredocOpen && fence !== "") {
          state.heredocOpen = true
          state.heredocFence = fence
          state.heredocLines = []
          state.buf = ""
          state.cursor = 0
          c.refreshCandidates()
          c.redraw()
          return "handled"
        }
        if (state.heredocOpen && fence === state.heredocFence) {
          const body = state.heredocLines.join("\n")
          state.heredocOpen = false
          state.heredocFence = ""
          state.heredocLines = []
          state.buf = body
          state.cursor = body.length
          if (opts.history !== undefined && body !== "") opts.history.push(body)
          c.settleResolve(body)
          return "handled"
        }
        if (state.heredocOpen) {
          state.heredocLines.push(state.buf)
          state.buf = ""
          state.cursor = 0
          c.refreshCandidates()
          c.redraw()
          return "handled"
        }
      }
      if (opts.history !== undefined) opts.history.push(state.buf)
      c.settleResolve(state.buf)
      return "handled"
    },
  },

  // ── escape: collapse the slash palette ────────────────────────────────────
  {
    when: (c) => c.key.name === "escape",
    run: (c) => {
      if (c.state.listOpen) {
        c.state.listOpen = false
        c.state.selectedIdx = -1
        c.redraw()
      }
      return "handled"
    },
  },

  // ── tab: commit / ghost-accept / open list ────────────────────────────────
  {
    when: (c) => c.key.name === "tab",
    run: (c) => {
      const { state } = c
      if (state.listOpen && state.selectedIdx >= 0) {
        c.commitSelected()
      } else if (!c.acceptGhost() && state.candidates.length > 0) {
        state.listOpen = true
        state.selectedIdx = 0
      }
      c.redraw()
      return "handled"
    },
  },

  // ── down: menu nav OR history next ────────────────────────────────────────
  {
    when: (c) => c.key.name === "down",
    run: (c) => {
      const { state, opts } = c
      if (state.listOpen && state.candidates.length > 0) {
        const visible = Math.min(state.candidates.length, MAX_VISIBLE_CANDIDATES)
        state.selectedIdx = (state.selectedIdx + 1) % visible
        c.redraw()
        return "handled"
      }
      if (opts.history !== undefined && !state.heredocOpen) {
        setBufFromHistory(state, opts.history.next(), c.refreshCandidates)
        c.redraw()
      }
      return "handled"
    },
  },

  // ── up: menu nav OR history prev ──────────────────────────────────────────
  {
    when: (c) => c.key.name === "up",
    run: (c) => {
      const { state, opts } = c
      if (state.listOpen && state.candidates.length > 0) {
        const visible = Math.min(state.candidates.length, MAX_VISIBLE_CANDIDATES)
        state.selectedIdx = state.selectedIdx <= 0 ? visible - 1 : state.selectedIdx - 1
        c.redraw()
        return "handled"
      }
      if (opts.history !== undefined && !state.heredocOpen) {
        const prev = opts.history.prev()
        if (prev !== undefined) {
          setBufFromHistory(state, prev, c.refreshCandidates)
          c.redraw()
        }
      }
      return "handled"
    },
  },

  // ── right: ghost-accept at end OR cursor right ────────────────────────────
  {
    when: (c) => c.key.name === "right",
    run: (c) => {
      const { state } = c
      if (state.cursor === state.buf.length && ghostSuffix(state.buf, state.candidates) !== "") {
        c.acceptGhost()
      } else if (state.cursor < state.buf.length) {
        state.cursor += 1
      }
      c.redraw()
      return "handled"
    },
  },

  // ── left: cursor left ─────────────────────────────────────────────────────
  {
    when: (c) => c.key.name === "left",
    run: (c) => {
      if (c.state.cursor > 0) {
        c.state.cursor -= 1
        c.redraw()
      }
      return "handled"
    },
  },

  // ── home ──────────────────────────────────────────────────────────────────
  {
    when: (c) => c.key.name === "home",
    run: (c) => {
      c.state.cursor = 0
      c.redraw()
      return "handled"
    },
  },

  // ── end ───────────────────────────────────────────────────────────────────
  {
    when: (c) => c.key.name === "end",
    run: (c) => {
      c.state.cursor = c.state.buf.length
      c.redraw()
      return "handled"
    },
  },

  // ── backspace ─────────────────────────────────────────────────────────────
  {
    when: (c) => c.key.name === "backspace",
    run: (c) => {
      const { state, opts } = c
      if (state.cursor > 0) {
        state.buf = state.buf.slice(0, state.cursor - 1) + state.buf.slice(state.cursor)
        state.cursor -= 1
        if (state.historyDraft !== null) {
          state.historyDraft = null
          opts.history?.reset()
        }
        c.refreshCandidates()
        c.redraw()
      }
      return "handled"
    },
  },

  // ── delete ────────────────────────────────────────────────────────────────
  {
    when: (c) => c.key.name === "delete",
    run: (c) => {
      const { state, opts } = c
      if (state.cursor < state.buf.length) {
        state.buf = state.buf.slice(0, state.cursor) + state.buf.slice(state.cursor + 1)
        if (state.historyDraft !== null) {
          state.historyDraft = null
          opts.history?.reset()
        }
        c.refreshCandidates()
        c.redraw()
      }
      return "handled"
    },
  },

  // ── ctrl+w / ctrl+u / ctrl+k: word/line kill ──────────────────────────────
  {
    when: (c) =>
      c.key.ctrl === true && (c.key.name === "w" || c.key.name === "u" || c.key.name === "k"),
    run: (c) => {
      const { state, opts, key: k } = c
      const cur = { buf: state.buf, cursor: state.cursor }
      const next =
        k.name === "w"
          ? deleteWordBefore(cur)
          : k.name === "u"
            ? killToLineStart(cur)
            : killToLineEnd(cur)
      if (next.buf !== state.buf || next.cursor !== state.cursor) {
        state.buf = next.buf
        state.cursor = next.cursor
        if (state.historyDraft !== null) {
          state.historyDraft = null
          opts.history?.reset()
        }
        c.refreshCandidates()
        c.redraw()
      }
      return "handled"
    },
  },

  // ── ctrl+a / ctrl+e: cursor home/end ──────────────────────────────────────
  {
    when: (c) => c.key.ctrl === true && (c.key.name === "a" || c.key.name === "e"),
    run: (c) => {
      c.state.cursor = c.key.name === "a" ? 0 : c.state.buf.length
      c.redraw()
      return "handled"
    },
  },

  // ── meta+b / meta+f: word left/right ──────────────────────────────────────
  {
    when: (c) => c.key.meta === true && (c.key.name === "b" || c.key.name === "f"),
    run: (c) => {
      const { state, key: k } = c
      state.cursor =
        k.name === "b"
          ? wordLeft({ buf: state.buf, cursor: state.cursor })
          : wordRight({ buf: state.buf, cursor: state.cursor })
      c.redraw()
      return "handled"
    },
  },

  // ── printable insert (+ @-classify + paste-burst record) ──────────────────
  {
    when: (c) => typeof c.str === "string" && c.str.length > 0,
    run: (c) => {
      const { state, opts, str } = c
      if (str === "\t" || str === "\r" || str === "\n") return "handled"
      if (str !== undefined && str.length === 1 && str < " ") return "handled"
      const s = str as string
      const isPaste = s.length > 1
      const insertAt = state.cursor
      const verdict =
        opts.atProvider !== undefined
          ? classifyChar({
              state: state.at,
              buf: state.buf,
              cursor: insertAt,
              ch: s,
              providerPresent: true,
              isPaste,
            })
          : ({ kind: "ignore" } as const)
      state.buf = state.buf.slice(0, state.cursor) + s + state.buf.slice(state.cursor)
      state.cursor += s.length
      if (opts.pasteBurst !== undefined) {
        const charCount = [...s].length
        if (charCount >= opts.pasteBurst.minChars) {
          state.pasteSegments.push({ text: s, placeholder: pasteBurstPlaceholder(charCount) })
        }
      }
      if (state.historyDraft !== null) {
        state.historyDraft = null
        opts.history?.reset()
      }
      c.refreshCandidates()
      if (verdict.kind === "open") {
        c.openAtDropdown(verdict.triggerPos)
      } else if (verdict.kind === "requery") {
        c.runAtList()
      } else if (verdict.kind === "dismiss") {
        dismissAt(state.at)
      }
      c.redraw()
      return "handled"
    },
  },
]

/** Drive one keypress through the dispatch table. Walks `KEY_BINDINGS` in
 *  declaration order, running the FIRST binding whose `when` matches; if its
 *  handler returns `"fallthrough"` it continues from the NEXT binding. This is
 *  the exact first-match + fall-through semantics of the original `onKey`
 *  cascade. */
export const dispatchKey = (
  ctx: KeyContext,
  bindings: readonly KeyBinding[] = KEY_BINDINGS,
): void => {
  for (const binding of bindings) {
    if (!binding.when(ctx)) continue
    if (binding.run(ctx) === "handled") return
    // "fallthrough" ⇒ keep scanning later bindings.
  }
}
