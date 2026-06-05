/**
 * Capability C — team-idle barrier + idle beacon (multi-agent coordination).
 *
 * Plan: docs/plans/multiagent-coordination.md §2.C.
 *
 * A leader fans IN by awaiting "every team member is idle" instead of polling.
 * Each member emits an {@link IdleBeacon} at turn-end; the team is idle when
 * every member id carries a current beacon. The barrier-release timestamp is the
 * MAX idleSince across members (the moment the LAST member went idle).
 *
 * Two layers:
 *   - PURE transforms (`teamIdle` / `idleSince` / `upsertBeacon` / `clearBeacon`)
 *     — no I/O, no clock, fully deterministic + testable.
 *   - {@link createIdleBarrier} — a thin in-memory port with an INJECTED clock
 *     (NO `Date.now()`): `beacon`/`reactivate`/`teamIdle`/`idleSince`.
 *
 * Plane-clean: imports nothing (pure data). Default-OFF at the host: the leader
 * only consults this when `QUANTA_TEAM_IDLE` is on; absent ⇒ no barrier, no
 * beacons, byte-identical polling behavior.
 */

/** One member's idle marker: the member id + the instant it went idle. */
export interface IdleBeacon {
  readonly agentId: string
  /** Epoch ms the member went idle (caller-/clock-supplied — never `Date.now()`
   *  inside this module). */
  readonly idleSince: number
}

// ── pure transforms ──────────────────────────────────────────────────────────

/** The beacons restricted to known members (a stray beacon — id not in
 *  `members` — never participates in the barrier). */
const memberBeacons = (
  beacons: readonly IdleBeacon[],
  members: readonly string[],
): IdleBeacon[] => {
  const set = new Set(members)
  return beacons.filter((b) => set.has(b.agentId))
}

/**
 * The team is idle iff EVERY member id carries a beacon. Empty `members` ⇒
 * `false` (documented choice: no team ⇒ no barrier-release — never report a
 * vacuous team as "done"). Stray beacons (ids not in `members`) are ignored.
 */
export const teamIdle = (beacons: readonly IdleBeacon[], members: readonly string[]): boolean => {
  if (members.length === 0) return false
  const beaconed = new Set(memberBeacons(beacons, members).map((b) => b.agentId))
  return members.every((m) => beaconed.has(m))
}

/**
 * The barrier-release timestamp — the MAX `idleSince` across MEMBER beacons —
 * once the whole team is idle; `undefined` when not all members are idle (or
 * `members` is empty). Stray beacons never contribute.
 */
export const idleSince = (
  beacons: readonly IdleBeacon[],
  members: readonly string[],
): number | undefined => {
  if (!teamIdle(beacons, members)) return undefined
  let max = Number.NEGATIVE_INFINITY
  for (const b of memberBeacons(beacons, members)) {
    if (b.idleSince > max) max = b.idleSince
  }
  return max
}

/** Record (or REPLACE) a member's beacon — latest `idleSince` wins, exactly one
 *  entry per agent. PURE: returns a new array, never mutates the input. */
export const upsertBeacon = (beacons: readonly IdleBeacon[], beacon: IdleBeacon): IdleBeacon[] => [
  ...beacons.filter((b) => b.agentId !== beacon.agentId),
  beacon,
]

/** Drop a member's beacon (the member re-activated). PURE: returns a new array
 *  (a fresh copy even when nothing matched), never mutates the input. */
export const clearBeacon = (beacons: readonly IdleBeacon[], agentId: string): IdleBeacon[] =>
  beacons.filter((b) => b.agentId !== agentId)

// ── thin in-memory port (injected clock) ─────────────────────────────────────

/** The leader's view of team idleness. `beacon`/`reactivate` are the member-side
 *  writes; `teamIdle`/`idleSince` are the leader-side fan-in reads. */
export interface IdleBarrierPort {
  /** Mark `agentId` idle as of the injected clock's `now()`. */
  beacon(agentId: string): void
  /** Clear `agentId`'s beacon — it picked up work again. */
  reactivate(agentId: string): void
  teamIdle(members: readonly string[]): boolean
  idleSince(members: readonly string[]): number | undefined
}

export interface IdleBarrierOptions {
  /** Injected clock — the ONLY time source. Required so the barrier is
   *  deterministically testable (no `Date.now()`). */
  readonly now: () => number
}

/** In-memory {@link IdleBarrierPort} over the pure transforms + an injected
 *  clock. One instance per team/session. */
export const createIdleBarrier = (opts: IdleBarrierOptions): IdleBarrierPort => {
  let beacons: IdleBeacon[] = []
  return {
    beacon(agentId) {
      beacons = upsertBeacon(beacons, { agentId, idleSince: opts.now() })
    },
    reactivate(agentId) {
      beacons = clearBeacon(beacons, agentId)
    },
    teamIdle(members) {
      return teamIdle(beacons, members)
    },
    idleSince(members) {
      return idleSince(beacons, members)
    },
  }
}
