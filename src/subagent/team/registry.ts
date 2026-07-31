/**
 * Peer teammate messaging — team registry (RFC jun-6, DELTA #2).
 *
 * A team is a MEMBERSHIP SET sharing one bus. quanta has ONE per-session
 * `MailboxPort`; this registry adds a thin membership SCOPE over it WITHOUT
 * forking the store — `TeamScopedMailbox` (see `@/agent/subagent-mailbox`)
 * consults `sameTeam(from,to)` at `send` time to deny cross-team mail BEFORE
 * enqueue, so a cross-team peer can never reach a victim's delivery cursor.
 *
 * `TeamCreate` mints a team id + seeds members; `TeamDelete` reaps it and
 * returns the reaped member ids (the host disposes their runners via the
 * existing subagent disposer — no new teardown machinery). Keeping ONE bounded
 * store (the audit-H caps stay global) means total memory is capped regardless
 * of team count.
 *
 * SLICE FENCE: pure leaf. Imports NOTHING (no `@/agent`, no `@/subagent`
 * sibling, no `@/shared`). Pure data + a closed port. NO-THROW is not required
 * here (it is host-driven control, not a hostile-input boundary) but every
 * method degrades gracefully on a malformed / unknown id rather than throwing.
 */

/** Membership set + delivery-time gate. A teammate may only `send` to an agent
 *  in the SAME team (or broadcast scoped to its own team); cross-team is denied
 *  at `send`. An agent NOT in any team is in no team — `sameTeam` against it is
 *  false, so an un-teamed agent neither sends nor receives team-scoped mail. */
export interface TeamRegistryPort {
  /** Mint a team with `members`. When `caller` is given (an LLM tool call, jul-7 audit
   *  F2), it is AUTHORIZED: the caller may not join an already-existing team it is not
   *  in, and may not re-home a member already in ANOTHER team — both would grant it that
   *  team's cross-team send scope. `caller` undefined ⇒ trusted host path (re-homes freely,
   *  byte-identical). An agent belongs to exactly one team (single global membership map). */
  create(teamId: string, members: readonly string[], caller?: string): void
  /** Reap the team; returns the member ids that were removed (empty for an unknown id, or
   *  when `caller` is given and does NOT belong to `teamId` — jul-7 audit F3, no cross-team
   *  reap). `caller` undefined ⇒ trusted host teardown. The host disposes each member's runner. */
  delete(teamId: string, caller?: string): readonly string[]
  /** A spawned teammate joins (re-homes from any prior team). No-op for an
   *  empty agent id. Auto-creates the team if unknown. */
  addMember(teamId: string, agentId: string): void
  /** Remove a member (no-op if absent / not in that team). */
  removeMember(teamId: string, agentId: string): void
  /** The team `agentId` belongs to, or `undefined` when un-teamed. */
  teamOf(agentId: string): string | undefined
  /** Delivery-time gate: are `a` and `b` in the SAME (non-undefined) team?
   *  False when either is un-teamed (an un-teamed agent shares no bus). */
  sameTeam(a: string, b: string): boolean
  /** The members of `teamId` (empty for an unknown id). Stable insertion order. */
  members(teamId: string): readonly string[]
}

const isUsableId = (v: unknown): v is string => typeof v === "string" && v.length > 0

/**
 * In-memory `TeamRegistryPort`. A single global `agentId → teamId` map (an
 * agent belongs to exactly ONE team) plus a `teamId → Set<agentId>` reverse
 * index kept consistent on every mutation. Zero deps; deterministic (insertion
 * order preserved by `Set` iteration); no clock / no randomness.
 */
export const createTeamRegistry = (): TeamRegistryPort => {
  /** agentId → teamId (exactly one team per agent). */
  const teamByAgent = new Map<string, string>()
  /** teamId → ordered set of member agent ids. */
  const agentsByTeam = new Map<string, Set<string>>()

  /** Detach `agentId` from whatever team it is currently in (keeps the two
   *  indexes consistent). No-op when un-teamed. */
  const detach = (agentId: string): void => {
    const prior = teamByAgent.get(agentId)
    if (prior === undefined) return
    teamByAgent.delete(agentId)
    const set = agentsByTeam.get(prior)
    if (set !== undefined) {
      set.delete(agentId)
      if (set.size === 0) agentsByTeam.delete(prior)
    }
  }

  const join = (teamId: string, agentId: string): void => {
    if (!isUsableId(teamId) || !isUsableId(agentId)) return
    detach(agentId)
    teamByAgent.set(agentId, teamId)
    let set = agentsByTeam.get(teamId)
    if (set === undefined) {
      set = new Set<string>()
      agentsByTeam.set(teamId, set)
    }
    set.add(agentId)
  }

  return {
    create(teamId, members, caller): void {
      if (!isUsableId(teamId)) return
      const existed = agentsByTeam.has(teamId)
      // caller-auth (jul-7 audit F2): an LLM caller cannot HIJACK a team it is not in —
      // joining an existing foreign team would grant it that team's cross-team send scope.
      if (caller !== undefined && existed && teamByAgent.get(caller) !== teamId) return
      if (!existed) agentsByTeam.set(teamId, new Set<string>())
      if (Array.isArray(members)) {
        for (const m of members) {
          // caller-auth: may seed only ITSELF or an UNTEAMED agent — never re-home a
          // member already in ANOTHER team (that is the re-home hijack that bypasses the
          // teamScopedMailbox cross-team deny). Host path (no caller) re-homes freely.
          if (
            caller !== undefined &&
            m !== caller &&
            teamByAgent.has(m) &&
            teamByAgent.get(m) !== teamId
          ) {
            continue
          }
          join(teamId, m)
        }
      }
    },

    delete(teamId, caller): readonly string[] {
      if (!isUsableId(teamId)) return []
      // caller-auth (jul-7 audit F3): an LLM caller may reap ONLY a team it belongs to —
      // no cross-team DoS. Host teardown (no caller) reaps any team.
      if (caller !== undefined && teamByAgent.get(caller) !== teamId) return []
      const set = agentsByTeam.get(teamId)
      if (set === undefined) return []
      const reaped = [...set]
      for (const agentId of reaped) teamByAgent.delete(agentId)
      agentsByTeam.delete(teamId)
      return reaped
    },

    addMember(teamId, agentId): void {
      join(teamId, agentId)
    },

    removeMember(teamId, agentId): void {
      if (teamByAgent.get(agentId) !== teamId) return
      detach(agentId)
    },

    teamOf(agentId): string | undefined {
      return teamByAgent.get(agentId)
    },

    sameTeam(a, b): boolean {
      const ta = teamByAgent.get(a)
      if (ta === undefined) return false
      return ta === teamByAgent.get(b)
    },

    members(teamId): readonly string[] {
      const set = agentsByTeam.get(teamId)
      return set === undefined ? [] : [...set]
    },
  }
}
