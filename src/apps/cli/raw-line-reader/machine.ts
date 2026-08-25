/** Raw-line-reader closure WIRING, extracted from the `readLine` executor.
 *
 *  `createReaderMachine` bundles the render-band closures, the settle /
 *  cleanup lifecycle, the abort-signal listener, the impure interaction
 *  aliases, and the `onKey` keymap adapter into ONE factory over an injected
 *  `MachineDeps` bag. Pulling this out keeps the `readLine` Promise executor a
 *  thin composition root (primitive setup → wire → attach → paint) instead of
 *  a god-function; every closure body is identical to the former inline
 *  version, so the byte stream is unchanged. */

import * as readline from "node:readline"
import type { ReaderRuntime, RuntimeStdin } from "./interactions"
import * as interactions from "./interactions"
import type { KeyEvent } from "./key-event"
import { dispatchKey, type KeyContextBase, type KeymapOpts, makeKeyContext } from "./keymap"
import { AbortError } from "./options"
import type { RenderContext } from "./render"
import * as renderModule from "./render"
import type { State } from "./types"

/** The subset of `ReadLineOptions` the machine reads. Structural (an
 *  intersection of every consumer's view) to avoid a cycle back to the
 *  concrete `ReadLineOptions`. */
type MachineOpts = KeymapOpts &
  ReaderRuntime["opts"] &
  RenderContext["opts"] & {
    readonly onActivity?: () => void
  }

interface MachineStdin extends RuntimeStdin {
  readonly isRaw?: boolean
}

export interface MachineDeps {
  readonly state: State
  readonly opts: MachineOpts
  readonly stdin: MachineStdin
  readonly stdout: { write(chunk: string): unknown }
  readonly promptCols: number
  readonly META_ROWS: number
  readonly metaText: { value: string | undefined }
  readonly pendingCtrlX: { value: boolean }
  readonly bracketedPasteOn: boolean
  /** Prior raw-mode flag to restore on cleanup. */
  readonly wasRaw: boolean
  /** Whether the caller skips `emitKeypressEvents` (test-IO seam). */
  readonly skipKeypressSetup: boolean
  refreshCandidates(): void
  enableBracketedPaste(): void
  disableBracketedPaste(): void
  resolve(value: string): void
  reject(err: Error): void
}

export interface ReaderMachine {
  readonly onKey: (str: string | undefined, key: KeyEvent | undefined) => void
  redraw(): void
  growBandToTarget(): void
  /** Settle-reject used by the abort-signal path (exposed for symmetry). */
  settleReject(err: Error): void
}

export const createReaderMachine = (deps: MachineDeps): ReaderMachine => {
  const {
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
    skipKeypressSetup,
    refreshCandidates,
    enableBracketedPaste,
    disableBracketedPaste,
    resolve,
    reject,
  } = deps

  const settled = { value: false }

  // ── render / scroll-band closures ─────────────────────────────────────────
  const renderCtx: RenderContext = { state, opts, stdout, promptCols, META_ROWS, metaText }
  const redraw = (): void => renderModule.redraw(renderCtx)
  const releaseBand = (): void => renderModule.releaseBand(renderCtx)
  const growBandToTarget = (): void =>
    renderModule.growBandTo(renderCtx, renderModule.targetReserved(renderCtx))
  const finalRenderForExit = (): void => renderModule.finalRenderForExit(renderCtx)

  // ── settle / cleanup lifecycle ────────────────────────────────────────────
  const cleanup = (): void => {
    stdin.removeListener("keypress", runtime.onKey)
    if (signalListener !== null) opts.signal?.removeEventListener("abort", signalListener)
    // #10 — bracketed-paste OFF before restoring raw-mode so the host terminal
    // is never left with `?2004h` latched.
    disableBracketedPaste()
    if (stdin.isTTY === true) stdin.setRawMode?.(wasRaw)
    stdin.pause()
  }
  const settleResolve = (value: string): void => {
    if (settled.value) return
    settled.value = true
    finalRenderForExit()
    cleanup()
    resolve(value)
  }
  const settleReject = (err: Error): void => {
    if (settled.value) return
    settled.value = true
    finalRenderForExit()
    cleanup()
    reject(err)
  }

  const signalListener: (() => void) | null = opts.signal
    ? () => settleReject(new AbortError())
    : null
  if (opts.signal && signalListener !== null) {
    if (opts.signal.aborted) {
      queueMicrotask(() => settleReject(new AbortError()))
    } else {
      opts.signal.addEventListener("abort", signalListener, { once: true })
    }
  }

  // ── impure interaction closures (buffer splice + @-dropdown + editor) ─────
  const runtime: ReaderRuntime = {
    state,
    opts,
    stdin,
    stdout,
    settled,
    refreshCandidates,
    redraw,
    releaseBand,
    growBandToTarget,
    disableBracketedPaste,
    enableBracketedPaste,
    emitKeypress: () => {
      if (!skipKeypressSetup) {
        readline.emitKeypressEvents(stdin as unknown as NodeJS.ReadStream)
      }
    },
    onKey: (str, key) => onKey(str, key as KeyEvent | undefined),
  }
  const acceptGhost = (): boolean => interactions.acceptGhost(runtime)
  const commitSelected = (): boolean => interactions.commitSelected(runtime)
  const commitAtSelected = (): boolean => interactions.commitAtSelected(runtime)
  const openAtDropdown = (triggerPos: number): void =>
    interactions.openAtDropdown(runtime, triggerPos)
  const runAtList = (): Promise<void> => interactions.runAtList(runtime)
  const runExternalEdit = (): Promise<void> => interactions.runExternalEdit(runtime)

  // ── keypress dispatch adapter ─────────────────────────────────────────────
  const keyContextBase: KeyContextBase = {
    state,
    opts,
    metaText,
    pendingCtrlX,
    bracketedPasteOn,
    refreshCandidates,
    redraw,
    settleResolve,
    settleReject,
    acceptGhost,
    commitSelected,
    commitAtSelected,
    openAtDropdown,
    runAtList: () => {
      void runAtList()
    },
    runExternalEdit: () => {
      void runExternalEdit()
    },
  }
  const onKey = (str: string | undefined, key: KeyEvent | undefined): void => {
    if (settled.value) return
    try {
      opts.onActivity?.()
    } catch {
      // Activity observation must never make terminal input unusable.
    }
    dispatchKey(makeKeyContext(keyContextBase, str, key))
  }

  return { onKey: runtime.onKey, redraw, growBandToTarget, settleReject }
}
