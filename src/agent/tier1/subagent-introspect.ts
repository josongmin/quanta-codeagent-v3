/**
 * Tier-1 per-subsystem builder: SUBAGENT INTROSPECT block (RFC-04 / ADR-0437).
 *
 * Builds `list_agents` and/or `followup_task` when their gates are on:
 *   - `config.subagent.enableIntrospect === true` ⇒ `list_agents` (needs the
 *     shared `TaskRegistry`; joins `config.subagentAgentMeta` when wired).
 *   - `config.subagent.enableFollowup === true` ⇒ `followup_task` (needs the
 *     shared `TaskRegistry` + `config.subagentMailbox` + `config.subagentTurnWake`).
 *
 * DEFAULT-OFF: gates absent/false OR required substrate missing ⇒ the
 * corresponding tool is NOT built and the ToolRegistry stays byte-identical.
 * Mirrors `buildSubagentMailboxBlock` posture.
 *
 * SHARED REGISTRY: `list_agents` / `followup_task` MUST observe the SAME
 * `TaskRegistry` the trio/6-tool spawn into. That instance is shared by setting
 * `config.subagent.taskRegistry` (the surface-provided registry the trio also
 * adopts). Absent ⇒ the introspect tools see a FRESH (empty) registry — honest
 * degradation, never a crash — so the host is expected to wire
 * `taskRegistry` whenever it enables introspection.
 *
 * SLICE FENCE: imports `@/tool` (Tool) + `@/subagent` (the introspect slice).
 * The real `MailboxPort` is adapted onto the narrow `MailboxSendPort` mirror
 * inline (structurally identical `send`).
 */

import { logger } from "@/shared"
import { createIntrospectTools, type MailboxSendPort } from "@/subagent"
import type { Tool } from "@/tool"
import type { AgentConfig } from "../types"

// ALBB-12 claim 1 — once-per-process guard so a genuinely-split surface warns
// exactly once (never spams across sessions), mirroring `wireCloseoutCritic`.
let warnedIntrospectNoRegistry = false

export const buildSubagentIntrospectBlock = (config: AgentConfig): Tool[] => {
  const sub = config.subagent
  if (sub === undefined) return []
  const wantList = sub.enableIntrospect === true
  const wantFollowup = sub.enableFollowup === true
  if (!wantList && !wantFollowup) return []

  // FAIL-CLOSED (ALBB-12 claim 1): the introspect tools MUST observe the SAME
  // `TaskRegistry` the agent/6-tool spawn path fills. The features seam writes
  // R1 back onto `config.subagent.taskRegistry`, and `wireSubagentToolGates`
  // mints one for env-gated surfaces — so `taskRegistry` is present by
  // construction whenever a surface reaches this builder correctly. If it is
  // STILL absent the surface is genuinely mis-wired: fabricating a fresh empty
  // registry here would register `list_agents`/`followup_task` over a table that
  // NEVER sees the real tasks (silent wrong output). Instead fail OPEN visibly —
  // build NO tool + surface the split ONCE — mirroring `wireCloseoutCritic`'s
  // no-reviewer posture (optional-ports.ts).
  const registry = sub.taskRegistry
  if (registry === undefined) {
    if (!warnedIntrospectNoRegistry) {
      warnedIntrospectNoRegistry = true
      logger.warn(
        "subagent introspect gate is on but no shared taskRegistry is wired — list_agents/followup_task will NOT be registered (they would observe an empty registry). Wire config.subagent.taskRegistry (the features seam / wireSubagentToolGates do this automatically).",
      )
    }
    return []
  }

  // The real MailboxPort has a `send` whose shape matches MailboxSendPort
  // exactly; adopt it directly (structural).
  const mailbox = config.subagentMailbox as MailboxSendPort | undefined
  const wake = config.subagentTurnWake

  return createIntrospectTools({
    registry,
    ...(config.subagentAgentMeta !== undefined ? { agentMeta: config.subagentAgentMeta } : {}),
    ...(mailbox !== undefined ? { mailbox } : {}),
    ...(wake !== undefined ? { wake } : {}),
    // BUG#4 fix — `followup_task`'s `agentId` is the registry TASK id, but the
    // target child reads its inbox under a DISJOINT mailbox label (`root/N`).
    // The wake registry records that mapping at child-spawn (`register(taskId,
    // …, mailboxLabel)`); resolve the delivery address through it so the message
    // reaches the child's real inbox instead of a phantom task-id address. Absent
    // a binding (`labelOf` ⇒ undefined) the handler falls back to the id verbatim.
    ...(wake !== undefined ? { resolveLabel: (id: string) => wake.labelOf(id) } : {}),
    // BUG#4 self-target guard — reject a child `followup_task`-ing its OWN loop.
    // The child carries its registry task id as `subagentTaskId`; absent (root /
    // non-spawned) ⇒ no guard (root is never a valid target anyway).
    ...(config.subagentTaskId !== undefined ? { ownAgentId: config.subagentTaskId } : {}),
    ...(config.mailboxAgentId !== undefined ? { callerLabel: config.mailboxAgentId } : {}),
    // F-B/F-E (jul-7 audit) — scope list_agents enumeration + gate followup_task by THIS
    // agent's own lineage. The agent's deterministic label (`mailboxAgentId`, ADR-0416) IS
    // the lineage the spawn owners ledger stamps its children under, so a child sees/nudges
    // only its own subtree + owner-less host-seeded tasks. Absent (root, no label) ⇒
    // unscoped list (top authority) + tree-scoped followup via ROOT_LINEAGE fallback.
    ...(config.mailboxAgentId !== undefined ? { requesterLineage: config.mailboxAgentId } : {}),
    ...(wantList ? { enableIntrospect: true } : {}),
    ...(wantFollowup ? { enableFollowup: true } : {}),
  })
}
