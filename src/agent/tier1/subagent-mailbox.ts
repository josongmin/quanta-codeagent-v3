/**
 * Tier-1 per-subsystem builder: SUBAGENT MAILBOX block (ADR-0416).
 *
 * Returns the `subagent_send_message` tool when `config.subagentMailbox` is
 * wired; empty array otherwise.
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
import type { AgentConfig } from "../types"

/** Build the subagent-mailbox tool when `config.subagentMailbox` is wired. */
export const buildSubagentMailboxBlock = (config: AgentConfig): Tool[] => {
  const port = config.subagentMailbox
  if (port === undefined) return []
  return subagentMailboxTools(port)
}
