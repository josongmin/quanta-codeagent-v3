/**
 * RFC-01 A3 — question owner correlation (`@/agent/user-question`).
 *
 * Binds a `request_user_input` call to its {@link QuestionOwner} using ONLY the
 * EXPLICIT `AgentConfig.spawnedAsTaskId` (the registry task id under which this
 * agent config was itself registered when spawned as a child). There is NO
 * inference: no parent-chain walk, no "newest task", no PID/cwd/name. The ROOT
 * session leaves `spawnedAsTaskId` unset ⇒ a root-arm owner, which A2's reader
 * deliberately keeps OUT of the subagent fleet (blueprint §5 / §10).
 *
 * Removing this exact correlation (binding root instead) makes the questioning
 * child's attention row DISAPPEAR — it is never reassigned to another task
 * (pinned by the RED-on-injection case in
 * `tests/integration/child-question-attention-projection.test.ts`).
 */

import type { QuestionOwner } from "@/session/user-question"

/** Explicit owner for a question raised by this agent config. */
export const questionOwnerFor = (spawnedAsTaskId: string | undefined): QuestionOwner =>
  spawnedAsTaskId !== undefined ? { kind: "task", taskId: spawnedAsTaskId } : { kind: "root" }
