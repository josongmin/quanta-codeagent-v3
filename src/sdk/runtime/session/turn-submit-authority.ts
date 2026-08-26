import type { GoalContinuationProvenance } from "@/protocol/session"

export interface GoalContinuationCapabilityInput {
  readonly objectiveId: string
  readonly objectiveRevision: number
  readonly validateCurrent: () => boolean
  /** Default `goal-continuation` (autonomous). */
  readonly kind?: GoalContinuationProvenance["kind"] | undefined
}

export interface IssuedGoalContinuationCapability {
  readonly provenance: GoalContinuationProvenance
  revoke(): void
}

/** Session-local, one-use capability registry. It stores no objective state;
 * the supplied validation closure re-reads the owning authority at consume
 * time. Untrusted transports can replay the wire shape but cannot mint a live
 * random capability. */
export const createTurnSubmitAuthority = (): {
  issue(input: GoalContinuationCapabilityInput): IssuedGoalContinuationCapability
  consume(provenance: GoalContinuationProvenance): boolean
  clear(): void
} => {
  const issued = new Map<
    string,
    {
      readonly objectiveId: string
      readonly objectiveRevision: number
      readonly validateCurrent: () => boolean
    }
  >()
  return {
    issue: (input) => {
      const attemptId = crypto.randomUUID()
      issued.set(attemptId, input)
      return {
        provenance: {
          kind: input.kind ?? "goal-continuation",
          objectiveId: input.objectiveId,
          objectiveRevision: input.objectiveRevision,
          attemptId,
        },
        revoke: () => issued.delete(attemptId),
      }
    },
    consume: (provenance) => {
      const capability = issued.get(provenance.attemptId)
      if (capability === undefined) return false
      // Consume before invoking host code. A throwing or negative validator can
      // never leave a replayable token behind.
      issued.delete(provenance.attemptId)
      if (
        capability.objectiveId !== provenance.objectiveId ||
        capability.objectiveRevision !== provenance.objectiveRevision
      ) {
        return false
      }
      try {
        return capability.validateCurrent() === true
      } catch (_error) {
        return false
      }
    },
    clear: () => issued.clear(),
  }
}
