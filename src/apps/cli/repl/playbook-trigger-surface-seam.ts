/**
 * `apps/cli/repl/playbook-trigger-surface-seam.ts` — ADR-0293 seam.
 *
 * WHY: keeps the CLI session-lifecycle wire (which lives in `session-
 * bootstrap.ts` / `session-loop.ts`, currently in-flight on a parallel
 * track) out of THIS slice. The session-bootstrap host calls
 * `seam.attach(handle)` once the {@link maybeStartPlaybookTriggerWire} call
 * resolves; session-loop calls `seam.detach()` on finish (which stops the
 * handle). A follow-up PR wires the two call-sites; until then this seam
 * stands alone and is fully testable.
 *
 * Default-OFF: an unattached seam never allocates a handle. `detach()` on
 * a never-attached seam is a no-op. `current()` returns `null` until an
 * attach occurs.
 *
 * Slice posture: leaf-level. Imports ONLY the handle type from the local
 * wire helper.
 */

import type { PlaybookTriggerWireHandle } from "./playbook-trigger-wire"

/** Surface-composition seam. The host calls `attach` once at session start
 *  and `detach` once at session finish. The seam owns NO state besides the
 *  current handle reference. */
export interface PlaybookTriggerSurfaceSeam {
  /** Register the handle. If a previous handle is still attached, it is
   *  STOPPED first (the seam guarantees at most one live handle). */
  readonly attach: (handle: PlaybookTriggerWireHandle) => void
  /** Stop the current handle (if any) and clear the slot. Idempotent. */
  readonly detach: () => void
  /** Return the currently attached handle or `null`. */
  readonly current: () => PlaybookTriggerWireHandle | null
}

/** Factory — each call yields a fresh seam with its own internal state.
 *  No singletons; the composition root owns the seam's lifetime. */
export const createPlaybookTriggerSurfaceSeam = (): PlaybookTriggerSurfaceSeam => {
  let handle: PlaybookTriggerWireHandle | null = null
  return {
    attach: (next) => {
      if (handle !== null) {
        try {
          handle.stop()
        } catch {
          /* a misbehaving prior handle MUST not block attach */
        }
      }
      handle = next
    },
    detach: () => {
      if (handle === null) return
      const prev = handle
      handle = null
      try {
        prev.stop()
      } catch {
        /* idempotent — detach must always clear the slot */
      }
    },
    current: () => handle,
  }
}
