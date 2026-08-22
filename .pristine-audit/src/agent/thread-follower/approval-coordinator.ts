/**
 * Follower approval-relay TIMEOUT coordinator (T02 — the LIVE timeout discipline).
 *
 * This is the production home of T02's "each verb is request/response/**timeout**"
 * for the APPROVAL RELAY. The host mints a pending approval (the REQUEST); a
 * follower client relays an approve/deny (the RESPONSE); if no response lands
 * within the deadline the coordinator fires the DEFINED fallback (a fail-safe
 * DENY) and a late response is STALE — dropped, never applied (the stale-decision
 * hazard the audit calls out).
 *
 * It owns a {@link FollowerVerbTracker} (the tested timing core) + an injected
 * `respond` sink (the web daemon binds it to `session.approval.respond`, which
 * routes through the kernel `approval.respond` command → the host resolver whose
 * LIVE HARD_DENY re-check is the security guard). The clock is injected (the app
 * passes `Date.now`; the core never reads wall-clock) so the discipline is
 * deterministic / testable.
 *
 * DISABLED MODE: `timeoutMs <= 0` ⇒ pure PASS-THROUGH — {@link open} is a no-op,
 * {@link relay} responds immediately (no deadline), {@link sweep} does nothing.
 * This is the byte-identical "no follower timeout" behavior (the prior web path,
 * where approvals rode `approval.respond` directly). The deadline is opt-in via
 * `QUANTA_FOLLOWER_APPROVAL_TIMEOUT_MS`.
 *
 * SAFE-ON-UNTRACKED: with the deadline enabled, {@link relay} for an approval the
 * coordinator never `open`ed (e.g. the `approval.requested` event was missed)
 * still responds (pass-through) rather than dropping a legitimate decision — only
 * a verb that was tracked AND expired (`timed_out`), or already resolved, is
 * dropped.
 */
import { FollowerVerbTracker } from "./timeout"
import type { FollowerApprovalDecision } from "./types"

/** Sink the coordinator drives to actually apply a decision. The daemon binds
 *  this to `session.approval.respond` (→ kernel `approval.respond` → host
 *  resolver with the live HARD_DENY re-check). NO-THROW expected. */
export type FollowerApprovalResponder = (
  approvalId: string,
  decision: FollowerApprovalDecision,
  steer?: string,
) => void

export interface FollowerApprovalCoordinatorDeps {
  readonly respond: FollowerApprovalResponder
  /** Injected wall-clock ms (the app passes `Date.now`; core never reads it). */
  readonly now: () => number
  /** Deadline window in ms. `<= 0` (or non-finite) ⇒ DISABLED (pass-through). */
  readonly timeoutMs: number
  /** Injected tracker (test seam); defaults to a fresh instance. */
  readonly tracker?: FollowerVerbTracker
}

export type FollowerRelayResult =
  /** The decision was forwarded to the resolver. */
  | { readonly kind: "applied" }
  /** STALE — the deadline passed (the fallback already denied) ⇒ dropped. */
  | { readonly kind: "stale"; readonly reason: "timed_out" | "already_resolved" }

/** An approval whose deadline passed without a relay (surfaced by {@link sweep}). */
export interface FollowerApprovalTimeout {
  readonly approvalId: string
  readonly fallback: "deny"
}

export interface FollowerApprovalCoordinator {
  /** Register a freshly-minted pending approval as an outstanding REQUEST with a
   *  deadline `now()+timeoutMs`. No-op (returns false) when disabled. Idempotent
   *  on `approvalId` (a retransmit cannot extend the deadline). */
  open(approvalId: string): boolean
  /** Relay a follower's approve/deny. Applied only if in time (or untracked);
   *  a tracked-and-expired / already-resolved relay is STALE and dropped. */
  relay(approvalId: string, decision: FollowerApprovalDecision, steer?: string): FollowerRelayResult
  /** Fire the fail-safe DENY fallback for every approval whose deadline passed.
   *  Returns the timed-out approvals. No-op when disabled. */
  sweep(): readonly FollowerApprovalTimeout[]
  /** Mark an approval resolved by ANOTHER path (the local operator answered via
   *  `approval.respond`) so a later follower relay is stale + sweep won't fire a
   *  fallback for it. */
  close(approvalId: string): void
  /** Outstanding (not-yet-resolved/timed-out) approvals — observability. */
  pending(): number
  /** Evict terminal (resolved/timed-out) entries so the tracker map stays bounded
   *  over a long-lived daemon. SAFE to prune aggressively: a follower relay for a
   *  pruned approval falls through to `respond`, and the kernel reducer rejects a
   *  double-resolve (the approval is already gone) — so a pruned-then-late relay
   *  can never re-open a closed decision. Returns the count dropped. */
  prune(): number
}

const isEnabled = (timeoutMs: number): boolean => Number.isFinite(timeoutMs) && timeoutMs > 0

/** A placeholder verb stored with each tracked approval; its only role is to ride
 *  the tracker's generic envelope (the coordinator carries the decision itself). */
const PLACEHOLDER = (approvalId: string) =>
  ({ kind: "command-approval-decision", approvalId, decision: "deny" }) as const

export const createFollowerApprovalCoordinator = (
  deps: FollowerApprovalCoordinatorDeps,
): FollowerApprovalCoordinator => {
  const tracker = deps.tracker ?? new FollowerVerbTracker()
  const enabled = isEnabled(deps.timeoutMs)

  return {
    open(approvalId: string): boolean {
      if (!enabled) return false
      const now = deps.now()
      return tracker.register({
        verbId: approvalId,
        issuedAt: now,
        deadlineAt: now + deps.timeoutMs,
        verb: PLACEHOLDER(approvalId),
      })
    },

    relay(approvalId, decision, steer): FollowerRelayResult {
      if (!enabled) {
        deps.respond(approvalId, decision, steer)
        return { kind: "applied" }
      }
      const r = tracker.resolve(approvalId, deps.now())
      if (r.kind === "stale") {
        // `timed_out` / `already_resolved` ⇒ the decision is genuinely stale —
        // DROP it (the fallback owns the outcome). `unknown_verb` means we never
        // tracked this approval (a missed `open`) ⇒ do NOT lose a legitimate
        // decision: respond pass-through.
        if (r.reason === "unknown_verb") {
          deps.respond(approvalId, decision, steer)
          return { kind: "applied" }
        }
        return { kind: "stale", reason: r.reason }
      }
      deps.respond(approvalId, decision, steer)
      return { kind: "applied" }
    },

    sweep(): readonly FollowerApprovalTimeout[] {
      if (!enabled) return []
      const out: FollowerApprovalTimeout[] = []
      for (const timedOut of tracker.sweep(deps.now())) {
        deps.respond(timedOut.verbId, "deny")
        out.push({ approvalId: timedOut.verbId, fallback: "deny" })
      }
      return out
    },

    close(approvalId: string): void {
      if (!enabled) return
      // Mark resolved (result ignored): sweep skips it, a later relay is stale.
      tracker.resolve(approvalId, deps.now())
    },

    pending(): number {
      return tracker.pendingCount()
    },

    prune(): number {
      return tracker.prune()
    },
  }
}
