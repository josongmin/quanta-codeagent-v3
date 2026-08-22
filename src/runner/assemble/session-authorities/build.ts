/**
 * RFC-01 A2 — session-authority graph construction + the LIVE question/attention
 * join (`@/runner/assemble/session-authorities`).
 *
 * `buildSessionAuthorities` is the FIRST holder of the shared session-authorities
 * owner lock (board §5). It carries the ONE injected `TaskRegistry` (no parallel
 * authority) and, only under the `QUANTA_ATTENTION_NAV` gate, wires A1's PURE
 * `@/attention` resolver + the `@/session/user-question` broker into a read-only
 * {@link AttentionReader}.
 *
 * DEFAULT-OFF byte-identity: the gate is its OWN knob, independent of the
 * subagent-panel gate (`QUANTA_WEB_SUBAGENTS`). When it is unset/falsy, the
 * returned graph is exactly `{ tasks }` — no broker, no reader, no extra keys —
 * so the pre-attention baseline graph is unchanged (pinned by the constructor-
 * parity + red-on-injection test).
 *
 * NO NEW STATE: the resolver stays pure and the reader derives a fresh snapshot
 * from the live authorities on every call (A2 wires inputs to the resolver; it
 * does not add an accumulator). The task/question JOIN is legal here because
 * `runner/assemble` is the cross-slice composition layer; `@/session/user-question`
 * itself never imports `@/subagent`.
 */

import { type ActivityStore, createActivityStore } from "@/activity"
import { type AttentionAgent, nextNeedingAttention } from "@/attention"
import { createUserQuestionBroker, type UserQuestionBroker } from "@/session/user-question"
import { gateOn } from "@/shared"
import type { TaskRegistry } from "@/subagent"
import type { AttentionReader, BuildSessionAuthoritiesInput, SessionAuthorities } from "./types"

/** A2's own default-OFF gate. Deliberately independent of the panel gate
 *  (`QUANTA_WEB_SUBAGENTS`): the attention authority must not leak just because
 *  the subagent panel is on (review §정정1 / T7 cross-case). */
const ATTENTION_GATE = "QUANTA_ATTENTION_NAV"

/**
 * Derive the lineage root id for `taskId` by walking the existing
 * `parentTaskId` chain to its top ancestor (no new substrate; no ancestry-
 * inferred *session* root — the top TASK id is the lineage scope key the
 * resolver's gate compares). Cycle-guarded and terminates on a missing parent.
 */
const rootIdOf = (tasks: TaskRegistry, taskId: string): string => {
  let cur = tasks.get(taskId)
  if (cur === undefined) return taskId
  const seen = new Set<string>()
  while (cur.parentTaskId !== undefined && !seen.has(cur.id)) {
    seen.add(cur.id)
    const parent = tasks.get(cur.parentTaskId)
    if (parent === undefined) break
    cur = parent
  }
  return cur.id
}

/**
 * Join the LIVE broker + registry into the resolver's input shape. Only the
 * `task` owner arm joins the fleet; a task binding that no longer resolves to a
 * live `TaskRecord` (unknown/settled) is dropped rather than fabricated. The
 * broker already bounds + secret-scrubs `preview`, so the summary is UI-safe.
 */
const deriveAttentionAgents = (
  tasks: TaskRegistry,
  questions: UserQuestionBroker,
): AttentionAgent[] => {
  const rows: AttentionAgent[] = []
  for (const p of questions.listPending()) {
    if (p.owner.kind !== "task") continue // root questions are session-level, not fleet rows
    const rec = tasks.get(p.owner.taskId)
    if (rec === undefined) continue // no live task ⇒ no row (never fabricate)
    rows.push({
      id: rec.id,
      label: rec.mailboxLabel ?? rec.description,
      rootId: rootIdOf(tasks, rec.id),
      pendingQuestion: { requestId: p.requestId, askedAt: p.askedAt, summary: p.preview },
    })
  }
  return rows
}

/** The read-only navigation reader. Stateless: re-derives per call so it always
 *  reflects the live authorities, and delegates selection to the PURE resolver. */
const createAttentionReader = (
  tasks: TaskRegistry,
  questions: UserQuestionBroker,
): AttentionReader => ({
  snapshot: () => deriveAttentionAgents(tasks, questions),
  next: (ownRootId, afterRequestId) =>
    nextNeedingAttention(deriveAttentionAgents(tasks, questions), ownRootId, afterRequestId),
})

/**
 * Construct the per-session authority graph. The ONE session `ActivityStore` is
 * ALWAYS minted here (RFC-04 D4 — the single production owner; surfaces observe
 * it via DI, never a command/surface-local `createActivityStore()`). The
 * question/attention arms are added only when the `QUANTA_ATTENTION_NAV` gate is
 * ON AND a `tasks` registry exists; otherwise the graph is byte-identical to the
 * pre-attention baseline for those arms (`{ activity, tasks? }`).
 */
export const buildSessionAuthorities = (
  input: BuildSessionAuthoritiesInput,
): SessionAuthorities => {
  const { tasks, env } = input
  const activity: ActivityStore = input.activity ?? createActivityStore()
  if (tasks === undefined || !gateOn(env, ATTENTION_GATE)) {
    // Attention baseline: no question/attention authority is constructed. The
    // store is always present; the task registry rides along when supplied.
    return { activity, ...(tasks !== undefined ? { tasks } : {}) }
  }
  const questions = input.questions ?? createUserQuestionBroker(input.questionDeps)
  const attention = createAttentionReader(tasks, questions)
  return { activity, tasks, questions, attention }
}
