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

import { createIntrospectTools, type MailboxSendPort, TaskRegistry } from "@/subagent"
import type { Tool } from "@/tool"
import type { AgentConfig } from "../types"

export const buildSubagentIntrospectBlock = (config: AgentConfig): Tool[] => {
  const sub = config.subagent
  if (sub === undefined) return []
  const wantList = sub.enableIntrospect === true
  const wantFollowup = sub.enableFollowup === true
  if (!wantList && !wantFollowup) return []

  // Share the trio/6-tool registry when the surface wired one; else a fresh
  // (empty) registry — honest degradation (list returns []), never a throw.
  const registry = sub.taskRegistry ?? new TaskRegistry()

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
    ...(wantList ? { enableIntrospect: true } : {}),
    ...(wantFollowup ? { enableFollowup: true } : {}),
  })
}
