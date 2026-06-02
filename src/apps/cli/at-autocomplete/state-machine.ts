/**
 * RFC-12 / ADR-0436 §4.3 — `@`-dropdown keypress state machine (pure).
 *
 * Extracted as a PURE module so the keypress logic is testable without a
 * real TTY (RFC §7) and so `raw-line-reader.ts` stays a thin host: it owns
 * the `keypress` event + the redraw, and delegates every `@`-mode decision
 * here. The machine NEVER touches stdin/stdout; it transforms `(state, buf,
 * cursor, key) ⇒ result` and the host applies the result.
 *
 * Default-OFF byte-identical: the host calls into this machine ONLY when an
 * `AtCandidateProvider` is injected. With no provider the host never enters
 * `@`-mode, so all key paths stay exactly as they are today.
 */

import type { AtCandidate } from "./port"

/** Mutable `@`-dropdown sub-state. All fields inert until the host opens
 *  the dropdown (`active=false` ⇒ machine is dormant). */
export interface AtState {
  /** Dropdown open? */
  active: boolean
  /** Index of the `@` sigil in `buf`. Accept replaces `[triggerPos, cursor)`. */
  triggerPos: number
  /** Current candidate list (set by the host after an async `list()`). */
  candidates: readonly AtCandidate[]
  /** Highlighted index, or `-1` when there are no candidates. */
  selectedIdx: number
  /** Monotonic token so a stale async `list()` result can be discarded. */
  queryEpoch: number
}

/** Build a fresh, dormant `@`-state. */
export const createAtState = (): AtState => ({
  active: false,
  triggerPos: -1,
  candidates: [],
  selectedIdx: -1,
  queryEpoch: 0,
})

/** A JS word char (mirrors the parser left-boundary rule `parser.ts:104`). */
const isWordChar = (ch: string): boolean => /\w/.test(ch)

/**
 * Left-boundary predicate (RFC §4.3a, parser rule 6): an `@` may only
 * trigger the dropdown at start-of-buffer or immediately after a non-word
 * char. `foo@` (email-like) does NOT trigger.
 *
 * @param buf    — the buffer the `@` is about to be inserted INTO.
 * @param cursor — the position the `@` will be inserted AT (char to the
 *                 left is `buf[cursor-1]`).
 */
export const isAtTriggerBoundaryOk = (buf: string, cursor: number): boolean => {
  if (cursor <= 0) return true
  const prev = buf[cursor - 1] ?? ""
  return !isWordChar(prev)
}

/** Derive the live query (text after the `@` sigil up to the cursor). */
export const atQuery = (state: AtState, buf: string, cursor: number): string => {
  if (!state.active || state.triggerPos < 0) return ""
  const start = state.triggerPos + 1
  if (cursor < start) return ""
  return buf.slice(start, cursor)
}

/** A character CONTINUES a `@`-mention query. A whitespace / control char
 *  terminates it (and so dismisses the dropdown); everything else — ASCII
 *  path/symbol/kebab chars (`/`, `.`, `:`, `-`, `_`, `~`) AND non-ASCII
 *  letters (so CJK file paths like `@자료/요약.ts` keep the dropdown open) —
 *  continues. The dismiss set is intentionally narrow (whitespace + a few
 *  shell/quote separators) so a paste/typo never strands an open dropdown. */
const isMentionChar = (ch: string): boolean => {
  if (ch === "") return false
  if (/\s/.test(ch)) return false
  // explicit separators that clearly end a mention token
  if ("\"'`(){}[]<>|&;,".includes(ch)) return false
  return true
}

/** The result of feeding one inserted character to the machine while a
 *  dropdown decision is pending. */
export type CharResult =
  | { readonly kind: "open"; readonly triggerPos: number }
  | { readonly kind: "requery" }
  | { readonly kind: "dismiss" }
  | { readonly kind: "ignore" }

/**
 * Decide what an inserted single character does w.r.t. the dropdown. The
 * host still performs the actual buffer mutation; this only classifies.
 *
 * @param providerPresent — false ⇒ machine is disabled (always `ignore`),
 *                          which keeps the host on its byte-identical path.
 * @param isPaste        — true ⇒ multi-char paste; `@` never opens (RFC §6).
 */
export const classifyChar = (args: {
  readonly state: AtState
  readonly buf: string
  readonly cursor: number
  readonly ch: string
  readonly providerPresent: boolean
  readonly isPaste: boolean
}): CharResult => {
  const { state, buf, cursor, ch, providerPresent, isPaste } = args
  if (!providerPresent) return { kind: "ignore" }
  if (state.active) {
    // Already open: a mention char re-queries; anything else dismisses.
    if (isMentionChar(ch)) return { kind: "requery" }
    return { kind: "dismiss" }
  }
  // Closed: only a lone `@` at a valid left-boundary (non-paste) opens.
  if (ch === "@" && !isPaste && isAtTriggerBoundaryOk(buf, cursor)) {
    return { kind: "open", triggerPos: cursor }
  }
  return { kind: "ignore" }
}

/** Backspace handling while the dropdown is open. */
export type BackspaceResult =
  | { readonly kind: "dismiss" } // erased the `@` (or before it) ⇒ close
  | { readonly kind: "requery" } // shrank the query ⇒ re-list
  | { readonly kind: "ignore" } // dropdown not open ⇒ host's normal backspace

/**
 * Classify a backspace. `cursor` is the position BEFORE the delete. Erasing
 * the `@` itself (cursor lands at/under `triggerPos`) dismisses; otherwise
 * the query shrinks and we re-query.
 */
export const classifyBackspace = (state: AtState, cursor: number): BackspaceResult => {
  if (!state.active) return { kind: "ignore" }
  // After the delete the cursor is at `cursor - 1`. If that is <= triggerPos
  // the `@` sigil itself is gone ⇒ dismiss.
  if (cursor - 1 <= state.triggerPos) return { kind: "dismiss" }
  return { kind: "requery" }
}

/** Move the selection down (wrapping) within the visible candidate set. */
export const selectNext = (state: AtState, visible: number): number => {
  if (visible <= 0) return -1
  return (state.selectedIdx + 1) % visible
}

/** Move the selection up (wrapping). */
export const selectPrev = (state: AtState, visible: number): number => {
  if (visible <= 0) return -1
  return state.selectedIdx <= 0 ? visible - 1 : state.selectedIdx - 1
}

/** The buffer edit produced by accepting the highlighted candidate. The
 *  host splices `insertText` over `[triggerPos, cursor)` and moves the
 *  cursor to the end of the inserted text. Returns `null` when there is no
 *  valid selection. */
export interface AcceptEdit {
  readonly nextBuf: string
  readonly nextCursor: number
}

export const acceptSelected = (state: AtState, buf: string, cursor: number): AcceptEdit | null => {
  if (!state.active || state.triggerPos < 0) return null
  if (state.selectedIdx < 0 || state.selectedIdx >= state.candidates.length) return null
  const pick = state.candidates[state.selectedIdx]
  if (pick === undefined) return null
  const head = buf.slice(0, state.triggerPos)
  const tail = buf.slice(cursor)
  const nextBuf = head + pick.insertText + tail
  const nextCursor = state.triggerPos + pick.insertText.length
  return { nextBuf, nextCursor }
}

/** Reset the machine to dormant (after accept / dismiss / submit). */
export const dismiss = (state: AtState): void => {
  state.active = false
  state.triggerPos = -1
  state.candidates = []
  state.selectedIdx = -1
}
