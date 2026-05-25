/**
 * Composer-edit adapter (ADR-0291 — REPL slash-surface ctx mega-wire).
 *
 * Owns a surface-scoped mutable pending-text holder. `/edit-message`
 * reads `getPending()` to seed the $EDITOR temp file and writes back
 * through `setPending(body)`. The REPL composer (raw-line-reader) drains
 * the holder on the next `PromptSource.next()` call. Default-OFF when
 * the host omits the slot — `/edit-message` prints "not wired". No-throw.
 */

import type { ComposerEditPort } from "../../edit-message-cmd"

export interface ComposerHandle {
  /** Current pending composer text (may be empty string). */
  readonly getPending: () => string
  /** Replace the pending composer text. */
  readonly setPending: (body: string) => void
}

export interface ComposerEditAdapter extends ComposerEditPort {}

/** Build the adapter over a surface-owned mutable text holder. The
 *  surface (REPL) owns the truth: this adapter is a thin façade so the
 *  slash command never imports raw-line-reader. */
export const buildComposerEditAdapter = (handle: ComposerHandle): ComposerEditAdapter => ({
  getPending: (): string => handle.getPending(),
  setPending: (body: string): void => {
    handle.setPending(body)
  },
})

/** Build a fresh in-memory holder. Caller injects this into the REPL
 *  surface composition; one instance per process. */
export const createComposerHandle = (initial = ""): ComposerHandle => {
  let pending = initial
  return {
    getPending: (): string => pending,
    setPending: (body: string): void => {
      pending = body
    },
  }
}
