/**
 * WS3 host adapter — build the controller's {@link TargetResolution} closure
 * over the concrete `TaskRegistry` + spawn-owners ledger. This is the ONE place
 * the registry/ownership/self/settled policy is evaluated for delivery (RFC
 * §4.3 — moved OUT of the `followup_task` tool). It reproduces the exact
 * pre-WS3 `handleFollowupTask` guard order + semantics so the migration is
 * behavior-preserving:
 *
 *   1. self target (`agentId === ownTaskId`)     ⇒ `self`
 *   2. unknown id (root or genuinely-unknown)    ⇒ `unknown`
 *   3. foreign lineage (owner ≠ requester)       ⇒ `ownership_denied`
 *      (owner-less target ⇒ legacy allowed, byte-identical)
 *   4. not running (settled)                     ⇒ `settled`
 *   5. else                                       ⇒ `running` (+ mailbox label)
 *
 * Living in `@/agent` it may import the concrete `@/subagent` registry/owners
 * helpers; the controller itself stays a pure decide/apply leaf consuming only
 * the returned discriminated result.
 */

import { ownersForRegistry, ROOT_LINEAGE, type TaskRegistry } from "@/subagent"
import type { TargetResolution } from "./controller"
import type { SubagentControlRegistry } from "./ports"

export interface TargetResolverDeps {
  readonly registry: TaskRegistry
  /** The control registry, consulted for the target's mailbox label (task id →
   *  `root/N`). Absent binding ⇒ the controller falls back to the id verbatim. */
  readonly control: SubagentControlRegistry
  /** The requesting agent's lineage. Absent ⇒ `ROOT_LINEAGE` (top authority);
   *  an owner-less target is allowed regardless (legacy byte-identical). */
  readonly requesterLineage?: string
  /** This agent's own registry task id; a self-target is rejected. Absent ⇒ no
   *  self guard (root is never a valid target anyway). */
  readonly ownTaskId?: string
}

export const createTargetResolver = (
  deps: TargetResolverDeps,
): ((targetTaskId: string) => TargetResolution) => {
  return (targetTaskId: string): TargetResolution => {
    if (deps.ownTaskId !== undefined && targetTaskId === deps.ownTaskId) {
      return { kind: "self" }
    }
    const rec = deps.registry.get(targetTaskId)
    // root is the main loop — never in the registry. Unknown id covers both a
    // genuinely-unknown id AND a root-targeting attempt (non-root only policy).
    if (rec === undefined) return { kind: "unknown" }
    // Lineage gate BEFORE reporting running-state: a foreign-lineage child is
    // refused (owner-less ⇒ legacy allowed, tree-scoped via `?? ROOT_LINEAGE`).
    const recordedOwner = ownersForRegistry(deps.registry).get(targetTaskId)
    if (recordedOwner !== undefined && recordedOwner !== (deps.requesterLineage ?? ROOT_LINEAGE)) {
      return { kind: "ownership_denied" }
    }
    if (rec.status !== "running") return { kind: "settled" }
    const label = deps.control.labelOf(targetTaskId)
    return label !== undefined ? { kind: "running", mailboxLabel: label } : { kind: "running" }
  }
}
