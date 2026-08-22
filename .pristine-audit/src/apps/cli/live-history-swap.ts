/**
 * ONE live-history-swap seam (jul-10 UI/UX WS-D §3 — UUX-4-02 / UUX-6-03).
 *
 * Root cause: three session-rewind surfaces each owned (or forgot) their own
 * "push the restored transcript into the live REPL history" step:
 *
 *   - `/rewind-conv` did it right (`slot.replaceMessages(restored)`),
 *   - `/rewind` truncated the session ON DISK and left the in-memory history
 *     stale until restart (false success — the next turn still saw the
 *     dropped messages),
 *   - `/rewind-tool`'s task leg received `messagesAfter` in the outcome and
 *     only PRINTED it.
 *
 * This module is the single seam all three call. The surface (REPL
 * composition root) installs ONE swap closure — the same
 * `registerReplaceMessages` wire the loop binds to `session.transcript.replace`
 * + the surface-state history — and every rewind-family command routes its
 * restored message list through {@link applyLiveHistorySwap}.
 *
 * Contract:
 *   - A slot with no `replaceMessages` (non-REPL surface, legacy shape) or an
 *     absent message list ⇒ NO swap, returns `false`. Callers keep their
 *     prior behavior byte-identical for surfaces that never wired the hook.
 *   - A rejection from the swap closure PROPAGATES — the caller decides how
 *     to fail loud (the commands print an honest disk-vs-live note and exit
 *     1 instead of printing success copy for a half-applied effect).
 *   - Success copy must only be printed AFTER the swap resolves (effect
 *     receipt discipline — WS-D root cause).
 *
 * Also hosts the shared destructive-confirm copy the rewind family renders
 * (`/rewind` already shipped it; `/rewind-conv` adopts it for UUX-6-09), so
 * the highlight styling + the `--yes` hint have one decision site.
 */

import type { Message } from "@/llm"

/** Structural slot: anything carrying an (optional) live-history swap hook.
 *  `RewindSlashState`, `ConvCheckpointSlashState` and
 *  `PerToolCheckpointSlashState` all satisfy this shape. */
export interface LiveHistorySlot {
  readonly replaceMessages?: ((msgs: ReadonlyArray<Message>) => Promise<void>) | undefined
}

/**
 * Apply the live-history swap when both a hook and a message list are
 * present. Returns `true` iff the swap actually ran (the caller's success
 * copy may then honestly claim the live conversation was updated).
 *
 * NEVER swallows a rejection — a failing swap is the caller's signal that
 * the live surface and the on-disk effect have diverged.
 */
export const applyLiveHistorySwap = async (
  slot: LiveHistorySlot | undefined,
  messages: ReadonlyArray<Message> | undefined,
): Promise<boolean> => {
  const swap = slot?.replaceMessages
  if (swap === undefined || messages === undefined) return false
  await swap(messages)
  return true
}

/* ------------------------------------------------------------------ */
/* shared destructive-confirm copy                                     */
/* ------------------------------------------------------------------ */

const ESC = "\x1b"
/** ANSI bold-red — highlights the destructive verb in a confirm line so a
 *  TTY surface makes the dangerous bit pop; non-TTY surfaces see the literal
 *  escape (same posture as `/rewind`'s original confirm line). */
export const BOLD_RED = `${ESC}[1;31m`
export const RESET = `${ESC}[0m`

/** The one `--yes` re-run hint line the rewind family prints under its
 *  confirm/preview copy. Byte-identical to the line `/rewind` shipped. */
export const confirmYesHint = (): string => "  re-run with --yes to confirm.\n"
