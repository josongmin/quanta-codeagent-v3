/**
 * `@/apps/web-daemon/server/follower-approval` — T02 follower approval-relay
 * TIMEOUT coordinator wiring.
 *
 * Extracted from `startWebDaemon` startup. The coordinator is present iff the
 * follower co-control gate minted a dispatcher; `respond` routes a follower's
 * decision through the SAME `approval.respond` command a local client uses (→
 * the host resolver's LIVE HARD_DENY re-check). The deadline is OPT-IN via
 * `QUANTA_FOLLOWER_APPROVAL_TIMEOUT_MS` (0/unset ⇒ pass-through, byte-identical):
 * when set, an unanswered approval times out to a fail-safe DENY and a late
 * follower relay is dropped. The sweep timer + the requested/resolved
 * subscription run only when the deadline is enabled.
 */

import { createFollowerApprovalCoordinator } from "@/agent/thread-follower"
import type { RuntimeSession } from "@/sdk/runtime"
import { errMessage, logger } from "@/shared"
import type { WebDaemonServerConfig } from "../server"

type FollowerApprovalCoordinator = ReturnType<typeof createFollowerApprovalCoordinator>

export interface FollowerApprovalWiring {
  readonly followerApproval: FollowerApprovalCoordinator | undefined
  readonly followerApprovalUnsub: (() => void) | null
  readonly followerSweepTimer: ReturnType<typeof setInterval> | null
}

/** Parse QUANTA_FOLLOWER_APPROVAL_TIMEOUT_MS — the ms deadline for a follower to
 *  respond to a pending approval. 0 / unset / invalid ⇒ 0 (DISABLED ⇒ the
 *  coordinator passes relays straight through, byte-identical to no timeout). */
export const parseFollowerApprovalTimeoutMs = (raw: string | undefined): number => {
  if (raw === undefined) return 0
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : 0
}

export const setupFollowerApproval = (
  config: Pick<WebDaemonServerConfig, "followerCoControl">,
  sharedSession: RuntimeSession,
): FollowerApprovalWiring => {
  const followerApprovalTimeoutMs = parseFollowerApprovalTimeoutMs(
    process.env.QUANTA_FOLLOWER_APPROVAL_TIMEOUT_MS,
  )
  const followerApproval =
    config.followerCoControl !== undefined
      ? createFollowerApprovalCoordinator({
          respond: (id, decision, steer) => {
            void sharedSession.approval
              .respond(id, decision, steer !== undefined ? { steer } : undefined)
              .catch((error) =>
                logger.warn("web-daemon: follower approval respond failed", {
                  error: errMessage(error),
                }),
              )
          },
          now: () => Date.now(),
          timeoutMs: followerApprovalTimeoutMs,
        })
      : undefined
  let followerApprovalUnsub: (() => void) | null = null
  let followerSweepTimer: ReturnType<typeof setInterval> | null = null
  if (followerApproval !== undefined && followerApprovalTimeoutMs > 0) {
    followerApprovalUnsub = sharedSession.subscribe((event) => {
      if (event.type === "approval.requested") followerApproval.open(event.approval.approvalId)
      else if (event.type === "approval.resolved") followerApproval.close(event.approvalId)
    })
    // Sweep at ~quarter-deadline granularity (min 250ms) so a timed-out approval
    // is denied promptly. `unref` so the timer never keeps the process alive.
    followerSweepTimer = setInterval(
      () => {
        followerApproval.sweep()
        // Evict terminal entries each tick so the tracker map stays bounded on a
        // long-lived shared-session daemon (the kernel reducer guards a late
        // pruned-relay double-resolve, so aggressive prune is safe).
        followerApproval.prune()
      },
      Math.max(250, Math.floor(followerApprovalTimeoutMs / 4)),
    )
    followerSweepTimer.unref?.()
  }
  return { followerApproval, followerApprovalUnsub, followerSweepTimer }
}
