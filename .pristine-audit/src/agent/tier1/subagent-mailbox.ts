/**
 * Tier-1 per-subsystem builder: SUBAGENT MAILBOX block (ADR-0416 + ADR-0419).
 *
 * Returns BOTH the `subagent_send_message` (ADR-0416, SEND) and
 * `subagent_read_messages` (ADR-0419, READ — closes the ADR-0416 read deferral)
 * tools when `config.subagentMailbox` is wired; empty array otherwise. The two
 * tools share the SAME `MailboxPort` instance via `subagentMailboxTools(port)`.
 *
 * DEFAULT-OFF: `config.subagentMailbox` absent ⇒ this builder returns [], so the
 * loop sees no extra tools and the ToolRegistry stays byte-identical. Mirrors
 * `buildObjectiveBlock` / `buildSubagentBgBlock` posture.
 *
 * SLICE FENCE: the `@/tool/subagent-mailbox` slice imports `@/agent/subagent-
 * mailbox` types directly (the closed ADR-0416 substrate is its own slice —
 * separate from the agent core). This builder is the composition root that
 * threads the host-supplied `MailboxPort` into the tool factory at session-start.
 */

import type { Tool } from "@/tool"
import { subagentMailboxTools } from "@/tool/subagent-mailbox"
import { createNamedAddressResolver } from "../subagent-delivery/target-resolver"
import type { AgentConfig } from "../types"

/** Build the subagent-mailbox tools when `config.subagentMailbox` is wired.
 *
 *  RFC07-1: when a shared `taskRegistry` is also present, thread a narrow
 *  named-address resolver so `subagent_send_message({to:"reviewer"})` reaches the
 *  one live child of that exact name OWNED by this agent's lineage. The resolver
 *  reuses the live registry + spawn-owner ledger (no global name map, no
 *  NamedAgentRegistry mutation). The requester lineage is this agent's
 *  system-minted `mailboxAgentId` (never sourced from tool input); absent ⇒ the
 *  resolver's ROOT_LINEAGE default applies. When `taskRegistry` is absent the
 *  callback is omitted and delivery stays byte-identical to the pre-RFC07-1 path. */
export const buildSubagentMailboxBlock = (config: AgentConfig): Tool[] => {
  const port = config.subagentMailbox
  if (port === undefined) return []
  // Reuse the SAME shared registry the introspect trio (`list_agents`/
  // `followup_task`) uses — `config.subagent.taskRegistry`. Absent ⇒ no named
  // resolution wired (byte-identical to the pre-RFC07-1 verbatim path).
  const registry = config.subagent?.taskRegistry
  if (registry === undefined) return subagentMailboxTools(port)
  const resolveNamedTarget = createNamedAddressResolver({
    registry,
    ...(config.mailboxAgentId !== undefined ? { requesterLineage: config.mailboxAgentId } : {}),
  })
  return subagentMailboxTools(port, { resolveNamedTarget })
}
