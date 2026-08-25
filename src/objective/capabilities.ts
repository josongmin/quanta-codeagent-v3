/**
 * GOAL-02 — actor-fixed objective capabilities.
 *
 * The raw {@link ObjectiveAuthority} protocol (`prepare` / `commit` with a
 * caller-supplied actor) stays at the composition root. Ordinary consumers
 * receive one of these narrow capabilities: the actor is bound HERE, never
 * carried in a payload, and the allowed mutation subset is typed. The authority
 * still re-checks every command against the policy table, so a forged raw
 * command through a capability is refused at runtime, not only at compile time.
 *
 * SLICE FENCE: sibling modules only.
 */

import { asObjectiveAuthority } from "./authority"
import type { ObjectiveActor, ObjectiveMutation } from "./mutations"
import type { ApprovalReceipt, CommitResult, ObjectiveAuthority, ObjectiveReadPort } from "./ports"
import type { ObjectivePort } from "./types"

/** Mutations the USER surface (`/goal`, web objective commands) may issue. */
export type UserObjectiveMutation = Extract<
  ObjectiveMutation,
  {
    kind:
      | "create"
      | "replace"
      | "clear"
      | "setExplicitStatus"
      | "amendBudget"
      | "addBlocker"
      | "clearBlocker"
      | "setNextActions"
      | "markCriterion"
  }
>

/** Mutations the MODEL tool may issue (definition minting is a gated proposal). */
export type ModelObjectiveMutation = Extract<
  ObjectiveMutation,
  { kind: "create" | "addBlocker" | "setNextActions" }
>

/** Mutations the CONTINUATION actor may issue. */
export type ContinuationObjectiveMutation = Extract<
  ObjectiveMutation,
  { kind: "addBlocker" | "setNextActions" }
>

/** The verifier's only mutation. */
export type VerifierObjectiveMutation = Extract<
  ObjectiveMutation,
  { kind: "markCriterionVerified" }
>

export interface CommitOptions {
  readonly expectedRevision?: number | undefined
  /** Supplied only by a surface that ran the approval round trip. */
  readonly approval?: ApprovalReceipt | undefined
}

export interface PreparedCommand {
  readonly approvalRequired: boolean
  readonly expectedRevision: number
  commit(approval: ApprovalReceipt): CommitResult
}

/** An actor-fixed command capability over a typed mutation subset. */
export interface ObjectiveCommands<M extends ObjectiveMutation> {
  readonly actor: ObjectiveActor
  prepare(threadId: string, mutation: M, expectedRevision?: number): PreparedCommand
  commit(threadId: string, mutation: M, options?: CommitOptions): CommitResult
}

export interface SystemObjectiveCommands extends ObjectiveCommands<ObjectiveMutation> {
  /** Append a bounded evidence packet (no revision change). */
  recordProgressReceipt: ObjectiveAuthority["recordProgressReceipt"]
}

export interface ObjectiveCapabilities {
  readonly read: ObjectiveReadPort
  readonly user: ObjectiveCommands<UserObjectiveMutation>
  readonly model: ObjectiveCommands<ModelObjectiveMutation>
  readonly continuation: ObjectiveCommands<ContinuationObjectiveMutation>
  readonly verifier: ObjectiveCommands<VerifierObjectiveMutation>
  readonly system: SystemObjectiveCommands
}

/** The read-only view of a port (no mutator is reachable through it). */
export const asObjectiveReadPort = (port: ObjectivePort): ObjectiveReadPort => {
  const authority = asObjectiveAuthority(port)
  return {
    get: (threadId) => authority.get(threadId),
    list: () => authority.list(),
    readDomain: (threadId) => authority.readDomain(threadId),
  }
}

const bind = <M extends ObjectiveMutation>(
  authority: ObjectiveAuthority,
  actor: "user" | "model" | "continuation" | "verifier" | "system",
): ObjectiveCommands<M> => ({
  actor,
  prepare(threadId, mutation, expectedRevision) {
    const prepared = authority.prepare({
      threadId,
      actor,
      mutation,
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    })
    return {
      approvalRequired: prepared.approvalRequired,
      expectedRevision: prepared.expectedRevision,
      commit: (approval) => authority.commit(prepared, approval),
    }
  },
  commit(threadId, mutation, options) {
    const prepared = authority.prepare({
      threadId,
      actor,
      mutation,
      ...(options?.expectedRevision !== undefined
        ? { expectedRevision: options.expectedRevision }
        : {}),
    })
    return authority.commit(prepared, options?.approval ?? { admitted: true })
  },
})

/** Mint the full capability set over a port (composition-root use only). */
export const createObjectiveCapabilities = (port: ObjectivePort): ObjectiveCapabilities => {
  const authority = asObjectiveAuthority(port)
  const system = bind<ObjectiveMutation>(authority, "system")
  return {
    read: asObjectiveReadPort(authority),
    user: bind<UserObjectiveMutation>(authority, "user"),
    model: bind<ModelObjectiveMutation>(authority, "model"),
    continuation: bind<ContinuationObjectiveMutation>(authority, "continuation"),
    verifier: bind<VerifierObjectiveMutation>(authority, "verifier"),
    system: {
      ...system,
      recordProgressReceipt: (threadId, receipt) =>
        authority.recordProgressReceipt(threadId, receipt),
    },
  }
}
