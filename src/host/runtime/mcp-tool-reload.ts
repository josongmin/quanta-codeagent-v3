/**
 * MCP tool hot-reload controller (RFC-04 / RFC04-2 + RFC04-3).
 *
 * OWNERSHIP
 * ─────────
 * This is a host APPLICATION SERVICE that ORDERS a reload: single-flight +
 * dirty replay + compare-and-publish + last-known-good retention. It owns NO
 * tool/collision/trust logic — the `rebuild` port re-runs the SAME connect-time
 * assembly (all-source relist → disambiguate → registry build → snapshot) so
 * connect and reload can never produce different tool-name/collision/trust
 * results. The controller only decides WHEN a rebuilt snapshot replaces the
 * prior one, never HOW tools are converted.
 *
 * TRANSACTIONAL PUBLISH (RFC04-3)
 * ───────────────────────────────
 *  - A rebuild that THROWS (relist error, malformed page, validate failure)
 *    keeps the PRIOR snapshot — never a partial/empty publish. Fail-closed to
 *    last-known-good.
 *  - A rebuild whose fingerprint EQUALS the current snapshot's is a no-op
 *    (nothing observably changed) — no publish, no generation churn.
 *  - Only a fully-built snapshot with a CHANGED fingerprint is published, via
 *    the atomic pointer swap. The swap takes effect for the NEXT turn; a turn
 *    that already pinned `current()` keeps its generation.
 *
 * COALESCING (RFC04-2)
 * ────────────────────
 * A burst of invalidation signals is bounded to at most ONE in-flight rebuild
 * plus ONE queued "dirty" replay: signals that arrive while a rebuild runs set
 * a dirty bit rather than spawning parallel rebuilds; exactly one replay runs
 * after the in-flight completes, regardless of how many signals arrived. Fixed
 * one-inflight+dirty rule — NO timer/debounce/backoff heuristic.
 */

import type { TurnRegistrySnapshot } from "@/agent/turn-registry-snapshot"
import { errMessage, logger } from "@/shared"

/** Structural diagnostic sink for reload lifecycle. No-throw by contract; the
 *  controller guards each call so a hostile sink never breaks the reload. All
 *  fields optional so absent = byte-identical (no diagnostics). */
export interface McpReloadDiagnostics {
  /** A fully-validated, fingerprint-CHANGED snapshot was published. */
  onPublished?(info: { readonly from: number; readonly to: number }): void
  /** A rebuild succeeded but the fingerprint was unchanged ⇒ no publish. */
  onNoChange?(info: { readonly generation: number }): void
  /** A rebuild threw ⇒ prior snapshot retained (last-known-good). */
  onAbort?(info: { readonly generation: number; readonly error: string }): void
}

/** The reusable connect-time assembly, re-run on reload. Returns a fresh
 *  immutable snapshot built from an ALL-SOURCE relist (full pagination handled
 *  inside the same `listTools`/disambiguate/registry path connect uses). MUST
 *  reject on any relist/validate failure so the controller retains LKG. */
export type RebuildSnapshotPort = () => Promise<TurnRegistrySnapshot>

/** Publish handle over the atomic snapshot pointer (from
 *  `createTurnRegistrySnapshotRef`). The controller is the ONLY holder. */
export interface SnapshotPublisher {
  current(): TurnRegistrySnapshot
  publish(next: TurnRegistrySnapshot): void
}

export interface McpToolReloadController {
  /** Signal that a live source's tool list changed (already capability-gated by
   *  the client). Coalesces into the single-flight+dirty rule and resolves when
   *  the reload triggered by THIS signal (or the replay covering it) settles. */
  requestReload(): Promise<void>
  /** True while a rebuild is in flight (test/observability). */
  isReloading(): boolean
}

/**
 * Create the reload controller over a snapshot publisher and a rebuild port.
 * `diagnostics` is optional (absent ⇒ silent, byte-identical).
 */
export const createMcpToolReloadController = (
  publisher: SnapshotPublisher,
  rebuild: RebuildSnapshotPort,
  diagnostics?: McpReloadDiagnostics,
): McpToolReloadController => {
  let inFlight: Promise<void> | null = null
  let dirty = false

  const emit = <K extends keyof McpReloadDiagnostics>(
    key: K,
    arg: Parameters<NonNullable<McpReloadDiagnostics[K]>>[0],
  ): void => {
    const fn = diagnostics?.[key]
    if (fn === undefined) return
    try {
      ;(fn as (a: unknown) => void)(arg)
    } catch (e) {
      logger.warn(`mcp reload: diagnostics ${String(key)} threw: ${errMessage(e)}`)
    }
  }

  /** One rebuild attempt: relist+build, then compare-and-publish. Never throws
   *  — a rebuild failure keeps the prior snapshot (LKG) and emits `onAbort`. */
  const runOnce = async (): Promise<void> => {
    const base = publisher.current()
    let next: TurnRegistrySnapshot
    try {
      next = await rebuild()
    } catch (e) {
      // Transactional abort: retain the prior snapshot, never clear-then-fail.
      emit("onAbort", { generation: base.id, error: errMessage(e) })
      return
    }
    // Compare-and-publish: a stale/older rebuild whose surface equals the
    // CURRENT (which may have advanced while we were rebuilding) is a no-op.
    const currentNow = publisher.current()
    if (next.fingerprint === currentNow.fingerprint) {
      emit("onNoChange", { generation: currentNow.id })
      return
    }
    publisher.publish(next)
    emit("onPublished", { from: currentNow.id, to: next.id })
  }

  /** Drain loop: run one rebuild; if signals arrived during it (dirty), run
   *  exactly one more, and so on until no dirty bit remains. Bounds a burst to
   *  one in-flight + one pending replay at any instant. */
  const drain = async (): Promise<void> => {
    for (;;) {
      await runOnce()
      if (!dirty) break
      dirty = false
    }
  }

  return {
    requestReload: async () => {
      if (inFlight !== null) {
        // A rebuild is already running: mark dirty so exactly one replay runs
        // after it, and await the SAME in-flight chain (no parallel rebuild).
        dirty = true
        await inFlight
        return
      }
      const run = drain().finally(() => {
        inFlight = null
      })
      inFlight = run
      await run
    },
    isReloading: () => inFlight !== null,
  }
}
