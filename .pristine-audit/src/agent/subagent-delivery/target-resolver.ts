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

// ─────────────────────────────────────────────────────────────────────────────
// RFC07-1 — named `to:` address resolution.
//
// Maps a caller-supplied NAME (e.g. "reviewer") to the one live, caller-visible
// child whose exact `agentType` is that name, reusing the SAME live TaskRegistry
// records + spawn-owner ledger the delivery resolver already trusts. There is NO
// global name→id map, NO NamedAgentRegistry mutation, and NO fuzzy/prefix/
// nearest/first-win heuristic — an exact `agentType` match among RUNNING records
// OWNED by the caller lineage only.
//
// Security posture (admission-level, not hardening):
//   - foreign-lineage records are filtered out BEFORE matching, so a foreign
//     `reviewer` is indistinguishable from absence (`no_match`) — the task id,
//     name, status, and mailbox label are never disclosed.
//   - owner-less records (no lineage proof) do NOT resolve by name (fail-closed);
//     the caller can still address them by raw id through the existing path.
//   - two visible owned matches ⇒ `ambiguous` with candidate task ids and zero
//     resolution (the caller MUST disambiguate by raw id).
// ─────────────────────────────────────────────────────────────────────────────

/** Result of resolving a NAME (not a task id) to a mailbox address. `no_match`
 *  is the caller's signal to fall through to the existing raw-id/parent/broadcast
 *  path — it is deliberately indistinguishable from a foreign-lineage match. */
export type NamedAddressResolution =
  | { readonly kind: "resolved"; readonly mailboxLabel: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "no_match" }

export interface NamedAddressResolverDeps {
  readonly registry: TaskRegistry
  /** The requesting agent's lineage. Absent ⇒ `ROOT_LINEAGE`. Only records whose
   *  spawn-owner ledger entry EXACTLY equals this lineage are visible for name
   *  resolution (foreign/owner-less ⇒ invisible). */
  readonly requesterLineage?: string
}

/**
 * Build the named-address resolver closure over the concrete registry + owner
 * ledger. Pure lookup — no mutation of any registry/ledger. Exact `agentType`
 * match only; no normalization/fold/trim of the requested name.
 */
export const createNamedAddressResolver = (
  deps: NamedAddressResolverDeps,
): ((name: string) => NamedAddressResolution) => {
  const requester = deps.requesterLineage ?? ROOT_LINEAGE
  return (name: string): NamedAddressResolution => {
    const owners = ownersForRegistry(deps.registry)
    const matches = deps.registry.list().filter((rec) => {
      if (rec.status !== "running") return false
      if (rec.mailboxLabel === undefined) return false
      if (rec.agentType !== name) return false // EXACT match only — no fuzzy/prefix/fold
      // Owner MUST be present AND equal the caller lineage. Owner-less (no proof)
      // and foreign-lineage are both filtered here, so both collapse to no_match.
      return owners.get(rec.id) === requester
    })
    if (matches.length === 0) return { kind: "no_match" }
    if (matches.length > 1) {
      return { kind: "ambiguous", candidates: matches.map((r) => r.id) }
    }
    // Exactly one visible owned match — resolve to its canonical mailbox label.
    // (mailboxLabel presence was asserted by the filter.)
    return { kind: "resolved", mailboxLabel: matches[0]?.mailboxLabel as string }
  }
}
