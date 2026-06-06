/**
 * RFC jun-6 — host wire for peer teammate messaging (Binding 2).
 *
 * The three deltas are built + hellgate-proven as SEAMS:
 *   - DELTA #1 auto-delivery: `cfg.peerInbox` drain (the loop's turn-top
 *     `pollPeerInbox` already calls it) + `createPeerInboxDrain`
 *     (`@/agent/subagent-mailbox`).
 *   - DELTA #2 team boundary: `createTeamRegistry` (`@/subagent`) +
 *     `teamScopedMailbox` decorator (`@/agent/subagent-mailbox`) +
 *     `team_create`/`team_delete` tools (`@/tool/team`, registered by the tier1
 *     `buildTeamBlock` when `cfg.teamRegistry` is set).
 *   - DELTA #3 redaction: the drain's injected `redact` (default identity).
 *
 * THIS module is the composition root that injects all three onto the assembled
 * `AgentConfig` — ONLY when `QUANTA_TEAM_PEER_MSG` is on:
 *   1. mint ONE per-session `TeamRegistryPort` → `cfg.teamRegistry` (so the
 *      tier1 `buildTeamBlock` registers the `team_*` tools + the subagent runner
 *      registers spawned children into it);
 *   2. wrap `cfg.subagentMailbox` with `teamScopedMailbox` (cross-team `send`
 *      denied + broadcast scoped to the sender's own team — the audit-H caps stay
 *      global because we DECORATE, not replace);
 *   3. wire `cfg.peerInbox = createPeerInboxDrain(mailbox, { redact })` so the
 *      turn-loop auto-delivers peer mail (DELTA #1) with each untrusted body run
 *      through `@/security#redactSecrets` (DELTA #3).
 *
 * DEFAULT-OFF / byte-identical: knob unset ⇒ NONE of the above ⇒ no `peerInbox`
 * slot, the raw global mailbox, no team registry, `team_*` tools unregistered.
 *
 * SECURITY: the peer bus is a COMMS channel, never a grant channel — the drain
 * has no permission port (auto-delivered mail is INFORMATION, tagged untrusted),
 * the cross-team deny is enforced at `send` (before enqueue), and `broker.ts`
 * (the leader-authored-response-only widen) is UNTOUCHED.
 */

import type { TeamMembershipGate } from "@/agent/subagent-mailbox"
import { createPeerInboxDrain, teamScopedMailbox } from "@/agent/subagent-mailbox"
import type { AgentConfig } from "@/agent/types"
import { redactSecrets } from "@/security"
import { runtimeConfig } from "@/shared"
import { createTeamRegistry, type TeamRegistryPort } from "@/subagent"

/** Adapt the `TeamRegistryPort` into the decorator's `TeamMembershipGate`
 *  (`sameTeam(a,b)` + `membersOf(agentId)`). `membersOf` resolves the agent's
 *  team via `teamOf` then lists its roster; an un-teamed agent ⇒ empty roster
 *  (it shares no bus). */
const membershipGate = (registry: TeamRegistryPort): TeamMembershipGate => ({
  sameTeam: (a, b) => registry.sameTeam(a, b),
  membersOf: (agentId) => {
    const team = registry.teamOf(agentId)
    return team === undefined ? [] : registry.members(team)
  },
})

/** Adapt `redactSecrets` (which returns a `RedactResult`) into the drain's
 *  `redact: (s) => string`. A peer body is untrusted-peer content; we classify
 *  it as `tool_result` origin so the secret/PII patterns apply. */
const peerBodyRedactor = (body: string): string =>
  redactSecrets(body, { origin: "tool_result" }).text

/**
 * Wire peer teammate messaging onto `cfg` when `QUANTA_TEAM_PEER_MSG` is on.
 * Caller-override-safe: a pre-set `cfg.teamRegistry` / `cfg.peerInbox` is
 * preserved. Requires `cfg.subagentMailbox` (the shared bus) — absent ⇒ the
 * team boundary has nothing to decorate, so we mint the registry + tools only
 * if a mailbox is present (the CLI seeds `QUANTA_SUBAGENT_MAILBOX=1` alongside).
 * Knob-OFF ⇒ no-op (byte-identical).
 */
export const maybeWirePeerTeamMessaging = (
  cfg: AgentConfig,
  _env: Record<string, string | undefined>,
): void => {
  if (!runtimeConfig().teamPeerMsg) return
  // The peer bus IS the subagent mailbox; without it there is nothing to scope.
  if (cfg.subagentMailbox === undefined) return

  // (1) Mint ONE per-session team registry (caller-override-safe).
  const registry = cfg.teamRegistry ?? createTeamRegistry()
  if (cfg.teamRegistry === undefined) cfg.teamRegistry = registry

  // (2) Decorate the shared mailbox with the team-membership gate (cross-team
  // deny + broadcast-scoped-to-team). DECORATE, not replace — the audit-H caps
  // stay global. Mutating the slot in place so every consumer (the runner's
  // child-config propagation, the mailbox tools) sees the scoped instance.
  const scoped = teamScopedMailbox(cfg.subagentMailbox, membershipGate(registry))
  cfg.subagentMailbox = scoped

  // (3) Auto-delivery drain (DELTA #1) + body redaction (DELTA #3). The loop's
  // turn-top `pollPeerInbox` calls `cfg.peerInbox.drainFor(mailboxAgentId)`.
  if (cfg.peerInbox === undefined) {
    cfg.peerInbox = createPeerInboxDrain(scoped, { redact: peerBodyRedactor })
  }
}
