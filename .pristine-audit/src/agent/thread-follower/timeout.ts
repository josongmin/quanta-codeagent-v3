/**
 * Follower verb timeout / STALE-DECISION discipline (T02).
 *
 * Every Codex follower verb is a request/response/**timeout** triple. The danger
 * a follower introduces over a local operator: a follower can go SILENT. If a
 * relayed approval (or any steering verb) has no response within its deadline,
 * the host must apply a DEFINED fallback (e.g. the local operator decides, or a
 * conservative default fires) — and crucially, a follower response that arrives
 * AFTER the deadline must NOT be applied. A late `approve` landing after the
 * fallback already denied would re-open a closed decision (a TOCTOU on the
 * approval boundary). That is the "stale-decision relay" hazard the audit calls
 * out, and this tracker is the structural guard.
 *
 * Contract (deadline is INCLUSIVE — a response AT the deadline still applies):
 *   - alive while `now <= deadlineAt`        → {@link resolve} returns `apply`.
 *   - swept once `now > deadlineAt`          → marked `timed_out`; the fallback
 *                                              fires; a later {@link resolve}
 *                                              returns `stale: timed_out`.
 *   - {@link resolve} on a still-pending verb past its deadline ALSO times it out
 *     in place (a late response is never silently applied even if `sweep` has
 *     not run yet).
 *   - second {@link resolve} of an already-applied verb → `stale: already_resolved`.
 *   - {@link resolve} of an unregistered verbId → `stale: unknown_verb`.
 *
 * PURE: the clock is injected on every call (no `Date.now()`), so the machine is
 * fully deterministic / replay-safe — same as `routeInbound` / `steer`.
 */
import type { FollowerVerb } from "./types"

/** A follower verb stamped with its issue time + deadline. The transport assigns
 *  `verbId` (a correlation id) and `deadlineAt = issuedAt + timeoutMs`. */
export interface FollowerVerbEnvelope {
  readonly verbId: string
  readonly issuedAt: number
  readonly deadlineAt: number
  readonly verb: FollowerVerb
}

/** Outcome of {@link FollowerVerbTracker.resolve}. */
export type ResolveOutcome =
  /** The response landed in time — the host applies `verb`'s effect. */
  | { readonly kind: "apply"; readonly verb: FollowerVerb }
  /** The response is STALE and must NOT be applied. `reason` tells WHY:
   *   - `timed_out`        — the deadline passed (fallback fired / fires now).
   *   - `already_resolved` — the verb was already applied once (replay/dupe).
   *   - `unknown_verb`     — no such verbId was registered. */
  | { readonly kind: "stale"; readonly reason: StaleReason }

export type StaleReason = "timed_out" | "already_resolved" | "unknown_verb"

/** A verb that timed out — surfaced by {@link FollowerVerbTracker.sweep} so the
 *  host can fire the DEFINED fallback for it. */
export interface TimedOutVerb {
  readonly verbId: string
  readonly verb: FollowerVerb
}

type Status = "pending" | "resolved" | "timed_out"

interface Entry {
  readonly envelope: FollowerVerbEnvelope
  status: Status
}

/**
 * In-memory tracker of outstanding follower verbs. ONE instance per live thread.
 * Not pure (it holds the pending set) but every method takes the clock in — the
 * tracker never reads wall-clock itself. NO-THROW on every public method.
 */
export class FollowerVerbTracker {
  readonly #entries = new Map<string, Entry>()

  /**
   * Register an outstanding verb. Idempotent on `verbId`: a duplicate id is
   * IGNORED (returns `false`) so a transport retransmit cannot reset a verb's
   * deadline or resurrect a timed-out one. Returns `true` when newly registered.
   */
  register(envelope: FollowerVerbEnvelope): boolean {
    if (
      envelope === null ||
      typeof envelope !== "object" ||
      typeof envelope.verbId !== "string" ||
      envelope.verbId.length === 0
    ) {
      return false
    }
    // Reject a non-finite deadline. `#isPast` treats a non-finite deadline as
    // "never past" (a fail-safe against a garbage CLOCK), but a verb registered
    // with `deadlineAt = NaN/Infinity` would then NEVER time out — so an
    // arbitrarily late response would later apply as fresh (a stale-decision
    // apply, the opposite of safe). Refuse the registration up front.
    if (!Number.isFinite(envelope.deadlineAt)) return false
    if (this.#entries.has(envelope.verbId)) return false
    this.#entries.set(envelope.verbId, { envelope, status: "pending" })
    return true
  }

  /**
   * Resolve a verb with the follower's response at time `now`. Applies ONLY when
   * the verb is still pending AND `now <= deadlineAt`. A late response times the
   * verb out in place (so it can never be applied after its deadline even if
   * {@link sweep} has not run). Subsequent resolves are stale.
   */
  resolve(verbId: string, now: number): ResolveOutcome {
    const entry = this.#entries.get(verbId)
    if (entry === undefined) return { kind: "stale", reason: "unknown_verb" }
    if (entry.status === "timed_out") return { kind: "stale", reason: "timed_out" }
    if (entry.status === "resolved") return { kind: "stale", reason: "already_resolved" }
    // status === "pending"
    if (this.#isPast(now, entry.envelope.deadlineAt)) {
      // Late response — time it out in place; the fallback owns the decision now.
      entry.status = "timed_out"
      return { kind: "stale", reason: "timed_out" }
    }
    entry.status = "resolved"
    return { kind: "apply", verb: entry.envelope.verb }
  }

  /**
   * Mark every still-pending verb whose deadline has passed as `timed_out` and
   * return them so the host can fire each one's DEFINED fallback. After a verb is
   * swept, a later {@link resolve} returns `stale: timed_out`. Idempotent: a
   * verb is surfaced by exactly ONE sweep (the transition pending→timed_out
   * happens once).
   */
  sweep(now: number): readonly TimedOutVerb[] {
    const out: TimedOutVerb[] = []
    for (const entry of this.#entries.values()) {
      if (entry.status === "pending" && this.#isPast(now, entry.envelope.deadlineAt)) {
        entry.status = "timed_out"
        out.push({ verbId: entry.envelope.verbId, verb: entry.envelope.verb })
      }
    }
    return out
  }

  /** Number of still-pending (not yet resolved/timed-out) verbs — observability. */
  pendingCount(): number {
    let n = 0
    for (const entry of this.#entries.values()) {
      if (entry.status === "pending") n += 1
    }
    return n
  }

  /** Drop resolved/timed-out entries so the map does not grow unbounded over a
   *  long-lived thread. Pending entries are retained. Returns the count dropped. */
  prune(): number {
    let dropped = 0
    for (const [id, entry] of this.#entries) {
      if (entry.status !== "pending") {
        this.#entries.delete(id)
        dropped += 1
      }
    }
    return dropped
  }

  /** A deadline is INCLUSIVE: `now` strictly GREATER than the deadline is past.
   *  A non-finite `now` is treated as NOT past (fail-safe: never time a verb out
   *  on a garbage clock — the audit's stale guard must not trip spuriously). */
  #isPast(now: number, deadlineAt: number): boolean {
    if (!Number.isFinite(now) || !Number.isFinite(deadlineAt)) return false
    return now > deadlineAt
  }
}
