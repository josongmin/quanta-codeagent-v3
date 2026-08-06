/**
 * UUX-4-07 — the surface-side session-switch wire.
 *
 * Mirrors the `setReplaceMessages` late-install pattern in `surface-compose`:
 * the surface builds this wire at compose time (before the loop exists), the
 * loop installs the real switch closure (`performSessionSwitch` bound to its
 * live session) via {@link SessionSwitchWire.setSwitchSession}, and `/fork`
 * consumes {@link SessionSwitchWire.switchSession} off `RewindSlashState`.
 *
 * Unlike the history-swap adapter this wire NEVER swallows a rejection —
 * `/fork` must fail loud (exit 1, honest disk-vs-live copy) when the switch
 * cannot run (mid-turn `transcript_replace_unavailable`, missing fork, …).
 *
 * The wire also owns the LIVE session id the rewind-family commands address:
 * after a successful switch, `/rewind` / `/fork` must target the FORK, not
 * the boot-time parent — `sessionId()` is threaded as a getter onto the
 * `rewindState` overlay so the slash context can never go stale.
 */

import type { Message } from "@/llm"
import type { RestoreFilesCoordinatorPort, RewindSlashState } from "../rewind-cmd"
import type { SessionSwitchReceipt } from "./session-loop/session-switch"

export interface SessionSwitchWire {
  /** Loop-installed switch. Rejections PROPAGATE (fail-loud contract). */
  readonly switchSession: (sessionId: string) => Promise<SessionSwitchReceipt>
  /** Late-install slot for the loop (mirrors `setReplaceMessages`). */
  readonly setSwitchSession: (fn: (sessionId: string) => Promise<SessionSwitchReceipt>) => void
  /** The CURRENT live session id — advances only after a resolved switch. */
  readonly sessionId: () => string
}

/** Overlay the live seams onto the boot-time rewind state for the slash ctx:
 *  the UUX-4-02 history swap, the UUX-4-07 switch, and a LIVE `sessionId`
 *  getter — after `/fork` switches onto the fork, every later rewind-family
 *  command must address the fork, never the boot-time parent (stale-id
 *  honesty). Extracted from `surface-compose` for its module-size budget. */
export const overlayRewindState = (
  base: RewindSlashState,
  replaceMessages: (msgs: ReadonlyArray<Message>) => Promise<void>,
  wire: SessionSwitchWire,
  restoreFilesCoordinator?: RestoreFilesCoordinatorPort,
): RewindSlashState => ({
  ...base,
  replaceMessages,
  switchSession: wire.switchSession,
  // RFC-def Surface B — thread the durable restore coordinator (gated). Absent ⇒
  // `--restore-files` keeps its safe-degrade byte-identical.
  ...(restoreFilesCoordinator !== undefined ? { restoreFilesCoordinator } : {}),
  get sessionId() {
    return wire.sessionId()
  },
})

export const createSessionSwitchWire = (initialSessionId: string): SessionSwitchWire => {
  let installed: ((sessionId: string) => Promise<SessionSwitchReceipt>) | undefined
  let liveSessionId = initialSessionId
  return {
    switchSession: async (sessionId: string): Promise<SessionSwitchReceipt> => {
      if (installed === undefined) {
        throw new Error("session switch not installed yet (loop still starting)")
      }
      const receipt = await installed(sessionId)
      // Only a RESOLVED switch advances the live id — a rejection above leaves
      // the rewind-family commands addressing the unchanged parent.
      liveSessionId = sessionId
      return receipt
    },
    setSwitchSession: (fn) => {
      installed = fn
    },
    sessionId: () => liveSessionId,
  }
}
