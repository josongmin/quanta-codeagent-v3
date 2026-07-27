/** Raw-line-reader IMPURE interaction closures, extracted from the `readLine`
 *  driver: the buffer-splice helpers (`acceptGhost`, `commitSelected`,
 *  `commitAtSelected`), the async `@`-dropdown query (`runAtList` +
 *  `openAtDropdown`), and the `$EDITOR` handoff (`runExternalEdit`).
 *
 *  Each takes a `ReaderRuntime` — the shared, per-`readLine` context bundling
 *  the mutable `State`, the boxed `settled` latch, the injected stdin/stdout,
 *  the render closures, and the reader-owned `refreshCandidates` /
 *  `emitKeypress` / bracketed-paste toggles. Threading one context object keeps
 *  the extracted logic byte-for-byte equivalent to the original inline closures
 *  while shrinking the driver below the god-function threshold. */

import type { AtCandidate } from "../at-autocomplete"
import { acceptSelected, atQuery, dismiss as dismissAt } from "../at-autocomplete"
import type { ExternalEditorPort } from "../raw-line-reader-editor"
import { CR, ERASE_LINE } from "./ansi"
import { ghostSuffix } from "./render-rows"
import type { State } from "./types"

/** The subset of `ReadLineOptions` these interactions read. */
interface InteractionOpts {
  readonly atProvider?: {
    list(query: string, signal?: AbortSignal): Promise<readonly AtCandidate[]>
  }
  readonly openEditor?: ExternalEditorPort
  readonly signal?: AbortSignal
}

/** Narrow stdin shape the editor handoff drives. Optional props carry
 *  `| undefined` explicitly so an `exactOptionalPropertyTypes` caller (the
 *  reader's `ReaderStdin`) is assignable. */
type KeypressCb = (str: string | undefined, key: unknown) => void
export interface RuntimeStdin {
  removeListener(event: "keypress", listener: KeypressCb): unknown
  on(event: "keypress", listener: KeypressCb): unknown
  resume(): unknown
  pause(): unknown
  readonly isTTY?: boolean | undefined
  setRawMode?: ((mode: boolean) => unknown) | undefined
}

/** The shared per-`readLine` runtime context. Every field is either the
 *  reader's mutable state, a boxed latch, or a reader-owned closure — the
 *  interactions never capture anything outside this bag. */
export interface ReaderRuntime {
  readonly state: State
  readonly opts: InteractionOpts
  readonly stdin: RuntimeStdin
  readonly stdout: { write(chunk: string): unknown }
  /** Boxed so a settle inside an awaited editor call is visible here. */
  readonly settled: { value: boolean }
  refreshCandidates(): void
  redraw(): void
  releaseBand(): void
  growBandToTarget(): void
  disableBracketedPaste(): void
  enableBracketedPaste(): void
  /** Re-arm `emitKeypressEvents` after the editor released the TTY (no-op when
   *  the test harness drives keypresses directly). */
  emitKeypress(): void
  /** The reader's keypress listener, re-attached after the editor handoff. */
  onKey(str: string | undefined, key: unknown): void
}

/** Accept the inline ghost-text completion into the buffer. */
export const acceptGhost = (rt: ReaderRuntime): boolean => {
  const { state } = rt
  const ghost = ghostSuffix(state.buf, state.candidates)
  if (ghost === "") return false
  state.buf += ghost
  state.cursor = state.buf.length
  rt.refreshCandidates()
  return true
}

/** Commit the highlighted slash-candidate into the buffer. */
export const commitSelected = (rt: ReaderRuntime): boolean => {
  const { state } = rt
  if (!state.listOpen || state.selectedIdx < 0) return false
  const pick = state.candidates[state.selectedIdx] ?? ""
  if (pick === "") return false
  state.buf = pick
  state.cursor = state.buf.length
  rt.refreshCandidates()
  return true
}

/** Accept the highlighted `@`-candidate: splice its `insertText` over
 *  `[triggerPos, cursor)` and close the dropdown. */
export const commitAtSelected = (rt: ReaderRuntime): boolean => {
  const { state } = rt
  const edit = acceptSelected(state.at, state.buf, state.cursor)
  if (edit === null) return false
  state.buf = edit.nextBuf
  state.cursor = edit.nextCursor
  dismissAt(state.at)
  rt.refreshCandidates()
  return true
}

/** Re-query the provider for the current `@`-query and reflect the result.
 *  Race-safe via `at.queryEpoch`; a stale `list()` is discarded. NO-THROW. */
export const runAtList = async (rt: ReaderRuntime): Promise<void> => {
  const { state, opts } = rt
  if (opts.atProvider === undefined || !state.at.active) return
  const query = atQuery(state.at, state.buf, state.cursor)
  state.at.queryEpoch += 1
  const myEpoch = state.at.queryEpoch
  let cands: readonly AtCandidate[]
  try {
    cands = await opts.atProvider.list(query, opts.signal)
  } catch {
    cands = []
  }
  if (rt.settled.value) return
  if (myEpoch !== state.at.queryEpoch) return // stale: a newer query superseded
  if (!state.at.active) return // dismissed while awaiting
  state.at.candidates = cands
  state.at.selectedIdx = cands.length > 0 ? 0 : -1
  // Fire-and-forget: swallow a terminal-write failure (next keystroke redraws).
  try {
    rt.redraw()
  } catch {
    /* terminal write failed; state is consistent, next keystroke redraws */
  }
}

/** Open the dropdown at `triggerPos` and kick off the initial empty-query list. */
export const openAtDropdown = (rt: ReaderRuntime, triggerPos: number): void => {
  const { state } = rt
  state.at.active = true
  state.at.triggerPos = triggerPos
  state.at.candidates = []
  state.at.selectedIdx = -1
  void runAtList(rt)
}

/** Suspend raw mode + detach the keypress listener, yield the terminal to
 *  `$EDITOR`, fold the edited draft back into `buf`, then RESTORE raw mode and
 *  re-attach — the restore lives in `finally` so a throwing / crashing /
 *  non-zero-exit editor can NEVER strand the terminal out of raw mode. */
export const runExternalEdit = async (rt: ReaderRuntime): Promise<void> => {
  const { state, opts, stdin, stdout } = rt
  if (rt.settled.value || opts.openEditor === undefined) return
  stdin.removeListener("keypress", rt.onKey)
  rt.releaseBand()
  stdout.write(CR + ERASE_LINE)
  const draft = state.buf
  try {
    rt.disableBracketedPaste()
    if (stdin.isTTY === true) stdin.setRawMode?.(false)
    stdin.pause()
    try {
      const edited = await opts.openEditor.openDraft(draft)
      if (!rt.settled.value) {
        state.buf = edited.text
        state.cursor = state.buf.length
      }
    } catch {
      /* editor port threw — draft kept; restore happens in finally */
    }
  } finally {
    if (!rt.settled.value) {
      if (stdin.isTTY === true) stdin.setRawMode?.(true)
      stdin.resume()
      rt.enableBracketedPaste()
      rt.emitKeypress()
      stdin.on("keypress", rt.onKey)
      rt.refreshCandidates()
      rt.growBandToTarget()
      rt.redraw()
    }
  }
}
