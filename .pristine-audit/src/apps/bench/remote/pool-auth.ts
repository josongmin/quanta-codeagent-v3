/**
 * Multi-Auth Fleet (jun-20) — T-3 pool ↔ lease-manager bridge.
 *
 * The pool worker shouldn't know about manifests or cooldown math; it only needs
 * to "get credentials for this chunk, ship them, report how it went". This seam
 * is that narrow contract. The single-account path does NOT use it (it keeps the
 * legacy `authJsonProvider`), so its behavior stays byte-identical.
 */
import type { AuthLeaseManager } from "../auth-pool"

/** Per-chunk credential grant. `readAuthJson` reads the leased account's token
 *  file FRESH at ship time (a long run never grades on a stale access_token). */
export interface PoolAuthLease {
  readonly accountLabel: string
  readAuthJson(): string
  release(result: { rateLimited: boolean; lostBox: boolean; completed: boolean }): void
}

export interface PoolAuthAcquireRequest {
  readonly runId: string
  readonly requestedSlots: number
  /** Soft affinity — prefer the account this worker's warm box already holds. */
  readonly preferredAccountLabel?: string
}

export interface PoolAuthProvider {
  /** null = no account can take work right now (all saturated or cooling). */
  acquire(req: PoolAuthAcquireRequest): PoolAuthLease | null
  /** False only when EVERY account is disabled ⇒ the chunk can never run. */
  canEventuallySchedule(): boolean
  /** Soonest epoch-ms a cooling account frees up, for wait sizing. */
  nextReadyAt(): number | undefined
}

/**
 * Wrap an {@link AuthLeaseManager} as a pool provider. `readAuthFile` is injected
 * so tests stay off-disk and the manager never touches token bytes itself.
 */
export const createLeasePoolAuthProvider = (
  manager: AuthLeaseManager,
  readAuthFile: (path: string) => string,
): PoolAuthProvider => ({
  acquire: (req) => {
    const lease = manager.acquire({
      runId: req.runId,
      requestedSlots: req.requestedSlots,
      ...(req.preferredAccountLabel !== undefined
        ? { preferredAccountLabel: req.preferredAccountLabel }
        : {}),
    })
    if (lease === null) return null
    return {
      accountLabel: lease.accountLabel,
      readAuthJson: () => readAuthFile(lease.authFile),
      release: (result) => lease.release(result),
    }
  },
  canEventuallySchedule: () => manager.snapshot().some((s) => !s.disabled),
  nextReadyAt: () => manager.nextReadyAt(),
})
