/**
 * Browser tool — per-session handle holder (ADR-0427, strengthen #5).
 *
 * Tools are stateless functions, but a browser is a single long-lived stateful
 * resource. This holder owns ONE lazily-spawned handle for the session: the
 * first `browser_*` call spawns it, subsequent calls reuse it, and session
 * teardown `dispose()`s it (kills the proc + removes the temp profile). Concurrent
 * `ensure()` calls coalesce onto a single spawn (defensive — tools are
 * `isConcurrencySafe:false` so they already serialize, but the holder must not
 * spawn twice on a race).
 */

import type { BrowserError, BrowserHandle, BrowserPort } from "@/browser"
import { err, ok, type Result } from "@/shared"

export interface BrowserSession {
  /** Return the live handle, spawning it on first use. */
  ensure(signal?: AbortSignal): Promise<Result<BrowserHandle, BrowserError>>
  /** Close the handle (idempotent). Registered into session teardown. */
  dispose(): Promise<void>
}

export const createBrowserSession = (port: BrowserPort): BrowserSession => {
  let handle: BrowserHandle | null = null
  let spawning: Promise<Result<BrowserHandle, BrowserError>> | null = null
  let disposed = false
  let pendingClose: Promise<unknown> | null = null

  return {
    async ensure(signal?: AbortSignal): Promise<Result<BrowserHandle, BrowserError>> {
      if (disposed) return err({ kind: "closed" })
      if (handle !== null) return ok(handle)
      if (spawning !== null) return spawning
      spawning = port
        .spawn(signal ? { signal } : undefined)
        .then((r) => {
          if (!r.ok) return r
          // R2 audit [1]: if dispose() raced the spawn, close the freshly-spawned
          // handle here instead of storing it — otherwise teardown (already past)
          // never closes it and the real Chrome proc + temp profile leak.
          // R3 audit [1][2]: capture the close promise (caught, so a throwing close
          // is NOT an unhandled rejection) so dispose() can AWAIT it — without this
          // dispose returned before the close completed and a rejecting close
          // escaped the no-throw seam.
          if (disposed) {
            pendingClose = port.close(r.value).catch(() => {})
            return err({ kind: "closed" })
          }
          handle = r.value
          return r
        })
        // No-throw seam: a misbehaving adapter that REJECTS (despite the contract)
        // becomes an Err so `ensure` never rejects, and `.finally` clears the latch
        // so a later call retries instead of dead-locking (R1 audit [5]).
        .catch(
          (e): Result<BrowserHandle, BrowserError> =>
            err({ kind: "spawn-failed", detail: e instanceof Error ? e.message : String(e) }),
        )
        .finally(() => {
          spawning = null
        })
      return spawning
    },

    async dispose(): Promise<void> {
      disposed = true
      // Wait out an in-flight spawn AND the self-close it may have started, so the
      // freshly-spawned handle is genuinely closed by the time dispose() returns
      // (R2 audit [1] + R3 audit [2]).
      if (spawning !== null) await spawning
      if (pendingClose !== null) await pendingClose
      if (handle === null) return
      const h = handle
      handle = null
      await port.close(h)
    },
  }
}
