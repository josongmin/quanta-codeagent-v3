import { errMessage, logger } from "@/shared"
import type { BlockerDependencyTarget } from "./mutations"
import type { WaitingOn } from "./types"

export type BlockerDependencyResolution =
  | {
      readonly kind: "resolved"
      readonly dependencyId: string
      readonly occurrenceEvidenceId: string
    }
  | {
      readonly kind: "dependency-unresolved"
      readonly reason: "unsupported-kind" | "unknown" | "inactive" | "wrong-thread"
    }

export interface BlockerDependencyResolverPort {
  resolve(input: {
    readonly threadId: string
    readonly attemptId: string
    readonly waitingOn: WaitingOn
    readonly target: BlockerDependencyTarget
  }): BlockerDependencyResolution
}

const unresolved = (
  reason: Extract<BlockerDependencyResolution, { kind: "dependency-unresolved" }>["reason"],
): BlockerDependencyResolution => ({
  kind: "dependency-unresolved",
  reason,
})

const boundedIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512

/** Authority-side no-throw and shape fence around a host resolver. */
export const resolveBlockerDependency = (
  resolver: BlockerDependencyResolverPort | undefined,
  input: Parameters<BlockerDependencyResolverPort["resolve"]>[0],
): BlockerDependencyResolution => {
  if (resolver === undefined) return unresolved("unsupported-kind")
  try {
    const result = resolver.resolve(input)
    if (result.kind !== "resolved") return unresolved(result.reason)
    return boundedIdentity(result.dependencyId) && boundedIdentity(result.occurrenceEvidenceId)
      ? result
      : unresolved("unknown")
  } catch (error) {
    logger.warn(`objective.blocker-dependency.resolve: ${errMessage(error)}`)
    return unresolved("unknown")
  }
}
